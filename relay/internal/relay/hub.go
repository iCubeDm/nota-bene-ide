package relay

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Close codes of the wire protocol.
const (
	codeMalformed   = websocket.StatusCode(4400)
	codeBadProof    = websocket.StatusCode(4401)
	codeNotAllowed  = websocket.StatusCode(4403)
	codeHostOffline = websocket.StatusCode(4404)
	codeTooSlow     = websocket.StatusCode(4408)
	codeReplaced    = websocket.StatusCode(4409)
	codeTooLarge    = websocket.StatusCode(4413)
	codeLimit       = websocket.StatusCode(4429)
)

const maxListed = 32

// Options configure a Server. A limit of zero or less means unlimited for the
// counts; the timeouts and byte bounds must be set (see DefaultOptions).
type Options struct {
	MaxHosts, MaxDevicesPerHost, MaxPending int
	HelloTimeout, PingInterval              time.Duration
	PongTimeout, SlowTimeout                time.Duration
	QueueBytes, MaxMessage                  int
	// Admit, when set, is asked about every proven host id; false refuses it.
	Admit func(hostID string) bool
	// Log receives counts and close codes only. Nil discards.
	Log *slog.Logger
}

// DefaultOptions are the production limits.
func DefaultOptions() Options {
	return Options{
		MaxHosts: 1000, MaxDevicesPerHost: 16, MaxPending: 256,
		HelloTimeout: 10 * time.Second, PingInterval: 30 * time.Second,
		PongTimeout: 60 * time.Second, SlowTimeout: 10 * time.Second,
		QueueBytes: 1 << 20, MaxMessage: 1 << 20,
	}
}

// Server is the relay hub. It keeps only live connections, nothing persistent.
type Server struct {
	o   Options
	log *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu    sync.Mutex // guards hosts
	hosts map[string]*host

	pending chan struct{} // semaphore of connections still in the challenge; nil = unlimited

	cmu     sync.Mutex // guards closing and wg.Add
	closing bool
}

// NewServer builds a hub.
func NewServer(o Options) *Server {
	s := &Server{o: o, log: o.Log, hosts: map[string]*host{}}
	if o.MaxPending > 0 {
		s.pending = make(chan struct{}, o.MaxPending)
	}
	if s.log == nil {
		s.log = slog.New(slog.DiscardHandler)
	}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	return s
}

// Close drops every connection and waits for the handlers to finish.
func (s *Server) Close() {
	s.cmu.Lock()
	s.closing = true
	s.cmu.Unlock()
	s.cancel()
	s.wg.Wait()
}

// Stats reports connected hosts and devices.
func (s *Server) Stats() (hosts, devices int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, h := range s.hosts {
		hosts++
		h.mu.Lock()
		devices += len(h.conns)
		h.mu.Unlock()
	}
	return hosts, devices
}

// host is one admitted host connection and its devices.
type host struct {
	id   string
	p    *peer
	slow time.Duration // how long a frame may wait for a device's queue

	mu      sync.Mutex // guards everything below
	closed  bool
	devices map[string]struct{} // admitted device hashes
	ticket  []byte              // current pairing ticket id, nil when none
	conns   map[uint32]*device
	last    uint32
}

type device struct {
	p      *peer
	conn   uint32
	hash   string
	ticket []byte      // ticket it was admitted with, nil if admitted by the list
	gone   atomic.Bool // set under host.mu before "gone" is queued
}

func newHost(id string, p *peer, devices []string, ticket []byte, slow time.Duration) *host {
	h := &host{id: id, p: p, slow: slow, ticket: ticket, conns: map[uint32]*device{}}
	h.setDevices(devices)
	return h
}

func (h *host) setDevices(list []string) {
	h.devices = make(map[string]struct{}, len(list))
	for _, d := range list {
		h.devices[d] = struct{}{}
	}
}

func sameTicket(a, b []byte) bool {
	return a != nil && b != nil && subtle.ConstantTimeCompare(a, b) == 1
}

// allowed reports whether a device may stay or join: listed, or holding the
// host's current ticket. Caller holds h.mu.
func (h *host) allowed(hash string, ticket []byte) bool {
	if _, ok := h.devices[hash]; ok {
		return true
	}
	return sameTicket(h.ticket, ticket)
}

// admit registers a device and tells both sides. It returns nil with a close
// code when the device is refused.
func (h *host) admit(p *peer, hash string, ticket []byte, maxDevices int) (*device, websocket.StatusCode) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, codeHostOffline
	}
	if !h.allowed(hash, ticket) {
		return nil, codeNotAllowed
	}
	if maxDevices > 0 && len(h.conns) >= maxDevices {
		return nil, codeLimit
	}
	h.last++
	d := &device{p: p, conn: h.last, hash: hash}
	if _, listed := h.devices[hash]; !listed {
		d.ticket = ticket
	}
	h.conns[d.conn] = d
	h.p.sendJSON(map[string]any{"t": "open", "conn": d.conn, "device": hash})
	p.sendJSON(map[string]any{"t": "ok", "conn": d.conn})
	return d, 0
}

// remove forgets a device that left on its own and tells the host.
func (h *host) remove(d *device) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[d.conn] != d {
		return
	}
	d.gone.Store(true)
	delete(h.conns, d.conn)
	if !h.closed {
		h.p.sendJSON(map[string]any{"t": "gone", "conn": d.conn})
	}
}

// cut removes a device on the relay's or the host's behalf, tells the host and
// closes the device with code. Caller holds h.mu. Nothing here waits.
func (h *host) cut(d *device, code websocket.StatusCode) {
	if h.conns[d.conn] != d {
		return
	}
	d.gone.Store(true)
	delete(h.conns, d.conn)
	h.p.sendJSON(map[string]any{"t": "gone", "conn": d.conn})
	d.p.closeWith(code)
}

// route forwards a device frame to the host. It waits while the host's queue
// is full, which stops the device's reads (backpressure) and never drops or
// cuts. The guard keeps a frame from following its device's "gone".
func (h *host) route(d *device, payload []byte) {
	frame := make([]byte, 4+len(payload))
	frame[0], frame[1], frame[2], frame[3] = byte(d.conn>>24), byte(d.conn>>16), byte(d.conn>>8), byte(d.conn)
	copy(frame[4:], payload)
	h.p.q.pushIf(d.p.pctx, frame, func() bool { return !d.gone.Load() })
}

// deliver forwards a host frame to one device, waiting up to the slow timeout
// for room. A device that stays full is cut with 4408; the host carries on.
func (h *host) deliver(conn uint32, payload []byte) {
	h.mu.Lock()
	d := h.conns[conn]
	h.mu.Unlock()
	if d == nil {
		return
	}
	ctx, cancel := context.WithTimeout(h.p.pctx, h.slow)
	err := d.p.q.pushIf(ctx, payload, func() bool { return !d.gone.Load() })
	cancel()
	if errors.Is(err, context.DeadlineExceeded) && h.p.pctx.Err() == nil {
		h.mu.Lock()
		h.cut(d, codeTooSlow)
		h.mu.Unlock()
	}
}

func (h *host) updateDevices(list []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.setDevices(list)
	for _, d := range h.conns {
		if !h.allowed(d.hash, d.ticket) {
			h.cut(d, codeNotAllowed)
		}
	}
}

func (h *host) setTicket(t []byte) {
	h.mu.Lock()
	h.ticket = t
	h.mu.Unlock()
}

func (h *host) kickConn(conn uint32) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if d := h.conns[conn]; d != nil {
		h.cut(d, codeNotAllowed)
	}
}

// shutdown marks the host gone and closes all its devices with 4404.
func (h *host) shutdown() {
	h.mu.Lock()
	h.closed = true
	conns := h.conns
	h.conns = map[uint32]*device{}
	for _, d := range conns {
		d.gone.Store(true)
	}
	h.mu.Unlock()
	for _, d := range conns {
		d.p.closeWith(codeHostOffline)
	}
}

// register makes h the host for its id, replacing and closing any previous
// one, then confirms to the host. The confirmation is queued under the lock so
// it precedes any "open" a device can trigger.
func (s *Server) register(h *host) bool {
	s.mu.Lock()
	old := s.hosts[h.id]
	if old == nil && s.o.MaxHosts > 0 && len(s.hosts) >= s.o.MaxHosts {
		s.mu.Unlock()
		return false
	}
	s.hosts[h.id] = h
	h.p.sendJSON(map[string]any{"t": "ok"})
	s.mu.Unlock()
	if old != nil {
		old.p.closeWith(codeReplaced)
		old.shutdown()
	}
	return true
}

// unregister drops h if it is still the registered host, then closes its devices.
func (s *Server) unregister(h *host) {
	s.mu.Lock()
	if s.hosts[h.id] == h {
		delete(s.hosts, h.id)
	}
	s.mu.Unlock()
	h.shutdown()
}

func (s *Server) lookup(id string) *host {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hosts[id]
}
