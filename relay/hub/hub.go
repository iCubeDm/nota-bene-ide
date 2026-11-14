package hub

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Close codes of the wire protocol.
const (
	codeMalformed   = websocket.StatusCode(4400)
	codeBadProof    = websocket.StatusCode(4401)
	codeHostRefused = websocket.StatusCode(4402)
	codeKeyLimit    = websocket.StatusCode(4405)
	codeNotAllowed  = websocket.StatusCode(4403)
	codeHostOffline = websocket.StatusCode(4404)
	codeTooSlow     = websocket.StatusCode(4408)
	codeReplaced    = websocket.StatusCode(4409)
	codeTooLarge    = websocket.StatusCode(4413)
	codeLimit       = websocket.StatusCode(4429)
)

const maxListed = 32

// Options configure a Server. A limit of zero or less means unlimited for the
// counts and for TotalBytes; a PingInterval of zero or less disables
// keepalive; the other timeouts and byte bounds must be set (see
// DefaultOptions).
type Options struct {
	MaxHosts, MaxDevicesPerHost, MaxPending int
	HelloTimeout, PingInterval              time.Duration
	PongTimeout, SlowTimeout                time.Duration
	QueueBytes, MaxMessage                  int
	// TotalBytes bounds the data held for delivery across the whole hub
	// (parked, queued and in flight). Over it, pushes wait and new
	// connections are refused with 4429.
	TotalBytes int
	// Admit, when set, is asked about every proven host id with the member key
	// its hello was signed with (nil when it carries none; a member key whose
	// signature fails is refused with 4402 before Admit is asked). ok false
	// refuses the host with 4402; hosts > 0 is how many hosts that member key may
	// have connected at once (more are refused with 4405). Without Admit the
	// member fields are ignored. ctx ends at the hello deadline or at server
	// shutdown.
	Admit func(ctx context.Context, hostID string, member *[32]byte) (hosts int, ok bool)
	// Log receives counts and close codes only. Nil discards.
	Log *slog.Logger
}

// DefaultOptions are the production limits.
func DefaultOptions() Options {
	return Options{
		MaxHosts: 1000, MaxDevicesPerHost: 16, MaxPending: 256,
		HelloTimeout: 10 * time.Second, PingInterval: 30 * time.Second,
		PongTimeout: 60 * time.Second, SlowTimeout: 10 * time.Second,
		QueueBytes: 1 << 20, MaxMessage: 1 << 20, TotalBytes: 256 << 20,
	}
}

// Server is the relay hub. It keeps only live connections, nothing persistent.
type Server struct {
	o   Options
	log *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu    sync.Mutex // guards hosts and seq
	hosts map[string]*host
	seq   uint64 // admission order of hosts
	// revoked is the seq at a member key's last Revoke: a host whose Admit was
	// answered before it must not register after it.
	revoked map[[32]byte]uint64

	pending chan struct{} // semaphore of connections still in the challenge; nil = unlimited
	budget  *budget       // hub-wide data bytes; nil = unlimited

	lmu    sync.Mutex // guards closes
	closes map[CloseKey]int

	cmu     sync.Mutex // guards closing and wg.Add
	closing bool
}

// NewServer builds a hub.
func NewServer(o Options) *Server {
	s := &Server{o: o, log: o.Log, hosts: map[string]*host{}, budget: newBudget(o.TotalBytes), closes: map[CloseKey]int{}}
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

// CloseKey names a kind of close the relay initiated.
type CloseKey struct {
	Role string // "host" or "device"
	Code int
}

// TakeCloses returns how many connections the relay closed, by role and code,
// since the previous call, and resets the counts.
func (s *Server) TakeCloses() map[CloseKey]int {
	s.lmu.Lock()
	defer s.lmu.Unlock()
	c := s.closes
	s.closes = map[CloseKey]int{}
	return c
}

// host is one admitted host connection and its devices.
type host struct {
	id     string
	member *[32]byte // the member key it was admitted with; nil on an open hub
	seq    uint64    // admission order, set by register
	p      *peer
	slow   time.Duration // how long a frame may wait for a device's queue

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
	// A newer connection of the same device replaces the older one, so a
	// reconnect never waits for keepalive to clear its predecessor.
	for _, old := range h.conns {
		if old.hash == hash {
			h.cut(old, codeReplaced)
			break
		}
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
	copy(frame[4:], payload)
	h.routeFrame(d, frame)
}

// routeFrame is route for a frame that already has 4 spare bytes in front of
// the payload (the reader leaves them), so no copy is made.
func (h *host) routeFrame(d *device, frame []byte) {
	frame[0], frame[1], frame[2], frame[3] = byte(d.conn>>24), byte(d.conn>>16), byte(d.conn>>8), byte(d.conn)
	// While the push waits, the device's reader is parked, not reading pongs.
	h.p.q.pushSlow(d.p.pctx, frame, func() bool { return !d.gone.Load() }, 0, d.p.stall)
}

// deliver forwards a host frame to one device, waiting for room. A device whose
// queue stayed full for the slow timeout is cut with 4408; the host carries on.
func (h *host) deliver(conn uint32, payload []byte) {
	h.mu.Lock()
	d := h.conns[conn]
	h.mu.Unlock()
	if d == nil {
		return
	}
	// While the push waits, the host's reader is parked, not reading pongs.
	err := d.p.q.pushSlow(h.p.pctx, payload, func() bool { return !d.gone.Load() }, h.slow, h.p.stall)
	if errors.Is(err, errSlow) {
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
// register adds an admitted host, replacing a connected one with the same id.
// It refuses with codeLimit when the hub is full and with codeKeyLimit when
// the host's member key already has limit other hosts connected (the replaced
// host does not count); 0 means registered.
func (s *Server) register(h *host, limit int, asked uint64) websocket.StatusCode {
	s.mu.Lock()
	if h.member != nil && s.revoked[*h.member] > asked {
		s.mu.Unlock()
		return codeHostRefused
	}
	old := s.hosts[h.id]
	if old == nil && s.o.MaxHosts > 0 && len(s.hosts) >= s.o.MaxHosts {
		s.mu.Unlock()
		return codeLimit
	}
	if h.member != nil && limit > 0 {
		n := 0
		for _, o := range s.hosts {
			if o != old && o.member != nil && *o.member == *h.member {
				n++
			}
		}
		if n >= limit {
			s.mu.Unlock()
			return codeKeyLimit
		}
	}
	s.seq++
	h.seq = s.seq
	s.hosts[h.id] = h
	h.p.sendJSON(map[string]any{"t": "ok"})
	s.mu.Unlock()
	if old != nil {
		old.p.closeWith(codeReplaced)
		old.shutdown()
	}
	return 0
}

// memberHosts returns the hosts admitted with member, oldest first. s.mu held.
func (s *Server) memberHosts(member [32]byte) []*host {
	var list []*host
	for _, h := range s.hosts {
		if h.member != nil && *h.member == member {
			list = append(list, h)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].seq < list[j].seq })
	return list
}

// admissionMark is the point a later Revoke is measured against (see register).
func (s *Server) admissionMark() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.seq
}

// Revoke closes every host admitted with the member key with 4402, and refuses
// one whose admission is under way. The caller makes Admit refuse it from now.
func (s *Server) Revoke(member [32]byte) {
	s.mu.Lock()
	s.seq++
	if s.revoked == nil {
		s.revoked = map[[32]byte]uint64{}
	}
	s.revoked[member] = s.seq
	list := s.memberHosts(member)
	s.mu.Unlock()
	for _, h := range list {
		h.p.closeWith(codeHostRefused)
		h.shutdown()
	}
}

// Limit applies a lowered host limit to connected hosts: those admitted with
// the member key beyond the first hosts, the most recent first, are closed with
// 4405. hosts <= 0 means no limit.
func (s *Server) Limit(member [32]byte, hosts int) {
	if hosts <= 0 {
		return
	}
	s.mu.Lock()
	list := s.memberHosts(member)
	s.mu.Unlock()
	if len(list) <= hosts {
		return
	}
	for _, h := range list[hosts:] {
		h.p.closeWith(codeKeyLimit)
		h.shutdown()
	}
}

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
