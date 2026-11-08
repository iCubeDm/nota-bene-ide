package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	o.Admit = func(_ context.Context, id string) bool { return id != bad }
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
	hp := newPeer(nil, "host", noLog, 1<<20, nil)
	h := newHost("h", hp, []string{"d"}, nil, time.Second)
	dp := newPeer(nil, "device", noLog, 1<<20, nil)
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
	o := smallOptions()
	s, url := newTestServer(t, o)
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
	// The host's queue is full in charged bytes: within the limit, and with no
	// room for one more frame of the size it holds.
	b, n := s.lookup(h.id).p.q.queued()
	if n == 0 || b > o.QueueBytes || b+b/n <= o.QueueBytes || b/n < 16<<10+4+itemOverhead {
		t.Fatalf("host queue holds %d bytes in %d frames (limit %d)", b, n, o.QueueBytes)
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

// A device that leaves while its queue is full must not park the host's
// reader for the slow timeout.
func TestDeviceLeavesWhileFull(t *testing.T) {
	o := smallOptions()
	o.SlowTimeout = 3 * time.Second
	_, url := newTestServer(t, o)
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

	var stop atomic.Bool
	var sent atomic.Int64
	writerDone := make(chan struct{})
	go func() { // fills A until the relay stops reading the host
		defer close(writerDone)
		buf := append([]byte{byte(a.conn >> 24), byte(a.conn >> 16), byte(a.conn >> 8), byte(a.conn)}, make([]byte, 16<<10)...)
		for !stop.Load() {
			if err := h.c.Write(context.Background(), websocket.MessageBinary, buf); err != nil {
				return
			}
			sent.Add(1)
		}
	}()
	last, still := int64(-1), 0
	deadline := time.Now().Add(testWait)
	for still < 4 {
		if time.Now().After(deadline) {
			t.Fatal("host reader never parked on the full device")
		}
		time.Sleep(50 * time.Millisecond)
		if n := sent.Load(); n == last && n > 0 {
			still++
		} else {
			still, last = 0, n
		}
	}
	a.c.CloseNow()
	stop.Store(true)
	start := time.Now()
	select {
	case <-writerDone:
	case <-time.After(time.Second):
		t.Fatal("host reader stayed parked after the device left")
	}
	h.sendBinary(b.conn, 7)
	if got := b.nextBinary(); len(got) != 1 || got[0] != 7 {
		t.Fatalf("B got %v", got)
	}
	if time.Since(start) > o.SlowTimeout/2 {
		t.Fatalf("B waited %v", time.Since(start))
	}
}

// A device that drains a little at a time is as stuck as one that drains
// nothing: it is cut once its queue has stayed full for SlowTimeout.
func TestSteadySlowDeviceCut(t *testing.T) {
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
	go func() {
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
	go func() {
		for {
			if _, _, err := b.c.Read(context.Background()); err != nil {
				return
			}
			got.Add(1)
		}
	}()
	var stopA atomic.Bool
	aDone := make(chan struct{})
	go func() { // one 16 KiB frame per 40 ms: always behind, never idle
		defer close(aDone)
		for !stopA.Load() {
			if _, _, err := a.c.Read(context.Background()); err != nil {
				return
			}
			time.Sleep(40 * time.Millisecond)
		}
	}()

	sent := 0
	wctx := testCtx(t)
	deadline := time.Now().Add(testWait)
loop:
	for {
		select {
		case <-gone:
			break loop
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("steadily slow device was never cut (sent %d)", sent)
		}
		for _, conn := range []uint32{a.conn, b.conn} {
			buf := append([]byte{byte(conn >> 24), byte(conn >> 16), byte(conn >> 8), byte(conn)}, make([]byte, 16<<10)...)
			if err := h.c.Write(wctx, websocket.MessageBinary, buf); err != nil {
				t.Fatal(err)
			}
		}
		sent++
	}
	eventually(t, "B to receive every frame", func() bool { return got.Load() == int64(sent) })
	stopA.Store(true)
	<-aDone
	if c := closeCode(t, a.c); c != 4408 {
		t.Fatalf("slow device closed %d", c)
	}
}

// A ping that fails while the reader is parked in backpressure is not a dead
// peer.
func TestKeepaliveIgnoresStall(t *testing.T) {
	peers := make(chan *peer, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		p := newPeer(c, "device", func(string, websocket.StatusCode) {}, 1<<10, nil)
		peers <- p
		end := p.stall()
		p.keepalive(r.Context(), 20*time.Millisecond, 60*time.Millisecond)
		end()
		c.CloseNow()
	}))
	defer ts.Close()
	c, _, err := websocket.Dial(testCtx(t), "ws"+strings.TrimPrefix(ts.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	p := <-peers // the client never reads, so no ping is ever answered
	select {
	case <-p.done:
		t.Fatal("peer closed while its reader was parked")
	case <-time.After(400 * time.Millisecond):
	}
	// Once the stall ends the same silence is a real failure.
	p.inStall.Add(-1)
	select {
	case <-p.done:
	case <-time.After(testWait):
		t.Fatal("silent peer never closed")
	}
}

// A device whose reader is parked behind a stalled host is not closed 4408.
func TestStalledHostDoesNotKillDevice(t *testing.T) {
	o := smallOptions()
	o.PingInterval, o.PongTimeout = 50*time.Millisecond, 200*time.Millisecond
	_, url := newTestServer(t, o)
	hpriv, _ := keyPair(t)
	dpriv, dhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{dhash}, nil)
	d, err := dialDevice(t, url, h.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = h // stalled: reads nothing
	go func() {
		for {
			if err := d.c.Write(context.Background(), websocket.MessageBinary, make([]byte, 16<<10)); err != nil {
				return
			}
		}
	}()
	// The device may see the host's death (4404) but never a keepalive cut.
	if c := closeCode(t, d.c); c == 4408 {
		t.Fatalf("device closed %d", c)
	}
}

// Empty and one-byte host frames to a device that reads nothing are charged
// like any other: the device's queue stays within its limit and the device is
// still cut with 4408 once it has stayed full.
func TestTinyFramesBounded(t *testing.T) {
	const limit = 64 << 10
	noLog := func(string, websocket.StatusCode) {}
	hp := newPeer(nil, "host", noLog, limit, nil)
	h := newHost("h", hp, []string{"d"}, nil, 200*time.Millisecond)
	dp := newPeer(nil, "device", noLog, limit, nil)
	dp.once.Do(func() {}) // no socket: make closeWith a no-op
	d, code := h.admit(dp, "d", nil, 0)
	if d == nil {
		t.Fatalf("refused %d", code)
	}
	deadline := time.Now().Add(testWait)
	frames := 0
	for !d.gone.Load() {
		if time.Now().After(deadline) {
			t.Fatalf("device never cut after %d tiny frames", frames)
		}
		payload := make([]byte, frames%2) // empty, then one byte
		h.deliver(d.conn, payload)
		frames++
		if b, _ := dp.q.queued(); b > limit {
			t.Fatalf("device queue holds %d charged bytes, limit %d", b, limit)
		}
	}
	if _, n := dp.q.queued(); n == 0 || n > limit/itemOverhead {
		t.Fatalf("device queue holds %d frames", n)
	}
	// The host was told: open, then gone for the cut device.
	var kinds []string
	for _, m := range hp.q.items {
		var v struct{ T string }
		json.Unmarshal(m.data, &v)
		kinds = append(kinds, v.T)
	}
	if got := strings.Join(kinds, ","); got != "open,gone" {
		t.Fatalf("host queue: %s", got)
	}
}

// Over the hub-wide budget, a sender waits even though its target's own
// queue has room, and new connections are refused 4429; once the data
// drains, connections are admitted again.
func TestTotalBudget(t *testing.T) {
	o := smallOptions()
	o.QueueBytes = 1 << 20
	o.TotalBytes = 128 << 10
	o.SlowTimeout = time.Minute
	s, url := newTestServer(t, o)
	hpriv, _ := keyPair(t)
	dpriv, dhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{dhash}, nil) // reads nothing for now
	d, err := dialDevice(t, url, h.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	var sent atomic.Int64
	senderDone := make(chan struct{})
	go func() {
		defer close(senderDone)
		for i := 0; i < 6000; i++ {
			if err := d.c.Write(context.Background(), websocket.MessageBinary, make([]byte, 16<<10)); err != nil {
				return
			}
			sent.Add(1)
		}
	}()
	last, still := int64(-1), 0
	deadline := time.Now().Add(testWait)
	for still < 4 {
		if time.Now().After(deadline) {
			t.Fatal("sender never blocked on the budget")
		}
		select {
		case <-senderDone:
			t.Fatal("every frame went through")
		case <-time.After(50 * time.Millisecond):
		}
		if n := sent.Load(); n == last && n > 0 {
			still++
		} else {
			still, last = 0, n
		}
	}
	frame := cost(make([]byte, 0, 20<<10)) // a 16 KiB frame, rounded up generously
	if used := s.budget.inUse(); used <= o.TotalBytes || used > o.TotalBytes+frame {
		t.Fatalf("budget in use %d, limit %d", used, o.TotalBytes)
	}
	if b, _ := s.lookup(h.id).p.q.queued(); b+frame > o.QueueBytes/2 {
		t.Fatalf("the host's own queue (%d bytes) is what stopped the sender", b)
	}
	h2priv, _ := keyPair(t)
	if c := closeCode(t, dialHostNoWait(t, url, h2priv, nil, nil).c); c != 4429 {
		t.Fatalf("host admitted over the budget: %d", c)
	}
	d2priv, _ := keyPair(t)
	r := dialRaw(t, url+"/v1/device?host="+h.id)
	r.hello("device", d2priv, pubOf(t, d2priv), nil)
	if c := closeCode(t, r.c); c != 4429 {
		t.Fatalf("device admitted over the budget: %d", c)
	}

	d.c.CloseNow()
	<-senderDone
	go func() { // now the host drains
		for {
			if _, _, err := h.c.Read(context.Background()); err != nil {
				return
			}
		}
	}()
	eventually(t, "the budget to drain", func() bool { over, _ := s.budget.over(); return !over })
	dialHost(t, url, h2priv, nil, nil)
	s.Close() // every byte charged is released once the connections are gone
	if used := s.budget.inUse(); used != 0 {
		t.Fatalf("budget leaks %d bytes", used)
	}
}

// A host that keeps sending but never reads answers no ping; sending is not a
// backpressure stall, so keepalive closes it with 4408.
func TestKeepaliveCutsSenderThatNeverReads(t *testing.T) {
	o := DefaultOptions()
	o.PingInterval, o.PongTimeout = 50*time.Millisecond, 150*time.Millisecond
	s, url := newTestServer(t, o)
	hpriv, _ := keyPair(t)
	dpriv, dhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{dhash}, nil)
	d, err := dialDevice(t, url, h.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	devClosed := make(chan websocket.StatusCode, 1)
	go func() { // the device reads everything, so the host never waits
		for {
			if _, _, err := d.c.Read(context.Background()); err != nil {
				devClosed <- websocket.CloseStatus(err)
				return
			}
		}
	}()
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
			}
			b := []byte{byte(d.conn >> 24), byte(d.conn >> 16), byte(d.conn >> 8), byte(d.conn), 1}
			if h.c.Write(context.Background(), websocket.MessageBinary, b) != nil {
				return
			}
		}
	}()
	total := map[CloseKey]int{}
	eventually(t, "keepalive to close the host", func() bool {
		for k, n := range s.TakeCloses() {
			total[k] += n
		}
		return total[CloseKey{"host", 4408}] == 1
	})
	select {
	case c := <-devClosed:
		if c != 4404 {
			t.Fatalf("device closed %d", c)
		}
	case <-time.After(2 * testWait): // the close handshake with a host that never reads takes up to 5 s
		t.Fatal("device never told its host left")
	}
}

// A newer connection of the same device replaces the older one.
func TestDeviceReplaced(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	hpriv, _ := keyPair(t)
	dpriv, dhash := devKey(t)
	h := dialHost(t, url, hpriv, []string{dhash}, nil)
	d1, err := dialDevice(t, url, h.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	if conn, hash := h.nextOpen(); conn != d1.conn || hash != dhash {
		t.Fatalf("open %d %s", conn, hash)
	}
	d2, err := dialDevice(t, url, h.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.expectGone(d1.conn)
	if conn, _ := h.nextOpen(); conn != d2.conn || conn == d1.conn {
		t.Fatalf("open %d after replacing %d", conn, d1.conn)
	}
	if c := closeCode(t, d1.c); c != 4409 {
		t.Fatalf("replaced device closed %d", c)
	}
	d2.sendBinary(5)
	if _, got := h.next(); len(got) != 5 || got[4] != 5 {
		t.Fatalf("host got %v", got)
	}
}

// Device hashes in a hello or a devices message must be 43 base64url
// characters decoding to 32 bytes.
func TestDeviceHashValidated(t *testing.T) {
	_, url := newTestServer(t, DefaultOptions())
	_, good := devKey(t)
	for _, bad := range []string{"x", good + "\n", good[:42], good[:42] + "+"} {
		h := dialHostNoWait(t, url, mustKey(t), []string{good, bad}, nil)
		if c := closeCode(t, h.c); c != 4400 {
			t.Errorf("hello with %q closed %d", bad, c)
		}
	}
	h := dialHost(t, url, mustKey(t), []string{good}, nil)
	h.sendJSON(map[string]any{"t": "devices", "devices": []string{good, good + "\r\n"}})
	if c := closeCode(t, h.c); c != 4400 {
		t.Fatalf("devices with a bad hash closed %d", c)
	}
}

// PingInterval <= 0 disables keepalive instead of panicking.
func TestKeepaliveDisabled(t *testing.T) {
	o := DefaultOptions()
	o.PingInterval = 0
	_, url := newTestServer(t, o)
	dpriv, dhash := devKey(t)
	h := dialHost(t, url, mustKey(t), []string{dhash}, nil)
	d, err := dialDevice(t, url, h.id, dpriv, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.nextOpen()
	h.sendBinary(d.conn, 3)
	if got := d.nextBinary(); !bytes.Equal(got, []byte{3}) {
		t.Fatalf("device got %v", got)
	}
}

// The admission hook's context ends at the hello deadline.
func TestAdmitContext(t *testing.T) {
	o := DefaultOptions()
	o.HelloTimeout = 300 * time.Millisecond
	o.Admit = func(ctx context.Context, _ string) bool {
		<-ctx.Done()
		return false
	}
	_, url := newTestServer(t, o)
	start := time.Now()
	h := dialHostNoWait(t, url, mustKey(t), nil, nil)
	if c := closeCode(t, h.c); c != 4403 {
		t.Fatalf("host closed %d", c)
	}
	if time.Since(start) > testWait/2 {
		t.Fatalf("hook ran %v", time.Since(start))
	}
}
