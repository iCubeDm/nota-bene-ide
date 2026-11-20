import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compactOrder } from './compactOrder.ts';

let dir: string;
beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-order-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** one server process: its pause state, its pending restart, and what reached the agent, in order */
function server(st = { busy: true, restart: false, switching: false }, o: { send?: (text: string) => void; session?: () => string } = {}) {
  const agent: string[] = [];
  const changed = vi.fn();
  const reported: unknown[] = [];
  const order = compactOrder({
    dir, session: o.session ?? (() => 's1'), busy: () => st.busy, switching: () => st.switching, restartPending: () => st.restart,
    compact: (text) => { agent.push(text); st.busy = true; }, // its turn runs at once
    send: (m) => { o.send?.(m.text); agent.push(m.text); }, changed, report: (e) => void reported.push(e), everyMs: 100,
  });
  order.enter('s1');
  return { order, st, agent, changed, reported };
}
const msg = (id: string) => ({ id, text: id, ts: 1 });

describe('compactOrder', () => {
  it('idle: the order compacts at once, nothing stays pending or on disk', () => {
    const { order, agent } = server({ busy: false, restart: false, switching: false });
    order.order('/compact');
    expect(agent).toEqual(['/compact']);
    expect(order.view()).toEqual({ pending: false, held: [] });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('busy: pending until the pause; ordering again changes nothing; the held sends go after the compaction\'s turn', async () => {
    const { order, st, agent, changed } = server();
    order.order('/compact');
    order.order('/compact');
    expect(changed).toHaveBeenCalledTimes(1); // the one order (an empty start says nothing)
    expect(order.holding()).toBe(true);
    order.hold(msg('m1'));
    order.hold(msg('m2'));
    expect(order.view()).toEqual({ pending: true, held: [msg('m1'), msg('m2')] });
    await vi.advanceTimersByTimeAsync(500);
    expect(agent).toEqual([]);
    st.busy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(agent).toEqual(['/compact']); // and the compaction's turn is running
    await vi.advanceTimersByTimeAsync(500);
    expect(agent).toEqual(['/compact']);
    st.busy = false; // the compaction ended
    await vi.advanceTimersByTimeAsync(100);
    expect(agent).toEqual(['/compact', 'm1', 'm2']);
    expect(order.holding()).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('restart > compact > messages: the restart fires first, the next process compacts and then sends', async () => {
    const a = server({ busy: true, restart: true, switching: false });
    a.order.hold(msg('m1')); // held behind the restart alone
    a.order.order('/compact');
    a.order.hold(msg('m2'));
    a.st.busy = false; // the pause: the restart goes, never the compaction
    await vi.advanceTimersByTimeAsync(500);
    expect(a.agent).toEqual([]);
    a.order.stop(); // the process exits 75
    expect(JSON.parse(fs.readFileSync(path.join(dir, 's1.json'), 'utf8'))).toMatchObject({ compact: '/compact', held: [{ id: 'm1' }, { id: 'm2' }] });

    // the relaunch resumes s1 (a new SessionManager, a new order over the same folder); the start is a pause
    const b = server({ busy: false, restart: false, switching: false });
    expect(b.agent).toEqual(['/compact']);
    await vi.advanceTimersByTimeAsync(300);
    expect(b.agent).toEqual(['/compact']);
    b.st.busy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(b.agent).toEqual(['/compact', 'm1', 'm2']);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a pending restart alone holds the sends; after it they go at once', async () => {
    const a = server({ busy: true, restart: true, switching: false });
    a.order.hold(msg('m1'));
    expect(a.order.view()).toEqual({ pending: false, held: [msg('m1')] });
    a.order.stop();
    const b = server({ busy: false, restart: false, switching: false });
    expect(b.agent).toEqual(['m1']);
  });

  it('cancel: the held sends go, also mid-turn (as a send would have); with a restart still pending they wait for it', async () => {
    const { order, st, agent } = server({ busy: true, restart: true, switching: false });
    order.order('/compact');
    order.hold(msg('m1'));
    expect(order.cancel()).toBe(true);
    expect(order.cancel()).toBe(false);
    expect(agent).toEqual([]); // the restart is still pending
    st.restart = false;
    order.check(); // the restart was cancelled
    expect(agent).toEqual(['m1']);
    expect(order.view()).toEqual({ pending: false, held: [] });
  });

  it('a switch is no pause; another session has its own record, and the first one goes on when it is back', async () => {
    const { order, st, agent } = server();
    order.order('/compact');
    order.hold(msg('m1'));
    st.switching = true;
    st.busy = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(agent).toEqual([]);
    order.enter('s2'); // the switch went to s2
    st.switching = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(agent).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(['s1.json']);
  });

  it('the instructions of a typed /compact are kept, also across a restart', () => {
    const a = server();
    a.order.order('/compact keep the API notes');
    a.order.stop();
    const b = server({ busy: false, restart: false, switching: false });
    expect(b.agent).toEqual(['/compact keep the API notes']);
  });

  it('while the ordered compaction itself runs, a send waits for its end; ordering again then changes nothing', async () => {
    const { order, st, agent } = server();
    order.order('/compact');
    st.busy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(agent).toEqual(['/compact']);
    expect(order.holding()).toBe(true);
    order.order('/compact');
    order.hold(msg('m1'));
    await vi.advanceTimersByTimeAsync(300);
    expect(agent).toEqual(['/compact']);
    st.busy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(agent).toEqual(['/compact', 'm1']);
    expect(order.holding()).toBe(false);
  });

  it('a send that throws is reported; the others still go', async () => {
    const { order, st, agent, reported } = server({ busy: true, restart: false, switching: false }, { send: (t) => { if (t === 'm1') throw new Error('no agent'); } });
    order.order('/compact');
    order.hold(msg('m1'));
    order.hold(msg('m2'));
    order.cancel();
    expect(agent).toEqual(['m2']);
    expect(reported).toHaveLength(1);
    void st;
  });

  it('a switch away and back: the record stayed with its session and goes on there', async () => {
    let id = 's1';
    const { order, st, agent } = server({ busy: true, restart: false, switching: false }, { session: () => id });
    order.order('/compact');
    order.hold(msg('m1'));
    id = 's2';
    order.enter('s2');
    expect(order.view()).toEqual({ pending: false, held: [] });
    id = 's1';
    order.enter('s1');
    expect(order.view()).toEqual({ pending: true, held: [msg('m1')] });
    st.busy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(agent).toEqual(['/compact']);
  });

  it('a corrupted record is dropped; forget removes a deleted session\'s record', () => {
    fs.writeFileSync(path.join(dir, 's1.json'), '{nope');
    const { order } = server();
    expect(order.view()).toEqual({ pending: false, held: [] });
    expect(fs.readdirSync(dir)).toEqual([]);
    order.order('/compact');
    expect(fs.readdirSync(dir)).toEqual(['s1.json']);
    order.forget('s3');
    expect(fs.readdirSync(dir)).toEqual(['s1.json']);
    order.forget('s1');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
