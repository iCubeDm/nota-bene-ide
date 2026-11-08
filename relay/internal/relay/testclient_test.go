package relay

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/curve25519"
)

const testWait = 5 * time.Second

func testCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testWait)
	t.Cleanup(cancel)
	return ctx
}

func newTestServer(t *testing.T, o Options) (*Server, string) {
	t.Helper()
	s := NewServer(o)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { ts.Close(); s.Close() })
	return s, "ws" + strings.TrimPrefix(ts.URL, "http")
}

// rawConn is a connection that has received the challenge but not answered.
type rawConn struct {
	t     *testing.T
	c     *websocket.Conn
	eph   [32]byte
	nonce [32]byte
}

func dialRaw(t *testing.T, url string) *rawConn {
	t.Helper()
	c, _, err := websocket.Dial(testCtx(t), url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	r := &rawConn{t: t, c: c}
	var m struct {
		T     string `json:"t"`
		Eph   string `json:"eph"`
		Nonce string `json:"nonce"`
	}
	typ, data, err := c.Read(testCtx(t))
	if err != nil || typ != websocket.MessageText {
		t.Fatalf("challenge: %v %v", typ, err)
	}
	if err := json.Unmarshal(data, &m); err != nil || m.T != "challenge" {
		t.Fatalf("challenge: %s %v", data, err)
	}
	if r.eph, err = decodeKey(m.Eph); err != nil {
		t.Fatal(err)
	}
	if r.nonce, err = decodeKey(m.Nonce); err != nil {
		t.Fatal(err)
	}
	return r
}

func (r *rawConn) sendJSON(v any) {
	r.t.Helper()
	b, _ := json.Marshal(v)
	if err := r.c.Write(testCtx(r.t), websocket.MessageText, b); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rawConn) hello(role string, priv, pub [32]byte, extra map[string]any) {
	r.t.Helper()
	m := map[string]any{
		"t":     "hello",
		"key":   b64.EncodeToString(pub[:]),
		"proof": b64.EncodeToString(Proof(role, priv, r.eph, r.nonce)),
	}
	for k, v := range extra {
		m[k] = v
	}
	r.sendJSON(m)
}

// closeCode reads until the connection fails and returns its close status.
func closeCode(t *testing.T, c *websocket.Conn) websocket.StatusCode {
	t.Helper()
	for {
		_, _, err := c.Read(testCtx(t))
		if err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

type testHost struct {
	t    *testing.T
	c    *websocket.Conn
	priv [32]byte
	pub  [32]byte
	id   string
}

func ticketB64(ticket []byte) any {
	if ticket == nil {
		return nil
	}
	return b64.EncodeToString(ticket)
}

// dialHost connects, answers the challenge and waits for {"t":"ok"}.
func dialHost(t *testing.T, url string, priv [32]byte, devices []string, ticket []byte) *testHost {
	t.Helper()
	h := dialHostNoWait(t, url, priv, devices, ticket)
	m := h.nextJSON()
	if m["t"] != "ok" {
		t.Fatalf("host hello answered %v", m)
	}
	return h
}

func dialHostNoWait(t *testing.T, url string, priv [32]byte, devices []string, ticket []byte) *testHost {
	t.Helper()
	r := dialRaw(t, url+"/v1/host")
	pub := pubOf(t, priv)
	if devices == nil {
		devices = []string{}
	}
	extra := map[string]any{"devices": devices}
	if ticket != nil {
		extra["ticket"] = ticketB64(ticket)
	}
	r.hello("host", priv, pub, extra)
	return &testHost{t: t, c: r.c, priv: priv, pub: pub, id: HostID(pub)}
}

// next returns the next text or binary message.
func (h *testHost) next() (websocket.MessageType, []byte) {
	h.t.Helper()
	typ, data, err := h.c.Read(testCtx(h.t))
	if err != nil {
		h.t.Fatalf("host read: %v", err)
	}
	return typ, data
}

func (h *testHost) nextJSON() map[string]any {
	h.t.Helper()
	typ, data := h.next()
	if typ != websocket.MessageText {
		h.t.Fatalf("expected text, got binary %v", data)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		h.t.Fatal(err)
	}
	return m
}

func (h *testHost) sendJSON(v any) {
	h.t.Helper()
	b, _ := json.Marshal(v)
	if err := h.c.Write(testCtx(h.t), websocket.MessageText, b); err != nil {
		h.t.Fatal(err)
	}
}

func (h *testHost) sendBinary(conn uint32, payload ...byte) {
	h.t.Helper()
	b := append([]byte{byte(conn >> 24), byte(conn >> 16), byte(conn >> 8), byte(conn)}, payload...)
	if err := h.c.Write(testCtx(h.t), websocket.MessageBinary, b); err != nil {
		h.t.Fatal(err)
	}
}

// nextOpen expects an open message and returns its conn and device hash.
func (h *testHost) nextOpen() (uint32, string) {
	h.t.Helper()
	m := h.nextJSON()
	if m["t"] != "open" {
		h.t.Fatalf("expected open, got %v", m)
	}
	return uint32(m["conn"].(float64)), m["device"].(string)
}

func (h *testHost) expectGone(conn uint32) {
	h.t.Helper()
	m := h.nextJSON()
	if m["t"] != "gone" || uint32(m["conn"].(float64)) != conn {
		h.t.Fatalf("expected gone %d, got %v", conn, m)
	}
}

type testDevice struct {
	t    *testing.T
	c    *websocket.Conn
	conn uint32
	hash string
}

// dialDevice connects, answers the challenge and waits for the verdict. A
// refusal comes back as the read error; use websocket.CloseStatus on it.
func dialDevice(t *testing.T, url, hostID string, priv [32]byte, ticket []byte) (*testDevice, error) {
	t.Helper()
	r := dialRaw(t, url+"/v1/device?host="+hostID)
	pub := pubOf(t, priv)
	extra := map[string]any{}
	if ticket != nil {
		extra["ticket"] = ticketB64(ticket)
	}
	r.hello("device", priv, pub, extra)
	d := &testDevice{t: t, c: r.c, hash: DeviceHash(pub)}
	typ, data, err := r.c.Read(testCtx(t))
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if typ != websocket.MessageText || json.Unmarshal(data, &m) != nil || m["t"] != "ok" {
		t.Fatalf("device hello answered %s", data)
	}
	d.conn = uint32(m["conn"].(float64))
	return d, nil
}

func (d *testDevice) sendBinary(payload ...byte) {
	d.t.Helper()
	if err := d.c.Write(testCtx(d.t), websocket.MessageBinary, payload); err != nil {
		d.t.Fatal(err)
	}
}

func (d *testDevice) nextBinary() []byte {
	d.t.Helper()
	typ, data, err := d.c.Read(testCtx(d.t))
	if err != nil || typ != websocket.MessageBinary {
		d.t.Fatalf("device read: %v %v", typ, err)
	}
	return data
}

func pubOf(t *testing.T, priv [32]byte) [32]byte {
	t.Helper()
	b, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	var pub [32]byte
	copy(pub[:], b)
	return pub
}

func eventually(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(testWait)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
