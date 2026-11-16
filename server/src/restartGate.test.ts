import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTART, restartGate } from './restartGate.ts';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function make(o: { busy?: boolean; tabs?: number } = {}) {
  const st = { busy: o.busy ?? false, tabs: o.tabs ?? 0 };
  const exit = vi.fn();
  const changed = vi.fn();
  const g = restartGate({ busy: () => st.busy, tabs: () => st.tabs, exit, changed, everyMs: 1000 });
  return { g, st, exit, changed };
}

describe('restartGate', () => {
  it('idle: the request is for now, nothing pending', () => {
    const { g, exit, changed } = make();
    expect(g.request()).toBe('now');
    expect(g.pending()).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled(); // the caller exits once its reply is out
  });

  it('busy: pending; with no page open the server exits 75 at the next pause by itself', async () => {
    const { g, st, exit, changed } = make({ busy: true });
    expect(g.request()).toBe('pending');
    expect(g.pending()).toBe(true);
    expect(changed).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).not.toHaveBeenCalled();
    st.busy = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledWith(RESTART);
    expect(exit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a second request while pending stays pending', () => {
    const { g } = make({ busy: true });
    g.request();
    expect(g.request()).toBe('pending');
  });

  it('with a page open the server waits for the page to ask in a pause', async () => {
    const { g, st, exit } = make({ busy: true, tabs: 1 });
    g.request();
    expect(g.pause()).toBe('busy');
    st.busy = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).not.toHaveBeenCalled();
    expect(g.pause()).toBe('ok');
    expect(exit).not.toHaveBeenCalled(); // the exit waits for the reply
    g.replied();
    expect(exit).toHaveBeenCalledWith(RESTART);
  });

  it('a send between the accepted ask and its reply keeps the restart pending for the next pause', () => {
    const { g, st, exit, changed } = make({ busy: true, tabs: 1 });
    g.request();
    st.busy = false;
    expect(g.pause()).toBe('ok');
    st.busy = true;
    changed.mockClear();
    g.replied();
    expect(exit).not.toHaveBeenCalled();
    expect(g.pending()).toBe(true);
    expect(changed).toHaveBeenCalledWith(true); // told again: the asking page leaves its restarting state
    st.busy = false;
    expect(g.pause()).toBe('ok');
    g.replied();
    expect(exit).toHaveBeenCalledWith(RESTART);
  });

  it('pause with nothing pending is none', () => {
    const { g } = make();
    expect(g.pause()).toBe('none');
  });

  it('cancel: no exit at the pause, the change is told', async () => {
    const { g, st, exit, changed } = make({ busy: true });
    g.request();
    expect(g.cancel()).toBe(true);
    expect(g.pending()).toBe(false);
    expect(changed).toHaveBeenLastCalledWith(false);
    st.busy = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).not.toHaveBeenCalled();
    expect(g.cancel()).toBe(false);
  });
});
