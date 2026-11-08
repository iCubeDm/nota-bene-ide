package relay

import (
	"context"
	"testing"
	"time"
)

func TestQueueBlocksAtLimit(t *testing.T) {
	q := newQueue(10)
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
	q := newQueue(4)
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
	q := newQueue(1)
	ctx, cancel := context.WithTimeout(testCtx(t), 50*time.Millisecond)
	defer cancel()
	if _, err := q.pop(ctx); err != context.DeadlineExceeded {
		t.Fatalf("pop on empty: %v", err)
	}
}

func TestQueueClose(t *testing.T) {
	q := newQueue(2)
	ctx := testCtx(t)
	q.push(ctx, []byte{1, 2})
	push := make(chan error, 1)
	go func() { push <- q.push(ctx, []byte{3}) }()
	q2 := newQueue(2)
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
	q := newQueue(2)
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
	q := newQueue(10)
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
		err = q.pushSlow(ctx, make([]byte, 4), nil, 100*time.Millisecond)
		if time.Since(start) > 3*time.Second {
			t.Fatal("never told the queue stayed full")
		}
	}
	if err != errSlow {
		t.Fatalf("got %v", err)
	}
}
