package relay

import (
	"context"
	"errors"
	"sync"

	"github.com/coder/websocket"
)

var (
	errQueueClosed = errors.New("queue closed")
	errSkipped     = errors.New("message dropped")
)

// maxControl bounds the control messages (ok, open, gone) waiting in one
// queue; they bypass the byte limit but cannot grow without bound.
const maxControl = 1024

type qitem struct {
	typ  websocket.MessageType
	data []byte
	ctrl bool
}

// queue is a FIFO bounded by the bytes it holds. A producer that would exceed
// the limit waits, which is the relay's backpressure; nothing is ever dropped
// to make room.
type queue struct {
	limit int

	mu     sync.Mutex
	items  []qitem
	bytes  int // payload bytes of data items
	ctrl   int // control items waiting
	closed bool
	wake   chan struct{} // closed and replaced on every change
}

func newQueue(limit int) *queue {
	return &queue{limit: limit, wake: make(chan struct{})}
}

func (q *queue) broadcast() {
	close(q.wake)
	q.wake = make(chan struct{})
}

// push queues a binary message, waiting while it does not fit. One message
// larger than the limit is accepted when nothing else is queued.
func (q *queue) push(ctx context.Context, msg []byte) error {
	return q.pushIf(ctx, msg, nil)
}

// pushIf is push with a guard evaluated under the queue lock at the moment of
// insertion; when it returns false the message is dropped (errSkipped).
func (q *queue) pushIf(ctx context.Context, msg []byte, guard func() bool) error {
	for {
		q.mu.Lock()
		if q.closed {
			q.mu.Unlock()
			return errQueueClosed
		}
		if guard != nil && !guard() {
			q.mu.Unlock()
			return errSkipped
		}
		if q.bytes == 0 || q.bytes+len(msg) <= q.limit {
			q.items = append(q.items, qitem{typ: websocket.MessageBinary, data: msg})
			q.bytes += len(msg)
			q.broadcast()
			q.mu.Unlock()
			return nil
		}
		wake := q.wake
		q.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
			return ctx.Err()
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
				q.bytes -= len(it.data)
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

// pop returns the oldest message, waiting while the queue is empty.
func (q *queue) pop(ctx context.Context) ([]byte, error) {
	it, err := q.popItem(ctx)
	return it.data, err
}

// close wakes every waiter; later pushes and pops fail.
func (q *queue) close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.closed {
		q.closed = true
		q.broadcast()
	}
}
