package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

// peer is one WebSocket connection with its write path. All writes go through
// enqueue (the only producer) and drain (the only consumer), so the queue can
// change without touching the hub.
type peer struct {
	c    *websocket.Conn
	log  func(role string, code websocket.StatusCode)
	role string

	q    chan queued
	done chan struct{} // closed by closeWith
	shut chan struct{} // closed when the close handshake attempt has ended
	once sync.Once
}

type queued struct {
	typ  websocket.MessageType
	data []byte
}

const queueLen = 256

func newPeer(c *websocket.Conn, role string, log func(string, websocket.StatusCode)) *peer {
	return &peer{c: c, role: role, log: log, q: make(chan queued, queueLen), done: make(chan struct{}), shut: make(chan struct{})}
}

// enqueue hands a message to the writer without blocking. A peer whose queue
// is full is cut with 4408 (a placeholder for the bounded byte queue).
func (p *peer) enqueue(typ websocket.MessageType, data []byte) {
	select {
	case <-p.done:
		return
	default:
	}
	select {
	case p.q <- queued{typ, data}:
	default:
		p.closeWith(codeTooSlow)
	}
}

func (p *peer) sendJSON(v any) {
	b, _ := json.Marshal(v)
	p.enqueue(websocket.MessageText, b)
}

// drain writes queued messages until the peer is closed.
func (p *peer) drain(ctx context.Context) {
	for {
		select {
		case m := <-p.q:
			if err := p.c.Write(ctx, m.typ, m.data); err != nil {
				return
			}
		case <-p.done:
			return
		case <-ctx.Done():
			return
		}
	}
}

// closeWith closes the connection with the code, once, without blocking.
func (p *peer) closeWith(code websocket.StatusCode) {
	p.once.Do(func() {
		close(p.done)
		p.log(p.role, code)
		go func() { p.c.Close(code, ""); close(p.shut) }()
	})
}

// finish waits for a close started by closeWith (so its frame is sent before
// the handler returns), then drops the connection.
func (p *peer) finish() {
	select {
	case <-p.done:
		<-p.shut
	default:
	}
	p.c.CloseNow()
}

// Handler serves /v1/host, /v1/device and /healthz.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /v1/host", s.serve("host", s.runHost))
	mux.HandleFunc("GET /v1/device", s.serve("device", s.runDevice))
	return mux
}

func (s *Server) logClose(role string, code websocket.StatusCode) {
	s.log.Info("close", "role", role, "code", int(code))
}

type session func(ctx context.Context, p *peer, r *http.Request, ch Challenge)

func (s *Server) serve(role string, run session) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		s.wg.Add(1)
		defer s.wg.Done()
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		stop := context.AfterFunc(s.ctx, cancel)
		defer stop()

		p := newPeer(c, role, s.logClose)
		var wdone sync.WaitGroup
		wdone.Add(1)
		go func() { defer wdone.Done(); p.drain(ctx) }()
		defer func() {
			p.finish()
			cancel()
			wdone.Wait()
		}()

		c.SetReadLimit(4096)
		ch, err := NewChallenge()
		if err != nil {
			p.closeWith(websocket.StatusInternalError)
			return
		}
		p.sendJSON(map[string]string{"t": "challenge", "eph": b64.EncodeToString(ch.EphPub[:]), "nonce": b64.EncodeToString(ch.Nonce[:])})
		run(ctx, p, r, ch)
	}
}

type hello struct {
	T       string   `json:"t"`
	Key     string   `json:"key"`
	Proof   string   `json:"proof"`
	Devices []string `json:"devices"`
	Ticket  *string  `json:"ticket"`
}

// readHello waits for the client's hello and checks its proof. On failure it
// closes the peer and returns ok=false.
func (s *Server) readHello(ctx context.Context, p *peer, ch Challenge, role string) (h hello, key [32]byte, ticket []byte, ok bool) {
	hctx, cancel := context.WithTimeout(ctx, s.o.HelloTimeout)
	defer cancel()
	typ, data, err := p.c.Read(hctx)
	if err != nil || typ != websocket.MessageText {
		p.closeWith(codeMalformed)
		return
	}
	if json.Unmarshal(data, &h) != nil || h.T != "hello" || h.Key == "" {
		p.closeWith(codeMalformed)
		return
	}
	key, err = decodeKey(h.Key)
	if err != nil || len(h.Devices) > maxListed {
		p.closeWith(codeMalformed)
		return
	}
	if h.Ticket != nil {
		if ticket, err = decodeTicket(*h.Ticket); err != nil {
			p.closeWith(codeMalformed)
			return
		}
	}
	proof, err := b64.Strict().DecodeString(h.Proof)
	if err != nil || !ch.Verify(role, key, proof) {
		p.closeWith(codeBadProof)
		return
	}
	p.c.SetReadLimit(int64(s.o.MaxMessage) + 4)
	return h, key, ticket, true
}

func decodeTicket(s string) ([]byte, error) {
	k, err := decodeKey(s)
	if err != nil {
		return nil, err
	}
	return k[:], nil
}

func (s *Server) runHost(ctx context.Context, p *peer, _ *http.Request, ch Challenge) {
	h, key, ticket, ok := s.readHello(ctx, p, ch, "host")
	if !ok {
		return
	}
	id := HostID(key)
	if s.o.Admit != nil && !s.o.Admit(id) {
		p.closeWith(codeNotAllowed)
		return
	}
	hs := newHost(id, p, h.Devices, ticket)
	s.register(hs)
	defer s.unregister(hs)

	for {
		typ, data, err := p.c.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			if len(data) >= 4 {
				hs.deliver(uint32(data[0])<<24|uint32(data[1])<<16|uint32(data[2])<<8|uint32(data[3]), data[4:])
			}
			continue
		}
		var m struct {
			T       string   `json:"t"`
			Devices []string `json:"devices"`
			Ticket  *string  `json:"ticket"`
			Conn    uint32   `json:"conn"`
		}
		if json.Unmarshal(data, &m) != nil {
			p.closeWith(codeMalformed)
			return
		}
		switch m.T {
		case "devices":
			if len(m.Devices) > maxListed {
				p.closeWith(codeMalformed)
				return
			}
			hs.updateDevices(m.Devices)
		case "ticket":
			var t []byte
			if m.Ticket != nil {
				if t, err = decodeTicket(*m.Ticket); err != nil {
					p.closeWith(codeMalformed)
					return
				}
			}
			hs.setTicket(t)
		case "close":
			hs.kickConn(m.Conn)
		}
	}
}

func (s *Server) runDevice(ctx context.Context, p *peer, r *http.Request, ch Challenge) {
	_, key, ticket, ok := s.readHello(ctx, p, ch, "device")
	if !ok {
		return
	}
	hs := s.lookup(r.URL.Query().Get("host"))
	if hs == nil {
		p.closeWith(codeHostOffline)
		return
	}
	d, code := hs.admit(p, DeviceHash(key), ticket)
	if d == nil {
		p.closeWith(code)
		return
	}
	defer hs.remove(d)

	for {
		typ, data, err := p.c.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			hs.route(d, data)
		}
	}
}
