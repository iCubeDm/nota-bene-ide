package relay

import (
	"bytes"
	"testing"

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
