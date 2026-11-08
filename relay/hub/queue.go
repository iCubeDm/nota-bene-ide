package hub

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/coder/websocket"
)

var (
	errQueueClosed = errors.New("queue closed")
	errSkipped     = errors.New("message dropped")
	errSlow        = errors.New("queue stayed full")
)

// maxControl bounds the control messages (ok, open, gone) waiting in one
// queue; they bypass the byte limit but cannot grow without bound.
const maxControl = 1024

// itemOverhead is what one queued data message costs beyond its buffer: the
// queue slot, the slice header and allocator rounding. It is charged even for
// an empty payload, so a flood of empty frames fills a queue like any other.
const itemOverhead = 64

// cost is what a data message is charged against the queue and the budget:
// the capacity it keeps alive plus the per-item overhead.
func cost(msg []byte) int { return cap(msg) + itemOverhead }

// budget is the hub-wide bound on data bytes held for delivery: messages
// waiting to enter a queue (parked), queued, and being written (in flight).
// A nil budget is unlimited.
type budget struct {
	limit int

	mu   sync.Mutex
	used int
	wake chan struct{} // closed and replaced when used falls back to the limit
}

func newBudget(limit int) *budget {
	if limit <= 0 {
		return nil
	}
	return &budget{limit: limit, wake: make(chan struct{})}
}

func (b *budget) charge(n int) {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.used += n
	b.mu.Unlock()
}

func (b *budget) release(n int) {
	if b == nil || n == 0 {
		return
	}
	b.mu.Lock()
	over := b.used > b.limit
	b.used -= n
	if over && b.used <= b.limit {
		close(b.wake)
		b.wake = make(chan struct{})
	}
	b.mu.Unlock()
}

// over reports whether the budget is exceeded and, if so, a channel closed
// once it no longer is.
func (b *budget) over() (bool, <-chan struct{}) {
	if b == nil {
		return false, nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.used > b.limit {
		return true, b.wake
	}
	return false, nil
}

func (b *budget) inUse() int {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.used
}

type qitem struct {
	typ  websocket.MessageType
	data []byte
	cost int // charged bytes; 0 for control messages
	ctrl bool
}

// queue is a FIFO bounded by the bytes it holds (see cost). A producer that
// would exceed the limit, or the hub-wide budget, waits, which is the relay's
// backpressure; nothing is ever dropped to make room.
type queue struct {
	limit  int
	budget *budget

	mu     sync.Mutex
	items  []qitem
	bytes  int // charged bytes of queued data items
	ctrl   int // control items waiting
	closed bool
	// fullSince is when a producer first found the queue full; it is cleared
	// only once the queued bytes fall below half the limit, so a consumer that
	// drains a little at a time still counts as stuck. Waiting for the budget
	// alone does not set it.
	fullSince time.Time
	wake      chan struct{} // closed and replaced on every change
}

func newQueue(limit int, b *budget) *queue {
	return &queue{limit: limit, budget: b, wake: make(chan struct{})}
}

func (q *queue) broadcast() {
	close(q.wake)
	q.wake = make(chan struct{})
}

// push queues a binary message, waiting while it does not fit.
func (q *queue) push(ctx context.Context, msg []byte) error {
	return q.pushSlow(ctx, msg, nil, 0, nil)
}

// pushSlow queues a binary message. It waits while the message does not fit
// the queue's limit or the budget is exceeded; a message always enters an
// empty queue, so every consumer can make progress. The message is charged to
// the budget from the call on (it is held in memory while it waits).
//
// guard is evaluated under the queue lock at the moment of insertion; when it
// returns false the message is dropped (errSkipped). With slow > 0 the push
// gives up with errSlow once the queue has stayed full for slow, whether that
// shows while waiting (for room or for the budget) or on a later push. stall, when set, is called when the
// push starts waiting, and the function it returns when the wait ends.
func (q *queue) pushSlow(ctx context.Context, msg []byte, guard func() bool, slow time.Duration, stall func() func()) error {
	c := cost(msg)
	q.budget.charge(c)
	var end func()
	defer func() {
		if end != nil {
			end()
		}
	}()
	fail := func(err error) error {
		q.mu.Unlock()
		q.budget.release(c)
		return err
	}
	for {
		q.mu.Lock()
		if q.closed {
			return fail(errQueueClosed)
		}
		if guard != nil && !guard() {
			return fail(errSkipped)
		}
		if slow > 0 && !q.fullSince.IsZero() && time.Since(q.fullSince) >= slow {
			return fail(errSlow)
		}
		fits := q.bytes+c <= q.limit
		over, budgetWake := q.budget.over()
		if q.bytes == 0 || (fits && !over) {
			q.items = append(q.items, qitem{typ: websocket.MessageBinary, data: msg, cost: c})
			q.bytes += c
			q.broadcast()
			q.mu.Unlock()
			return nil
		}
		// Here the queue is not empty (an empty one always takes the
		// message), so any wait, for room or for the budget, is a stall.
		if q.fullSince.IsZero() {
			q.fullSince = time.Now()
		}
		wake := q.wake
		var expire <-chan time.Time
		var timer *time.Timer
		if slow > 0 && !q.fullSince.IsZero() {
			timer = time.NewTimer(time.Until(q.fullSince.Add(slow)))
			expire = timer.C
		}
		q.mu.Unlock()
		if end == nil && stall != nil {
			end = stall()
		}
		select {
		case <-wake:
		case <-budgetWake:
		case <-expire:
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			q.budget.release(c)
			return ctx.Err()
		}
		if timer != nil {
			timer.Stop()
		}
	}
}

// pushControl queues a text message without waiting and outside the byte
// limit. It reports false when the queue is closed or holds too many control
// messages.
func (q *queue) pushControl(msg []byte) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed || q.ctrl >= maxControl {
		return false
	}
	q.items = append(q.items, qitem{typ: websocket.MessageText, data: msg, ctrl: true})
	q.ctrl++
	q.broadcast()
	return true
}

// popItem takes the oldest message, waiting while the queue is empty. The
// item stays charged to the budget until it is passed to done.
func (q *queue) popItem(ctx context.Context) (qitem, error) {
	for {
		q.mu.Lock()
		if q.closed {
			q.mu.Unlock()
			return qitem{}, errQueueClosed
		}
		if len(q.items) > 0 {
			it := q.items[0]
			q.items[0] = qitem{}
			q.items = q.items[1:]
			if it.ctrl {
				q.ctrl--
			} else {
				q.bytes -= it.cost
				if q.bytes < q.limit/2 {
					q.fullSince = time.Time{}
				}
			}
			q.broadcast()
			q.mu.Unlock()
			return it, nil
		}
		wake := q.wake
		q.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
			return qitem{}, ctx.Err()
		}
	}
}

// done releases a popped item once it has been written or abandoned.
func (q *queue) done(it qitem) { q.budget.release(it.cost) }

// pop returns the oldest message, waiting while the queue is empty.
func (q *queue) pop(ctx context.Context) ([]byte, error) {
	it, err := q.popItem(ctx)
	q.done(it)
	return it.data, err
}

// queued reports the charged bytes and the number of data items queued.
func (q *queue) queued() (bytes, items int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.bytes, len(q.items) - q.ctrl
}

// close drops every queued message, releasing its memory and budget, and
// wakes every waiter; later pushes and pops fail.
func (q *queue) close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.closed = true
	n := 0
	for i := range q.items {
		n += q.items[i].cost
		q.items[i] = qitem{}
	}
	q.items, q.bytes, q.ctrl = nil, 0, 0
	q.budget.release(n)
	q.broadcast()
}
