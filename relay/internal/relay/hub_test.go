package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func devKey(t *testing.T) (priv [32]byte, hash string) {
	priv, pub := keyPair(t)
	return priv, DeviceHash(pub)
}

func TestHostAdmitted(t *testing.T) {
	s, url := newTestServer(t, DefaultOptions())
	priv, _ := keyPair(t)
	dialHost(t, url, priv, nil, nil)
	if h, d := s.Stats(); h != 1 || d != 0 {
		t.Fatalf("stats %d %d", h, d)
	}
}

func TestBadProof(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	_, pub := keyPair(t)
	other, _ := keyPair(t)
	r := dialRaw(t, url+"/v1/host")
	r.hello("host", other, pub, map[string]any{"devices": []string{}})
	if c := closeCode(t, r.c); c != 4401 {
		t.Fatalf("wrong proof: %d", c)
	}
	r = dialRaw(t, url+"/v1/host")
	if err := r.c.Write(testCtx(t), websocket.MessageText, []byte("not json")); err != nil {
		t.Fatal(err)
	}
	if c := closeCode(t, r.c); c != 4400 {
		t.Fatalf("not json: %d", c)
	}
	r = dialRaw(t, url+"/v1/device?host=x")
	r.sendJSON(map[string]any{"t": "hello", "proof": "AA"})
	if c := closeCode(t, r.c); c != 4400 {
		t.Fatalf("no key: %d", c)
	}
}

func TestDeviceHostOffline(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	hpriv, hpub := keyPair(t)
	_ = hpriv
	dpriv, _ := keyPair(t)
	_, err := dialDevice(t, url, HostID(hpub), dpriv, nil)
	if websocket.CloseStatus(err) != 4404 {
		t.Fatalf("got %v", err)
	}
}

func TestDeviceAdmittedByList(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	hpriv, _ := keyPair(t)
	dpriv, dhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{dhash}, nil)
	d, err := dialDevice(t, url, h.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	conn, hash := h.nextOpen()
	if conn != d.conn || hash != dhash || conn == 0 {
		t.Fatalf("open %d %s, device conn %d", conn, hash, d.conn)
	}
	// A stranger is refused and the host hears nothing.
	spriv, _ := devKey(t)
	if _, err := dialDevice(t, url, h.id, spriv, nil); websocket.CloseStatus(err) != 4403 {
		t.Fatalf("stranger: %v", err)
	}
	h.sendJSON(map[string]any{"t": "close", "conn": d.conn})
	h.expectGone(d.conn) // the next message is the kick's gone, not an open
}

func TestDeviceAdmittedByTicket(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	hpriv, _ := keyPair(t)
	dpriv, dhash := devKey(t)
	ticket := bytes.Repeat([]byte{7}, 32)
	h := dialHost(t, url, hpriv, nil, ticket)
	if _, err := dialDevice(t, url, h.id, dpriv, bytes.Repeat([]byte{8}, 32)); websocket.CloseStatus(err) != 4403 {
		t.Fatalf("wrong ticket: %v", err)
	}
	d, err := dialDevice(t, url, h.id, dpriv, ticket)
	if err != nil {
		t.Fatal(err)
	}
	conn, hash := h.nextOpen()
	if conn != d.conn || hash != dhash {
		t.Fatalf("open %d %s", conn, hash)
	}
}

func TestRouting(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	hpriv, _ := keyPair(t)
	apriv, ahash := devKey(t)
	bpriv, bhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{ahash, bhash}, nil)
	a, err := dialDevice(t, url, h.id, apriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.nextOpen()
	b, err := dialDevice(t, url, h.id, bpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.nextOpen()
	if a.conn == b.conn {
		t.Fatal("conn numbers collide")
	}
	a.sendBinary(1, 2, 3)
	typ, got := h.next()
	want := []byte{byte(a.conn >> 24), byte(a.conn >> 16), byte(a.conn >> 8), byte(a.conn), 1, 2, 3}
	if typ != websocket.MessageBinary || !bytes.Equal(got, want) {
		t.Fatalf("host got %v %v, want %v", typ, got, want)
	}
	h.sendBinary(99, 5) // unknown conn: dropped, host stays
	h.sendBinary(b.conn, 9)
	if got := b.nextBinary(); !bytes.Equal(got, []byte{9}) {
		t.Fatalf("b got %v", got)
	}
	// a received nothing: the next frame it sees is the one sent after.
	h.sendBinary(a.conn, 4)
	if got := a.nextBinary(); !bytes.Equal(got, []byte{4}) {
		t.Fatalf("a got %v", got)
	}
}

func TestDeviceGone(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	hpriv, _ := keyPair(t)
	dpriv, dhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{dhash}, nil)
	d, err := dialDevice(t, url, h.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.nextOpen()
	d.c.Close(websocket.StatusNormalClosure, "")
	h.expectGone(d.conn)
}

func TestDevicesUpdateKicksRemoved(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	hpriv, _ := keyPair(t)
	apriv, ahash := devKey(t)
	bpriv, bhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{ahash, bhash}, nil)
	a, _ := dialDevice(t, url, h.id, apriv, nil)
	h.nextOpen()
	b, _ := dialDevice(t, url, h.id, bpriv, nil)
	h.nextOpen()
	h.sendJSON(map[string]any{"t": "devices", "devices": []string{bhash}})
	if c := closeCode(t, a.c); c != 4403 {
		t.Fatalf("a closed %d", c)
	}
	h.expectGone(a.conn)
	h.sendBinary(b.conn, 1)
	if got := b.nextBinary(); !bytes.Equal(got, []byte{1}) {
		t.Fatalf("b got %v", got)
	}
}

func TestTicketCleared(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	hpriv, _ := keyPair(t)
	dpriv, _ := devKey(t)
	ticket := bytes.Repeat([]byte{7}, 32)
	h := dialHost(t, url, hpriv, nil, ticket)
	d, err := dialDevice(t, url, h.id, dpriv, ticket)
	if err != nil {
		t.Fatal(err)
	}
	h.nextOpen()
	h.sendJSON(map[string]any{"t": "ticket", "ticket": nil})
	late, _ := keyPair(t)
	// Ordering on the host connection is not visible to other connections, so
	// retry until the clear has been applied: the refusal is the proof.
	var err2 error
	eventually(t, "ticket cleared", func() bool {
		_, err2 = dialDevice(t, url, h.id, late, ticket)
		return err2 != nil
	})
	if websocket.CloseStatus(err2) != 4403 {
		t.Fatalf("got %v", err2)
	}
	// The admitted one stays until a devices update omits it.
	h.sendBinary(d.conn, 1)
	if got := d.nextBinary(); !bytes.Equal(got, []byte{1}) {
		t.Fatalf("got %v", got)
	}
	h.sendJSON(map[string]any{"t": "devices", "devices": []string{}})
	if c := closeCode(t, d.c); c != 4403 {
		t.Fatalf("closed %d", c)
	}
}

func TestHostCloseKick(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	hpriv, _ := keyPair(t)
	dpriv, dhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{dhash}, nil)
	d, _ := dialDevice(t, url, h.id, dpriv, nil)
	h.nextOpen()
	h.sendJSON(map[string]any{"t": "close", "conn": d.conn})
	if c := closeCode(t, d.c); c != 4403 {
		t.Fatalf("closed %d", c)
	}
}

func TestHostReplaceClosesOldDevices(t *testing.T) {
	s, url := newTestServer(t, DefaultOptions())
	hpriv, _ := keyPair(t)
	apriv, ahash := devKey(t)
	bpriv, bhash := devKey(t)
	h1 := dialHost(t, url, hpriv, []string{ahash, bhash}, nil)
	a, _ := dialDevice(t, url, h1.id, apriv, nil)
	h1.nextOpen()
	h2 := dialHost(t, url, hpriv, []string{ahash, bhash}, nil)
	if c := closeCode(t, h1.c); c != 4409 {
		t.Fatalf("old host closed %d", c)
	}
	if c := closeCode(t, a.c); c != 4404 {
		t.Fatalf("old device closed %d", c)
	}
	b, err := dialDevice(t, url, h2.id, bpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	conn, hash := h2.nextOpen()
	if conn != b.conn || hash != bhash {
		t.Fatalf("open %d %s", conn, hash)
	}
	if h, d := s.Stats(); h != 1 || d != 1 {
		t.Fatalf("stats %d %d", h, d)
	}
}

func TestAdmitHook(t *testing.T) {
	o := DefaultOptions()
	badPriv, badPub := keyPair(t)
	bad := HostID(badPub)
	o.Admit = func(id string) bool { return id != bad }
	s, url := newTestServer(t, o)
	h := dialHostNoWait(t, url, badPriv, nil, nil)
	if c := closeCode(t, h.c); c != 4403 {
		t.Fatalf("refused host closed %d", c)
	}
	if hs, _ := s.Stats(); hs != 0 {
		t.Fatalf("hosts %d", hs)
	}
	okPriv, _ := keyPair(t)
	dialHost(t, url, okPriv, nil, nil)
	if hs, _ := s.Stats(); hs != 1 {
		t.Fatalf("hosts %d", hs)
	}
}

func TestDeviceSeveralHosts(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	dpriv, dhash := devKey(t)
	h1priv, _ := keyPair(t)
	h2priv, _ := keyPair(t)
	h1 := dialHost(t, url, h1priv, []string{dhash}, nil)
	h2 := dialHost(t, url, h2priv, []string{dhash}, nil)
	d1, err := dialDevice(t, url, h1.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	d2, err := dialDevice(t, url, h2.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	h1.nextOpen()
	h2.nextOpen()
	d1.sendBinary(1)
	d2.sendBinary(2)
	if _, got := h1.next(); got[len(got)-1] != 1 {
		t.Fatalf("h1 got %v", got)
	}
	if _, got := h2.next(); got[len(got)-1] != 2 {
		t.Fatalf("h2 got %v", got)
	}
	h2.sendBinary(d2.conn, 8)
	if got := d2.nextBinary(); !bytes.Equal(got, []byte{8}) {
		t.Fatalf("d2 got %v", got)
	}
}

func TestHostLeaves(t *testing.T) {
	s, url := newTestServer(t, DefaultOptions())
	hpriv, _ := keyPair(t)
	apriv, ahash := devKey(t)
	bpriv, bhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{ahash, bhash}, nil)
	a, _ := dialDevice(t, url, h.id, apriv, nil)
	h.nextOpen()
	b, _ := dialDevice(t, url, h.id, bpriv, nil)
	h.nextOpen()
	h.c.Close(websocket.StatusNormalClosure, "")
	if c := closeCode(t, a.c); c != 4404 {
		t.Fatalf("a closed %d", c)
	}
	if c := closeCode(t, b.c); c != 4404 {
		t.Fatalf("b closed %d", c)
	}
	if hs, ds := s.Stats(); hs != 0 || ds != 0 {
		t.Fatalf("stats %d %d", hs, ds)
	}
}

func TestHelloTimeout(t *testing.T) {
	o := DefaultOptions()
	o.HelloTimeout = 200 * time.Millisecond
	_, url := newTestServer(t, o)
	r := dialRaw(t, url+"/v1/host")
	if c := closeCode(t, r.c); c != 4400 {
		t.Fatalf("silent client closed %d", c)
	}
}

// A frame from a device the host was already told is gone must not reach it.
func TestRouteAfterGone(t *testing.T) {
	noLog := func(string, websocket.StatusCode) {}
	hp := newPeer(nil, "host", noLog, 1<<20)
	h := newHost("h", hp, []string{"d"}, nil, time.Second)
	dp := newPeer(nil, "device", noLog, 1<<20)
	dp.once.Do(func() {}) // no socket in this test: make closeWith a no-op
	d, code := h.admit(dp, "d", nil, 0)
	if d == nil {
		t.Fatalf("refused %d", code)
	}
	h.route(d, []byte{1}) // before the kick: forwarded
	h.updateDevices(nil)  // kick: host is told gone
	h.route(d, []byte{2}) // in-flight frame after the kick: dropped
	h.shutdown()
	h.route(d, []byte{3})
	var kinds []string
	hp.q.close() // pop reports closed once drained below
	for _, m := range hp.q.items {
		if m.typ == websocket.MessageBinary {
			kinds = append(kinds, "bin")
		} else {
			var v struct{ T string }
			json.Unmarshal(m.data, &v)
			kinds = append(kinds, v.T)
		}
	}
	if got := strings.Join(kinds, ","); got != "open,bin,gone" {
		t.Fatalf("host queue: %s", got)
	}
}

func smallOptions() Options {
	o := DefaultOptions()
	o.QueueBytes = 64 << 10
	o.SlowTimeout = 300 * time.Millisecond
	return o
}

func TestSlowDeviceCut(t *testing.T) {
	_, url := newTestServer(t, smallOptions())
	hpriv, _ := keyPair(t)
	apriv, ahash := devKey(t)
	bpriv, bhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{ahash, bhash}, nil)
	a, err := dialDevice(t, url, h.id, apriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.nextOpen()
	b, err := dialDevice(t, url, h.id, bpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.nextOpen()

	gone := make(chan struct{})
	go func() { // host reader: waits for gone(A)
		for {
			typ, data, err := h.c.Read(context.Background())
			if err != nil {
				return
			}
			var m struct {
				T    string `json:"t"`
				Conn uint32 `json:"conn"`
			}
			if typ == websocket.MessageText && json.Unmarshal(data, &m) == nil && m.T == "gone" && m.Conn == a.conn {
				close(gone)
				return
			}
		}
	}()
	var got atomic.Int64
	go func() { // B reads everything
		for {
			if _, _, err := b.c.Read(context.Background()); err != nil {
				return
			}
			got.Add(1)
		}
	}()

	sent := 0
	deadline := time.Now().Add(testWait)
loop:
	for {
		select {
		case <-gone:
			break loop
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("slow device was never cut")
		}
		ctx := testCtx(t)
		for _, conn := range []uint32{a.conn, b.conn} {
			buf := append([]byte{byte(conn >> 24), byte(conn >> 16), byte(conn >> 8), byte(conn)}, make([]byte, 16<<10)...)
			if err := h.c.Write(ctx, websocket.MessageBinary, buf); err != nil {
				t.Fatal(err)
			}
		}
		sent++
	}
	eventually(t, "B to receive every frame", func() bool { return got.Load() == int64(sent) })
	if c := closeCode(t, a.c); c != 4408 {
		t.Fatalf("slow device closed %d", c)
	}
}

func TestDeviceBackpressure(t *testing.T) {
	_, url := newTestServer(t, smallOptions())
	hpriv, _ := keyPair(t)
	dpriv, dhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{dhash}, nil)
	_ = h // never reads again
	d, err := dialDevice(t, url, h.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	const maxFrames = 6000 // 16 KiB each: far beyond socket buffers plus the queue
	var done atomic.Int64
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for i := 0; i < maxFrames; i++ {
			if err := d.c.Write(context.Background(), websocket.MessageBinary, make([]byte, 16<<10)); err != nil {
				return
			}
			done.Add(1)
		}
	}()
	// Blocked = the counter stays put for 200 ms while the sender is not done.
	last, still := int64(-1), 0
	deadline := time.Now().Add(testWait)
	for still < 4 {
		if time.Now().After(deadline) {
			t.Fatalf("sender never blocked (%d frames)", done.Load())
		}
		select {
		case <-finished:
			t.Fatalf("all %d frames went through a host that reads nothing", maxFrames)
		case <-time.After(50 * time.Millisecond):
		}
		if n := done.Load(); n == last && n > 0 {
			still++
		} else {
			still, last = 0, n
		}
	}
	d.c.CloseNow()
	<-finished
}

func TestTooLarge(t *testing.T) {
	o := smallOptions()
	o.MaxMessage = 1024
	_, url := newTestServer(t, o)
	hpriv, _ := keyPair(t)
	dpriv, dhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{dhash}, nil)
	d, err := dialDevice(t, url, h.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.nextOpen()
	d.sendBinary(make([]byte, 1024)...) // exactly the limit passes
	if _, data := h.next(); len(data) != 1028 {
		t.Fatalf("host got %d bytes", len(data))
	}
	d.sendBinary(make([]byte, 1025)...)
	if c := closeCode(t, d.c); c != 4413 {
		t.Fatalf("oversize device frame closed %d", c)
	}
	h2priv, _ := keyPair(t)
	h2 := dialHost(t, url, h2priv, nil, nil)
	if err := h2.c.Write(testCtx(t), websocket.MessageBinary, make([]byte, 1029)); err != nil {
		t.Fatal(err)
	}
	if c := closeCode(t, h2.c); c != 4413 {
		t.Fatalf("oversize host frame closed %d", c)
	}
}

func TestLimits(t *testing.T) {
	o := DefaultOptions()
	o.MaxHosts, o.MaxDevicesPerHost = 1, 1
	_, url := newTestServer(t, o)
	hpriv, _ := keyPair(t)
	h := dialHost(t, url, hpriv, nil, nil)
	h2priv, _ := keyPair(t)
	h2 := dialHostNoWait(t, url, h2priv, nil, nil)
	if c := closeCode(t, h2.c); c != 4429 {
		t.Fatalf("second host closed %d", c)
	}
	// The same host id reconnecting replaces, it does not count twice.
	dialHost(t, url, hpriv, nil, nil)
	_ = h
	a, ahash := devKey(t)
	b, bhash := devKey(t)
	h3 := dialHost(t, url, hpriv, []string{ahash, bhash}, nil)
	if _, err := dialDevice(t, url, h3.id, a, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := dialDevice(t, url, h3.id, b, nil); websocket.CloseStatus(err) != 4429 {
		t.Fatalf("second device: %v", err)
	}
}

func TestPendingLimit(t *testing.T) {
	o := DefaultOptions()
	o.MaxPending = 1
	_, url := newTestServer(t, o)
	first := dialRaw(t, url+"/v1/host") // sits in the challenge
	_ = first
	_, resp, err := websocket.Dial(testCtx(t), url+"/v1/host", nil)
	if err == nil || resp == nil || resp.StatusCode != 503 {
		t.Fatalf("over the pending limit: %v %v", resp, err)
	}
	// Once the first one answers, a slot is free again.
	priv, pub := keyPair(t)
	first.hello("host", priv, pub, map[string]any{"devices": []string{}})
	if _, data, err := first.c.Read(testCtx(t)); err != nil || !strings.Contains(string(data), "ok") {
		t.Fatalf("%s %v", data, err)
	}
	dialHost(t, url, mustKey(t), nil, nil)
}

func mustKey(t *testing.T) [32]byte {
	priv, _ := keyPair(t)
	return priv
}

func TestPongTimeout(t *testing.T) {
	o := DefaultOptions()
	o.PingInterval, o.PongTimeout = 50*time.Millisecond, 150*time.Millisecond
	_, url := newTestServer(t, o)
	pr, _ := keyPair(t)
	idle := dialHost(t, url, pr, nil, nil)
	pr2, _ := keyPair(t)
	live := dialHost(t, url, pr2, nil, nil)

	// The live client keeps reading, which answers pings.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_, _, err := live.c.Read(ctx)
	if websocket.CloseStatus(err) != -1 || ctx.Err() == nil {
		t.Fatalf("normal client dropped: %v", err)
	}
	// The idle one did not read, so it never answered: now it learns why.
	if c := closeCode(t, idle.c); c != 4408 {
		t.Fatalf("unanswered pings closed %d", c)
	}
}
