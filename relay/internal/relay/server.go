package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// peer is one WebSocket connection with its write path. All writes go through
// the byte-bounded queue: data is pushed with backpressure (queue.push), small
// control messages never wait (sendJSON), and drain is the only writer.
type peer struct {
	c    *websocket.Conn
	log  func(role string, code websocket.StatusCode)
	role string

	q    *queue
	done chan struct{} // closed by closeWith
	shut chan struct{} // closed when the close handshake attempt has ended
	once sync.Once

	release func() // frees the pending-handshake slot; set by serve

	// pctx ends when the peer is closed or its handler ends. Producers wait on
	// it so a closed peer never leaves them blocked. Reads must not use it:
	// cancelling a Read would drop the socket without a close frame.
	pctx    context.Context
	pcancel context.CancelFunc
}

func newPeer(c *websocket.Conn, role string, log func(string, websocket.StatusCode), queueBytes int) *peer {
	p := &peer{c: c, role: role, log: log, q: newQueue(queueBytes), done: make(chan struct{}), shut: make(chan struct{})}
	p.pctx, p.pcancel = context.WithCancel(context.Background())
	return p
}

// sendJSON queues a control message without waiting. A peer that is hundreds
// of control messages behind is cut with 4408.
func (p *peer) sendJSON(v any) {
	select {
	case <-p.done:
		return
	default:
	}
	b, _ := json.Marshal(v)
	if !p.q.pushControl(b) {
		p.closeWith(codeTooSlow)
	}
}

// drain writes queued messages until the peer is closed.
func (p *peer) drain(ctx context.Context) {
	for {
		it, err := p.q.popItem(ctx)
		if err != nil {
			return
		}
		if err := p.c.Write(ctx, it.typ, it.data); err != nil {
			return
		}
	}
}

// keepalive pings until the peer or the handler ends; a peer that has not
// answered within PongTimeout is closed.
func (p *peer) keepalive(ctx context.Context, every, timeout time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-t.C:
		case <-p.done:
			return
		case <-ctx.Done():
			return
		}
		pc, cancel := context.WithTimeout(ctx, timeout)
		err := p.c.Ping(pc)
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				p.closeWith(codeTooSlow)
			}
			return
		}
	}
}

// closeWith closes the connection with the code, once, without blocking.
func (p *peer) closeWith(code websocket.StatusCode) {
	p.once.Do(func() {
		close(p.done)
		p.q.close()
		p.pcancel()
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
	p.pcancel()
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
		// Admission before the upgrade: a full challenge room or a closing
		// server answers 503 and costs nothing.
		release := func() {}
		if s.pending != nil {
			select {
			case s.pending <- struct{}{}:
				release = sync.OnceFunc(func() { <-s.pending })
			default:
				http.Error(w, "busy", http.StatusServiceUnavailable)
				return
			}
		}
		defer release()

		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		if !s.enter() {
			c.Close(websocket.StatusGoingAway, "")
			return
		}
		defer s.wg.Done()
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		stop := context.AfterFunc(s.ctx, cancel)
		defer stop()

		p := newPeer(c, role, s.logClose, s.o.QueueBytes)
		p.release = release
		stopP := context.AfterFunc(ctx, p.pcancel)
		defer stopP()
		var wdone sync.WaitGroup
		wdone.Add(2)
		go func() { defer wdone.Done(); p.drain(ctx) }()
		go func() { defer wdone.Done(); p.keepalive(ctx, s.o.PingInterval, s.o.PongTimeout) }()
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

// enter registers a connection with the wait group unless the server is
// closing. The check and the Add share a lock, so Close never races them.
func (s *Server) enter() bool {
	s.cmu.Lock()
	defer s.cmu.Unlock()
	if s.closing {
		return false
	}
	s.wg.Add(1)
	return true
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
	// An expiring Read context would drop the socket without a close frame, so
	// the deadline is a timer that closes with 4400 instead.
	defer p.release()
	timer := time.AfterFunc(s.o.HelloTimeout, func() { p.closeWith(codeMalformed) })
	typ, data, err := p.c.Read(ctx)
	timer.Stop()
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
	// The library would answer an oversize message with 1009; the limit is set
	// above the real bound so that the loops can close with 4413 instead.
	p.c.SetReadLimit(2*int64(s.o.MaxMessage) + 8)
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
	hs := newHost(id, p, h.Devices, ticket, s.o.SlowTimeout)
	if !s.register(hs) {
		p.closeWith(codeLimit)
		return
	}
	defer s.unregister(hs)

	for {
		typ, data, err := p.c.Read(ctx)
		if err != nil {
			return
		}
		if len(data) > s.o.MaxMessage+4 {
			p.closeWith(codeTooLarge)
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
	d, code := hs.admit(p, DeviceHash(key), ticket, s.o.MaxDevicesPerHost)
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
		if len(data) > s.o.MaxMessage {
			p.closeWith(codeTooLarge)
			return
		}
		if typ == websocket.MessageBinary {
			hs.route(d, data)
		}
	}
}
