package hub

import (
	"context"
	"testing"
	"time"
)

// c is what an n-byte message is charged.
func c(n int) int { return n + itemOverhead }

func TestQueueBlocksAtLimit(t *testing.T) {
	q := newQueue(2*c(6)-1, nil)
	ctx := testCtx(t)
	if err := q.push(ctx, make([]byte, 6)); err != nil {
		t.Fatal(err)
	}
	pushed := make(chan error, 1)
	go func() { pushed <- q.push(ctx, make([]byte, 6)) }()
	select {
	case err := <-pushed:
		t.Fatalf("push over the limit returned: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if m, err := q.pop(ctx); err != nil || len(m) != 6 {
		t.Fatalf("pop: %d %v", len(m), err)
	}
	if err := <-pushed; err != nil {
		t.Fatalf("blocked push: %v", err)
	}
}

func TestQueueOversizeWhenEmpty(t *testing.T) {
	q := newQueue(c(4), nil)
	ctx := testCtx(t)
	if err := q.push(ctx, make([]byte, 9)); err != nil {
		t.Fatalf("lone oversize message: %v", err)
	}
	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if err := q.push(short, []byte{1}); err == nil {
		t.Fatal("second message fit beside an oversize one")
	}
}

func TestQueueContext(t *testing.T) {
	q := newQueue(1, nil)
	ctx, cancel := context.WithTimeout(testCtx(t), 50*time.Millisecond)
	defer cancel()
	if _, err := q.pop(ctx); err != context.DeadlineExceeded {
		t.Fatalf("pop on empty: %v", err)
	}
}

func TestQueueClose(t *testing.T) {
	q := newQueue(c(2), nil)
	ctx := testCtx(t)
	q.push(ctx, []byte{1, 2})
	push := make(chan error, 1)
	go func() { push <- q.push(ctx, []byte{3}) }()
	q2 := newQueue(c(2), nil)
	pop := make(chan error, 1)
	go func() { _, err := q2.pop(ctx); pop <- err }()
	time.Sleep(50 * time.Millisecond)
	q.close()
	q2.close()
	if err := <-push; err == nil {
		t.Fatal("blocked push survived close")
	}
	if err := <-pop; err == nil {
		t.Fatal("blocked pop survived close")
	}
	if err := q.push(ctx, []byte{1}); err == nil {
		t.Fatal("push after close")
	}
}

func TestQueueControlBypassesLimit(t *testing.T) {
	q := newQueue(c(2), nil)
	ctx := testCtx(t)
	q.push(ctx, []byte{1, 2})
	if !q.pushControl([]byte("x")) {
		t.Fatal("control refused at the byte limit")
	}
	for i := 0; i < maxControl; i++ {
		q.pushControl([]byte("x"))
	}
	if q.pushControl([]byte("x")) {
		t.Fatal("control queue unbounded")
	}
}

func TestQueueStaysFull(t *testing.T) {
	q := newQueue(c(6)+c(4), nil)
	ctx := testCtx(t)
	q.push(ctx, make([]byte, 6))
	q.push(ctx, make([]byte, 4))
	// A consumer that frees room one message at a time never lets the queue
	// drop below half, so the producer is eventually told it stayed full.
	go func() {
		for i := 0; i < 100; i++ {
			time.Sleep(10 * time.Millisecond)
			if _, err := q.pop(ctx); err != nil {
				return
			}
			q.push(ctx, make([]byte, 6))
		}
	}()
	start := time.Now()
	var err error
	for err == nil {
		err = q.pushSlow(ctx, make([]byte, 4), nil, 100*time.Millisecond, nil)
		if time.Since(start) > 3*time.Second {
			t.Fatal("never told the queue stayed full")
		}
	}
	if err != errSlow {
		t.Fatalf("got %v", err)
	}
}

// Empty and tiny messages are charged their overhead, so they cannot slip
// past the bound.
func TestQueueChargesEmptyMessages(t *testing.T) {
	q := newQueue(10*itemOverhead, nil)
	ctx := testCtx(t)
	for i := 0; i < 10; i++ {
		if err := q.push(ctx, nil); err != nil {
			t.Fatal(err)
		}
	}
	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if err := q.push(short, nil); err == nil {
		t.Fatal("an empty message went past a full queue")
	}
	if b, n := q.queued(); b != 10*itemOverhead || n != 10 {
		t.Fatalf("queued %d bytes in %d items", b, n)
	}
}

// The budget bounds what all queues hold together; a message still enters
// an empty queue, and released bytes let a waiting push in.
func TestBudgetAcrossQueues(t *testing.T) {
	b := newBudget(3 * c(10))
	q1, q2 := newQueue(1<<20, b), newQueue(1<<20, b)
	ctx := testCtx(t)
	for i := 0; i < 3; i++ {
		if err := q1.push(ctx, make([]byte, 10)); err != nil {
			t.Fatal(err)
		}
	}
	if err := q2.push(ctx, make([]byte, 10)); err != nil { // empty queue: always enters
		t.Fatalf("empty queue refused: %v", err)
	}
	if over, _ := b.over(); !over {
		t.Fatalf("budget not exceeded at %d", b.inUse())
	}
	pushed := make(chan error, 1)
	go func() { pushed <- q1.push(ctx, make([]byte, 10)) }()
	select {
	case err := <-pushed:
		t.Fatalf("push over the budget returned: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if b.inUse() != 5*c(10) { // the waiting push is parked, and charged
		t.Fatalf("in use %d", b.inUse())
	}
	q2.pop(ctx)
	q1.pop(ctx)
	if err := <-pushed; err != nil {
		t.Fatal(err)
	}
	q1.close()
	q2.close()
	if b.inUse() != 0 {
		t.Fatalf("closed queues still hold %d", b.inUse())
	}
}

// A popped message stays charged until done; close releases what was queued.
func TestBudgetInFlight(t *testing.T) {
	b := newBudget(1 << 20)
	q := newQueue(1<<20, b)
	ctx := testCtx(t)
	q.push(ctx, make([]byte, 10))
	q.push(ctx, make([]byte, 20))
	it, err := q.popItem(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if b.inUse() != c(10)+c(20) {
		t.Fatalf("in use %d", b.inUse())
	}
	q.done(it)
	q.close()
	if b.inUse() != 0 {
		t.Fatalf("in use %d after close", b.inUse())
	}
	if q.items != nil {
		t.Fatal("close kept the items")
	}
}
