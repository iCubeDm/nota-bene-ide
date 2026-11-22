import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startFold, type FoldOptions } from './fold.ts';

// Epic 383, step 2c: a window from before one server (alone, idle, no tab) hands its folder to the server below it and ends.

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function fold(over: Partial<FoldOptions> = {}) {
  const asked: unknown[] = [];
  let stopped = 0;
  const st = { quiet: true };
  const o: FoldOptions = {
    port: 4778, everyMs: 1000,
    quiet: () => st.quiet,
    what: () => ({ root: '/w/notes', provider: 'claude', session: '11111111-1111-4111-8111-111111111111' }),
    attach: async (ask) => { asked.push(ask); return { port: 4777, agent: 'claude-abcdef', opened: true, shown: false, url: 'u' }; },
    stop: () => { stopped++; },
    ...over,
  };
  const off = startFold(o);
  return { asked, st, off, stopped: () => stopped };
}

it('quiet for two looks in a row: the folder opens in the server below, resuming its session, then the window ends', async () => {
  const f = fold();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.asked).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.asked).toEqual([{ root: '/w/notes', provider: 'claude', mode: 'resume', session: '11111111-1111-4111-8111-111111111111', show: false, under: 4778 }]);
  expect(f.stopped()).toBe(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.asked).toHaveLength(1);
});

it('a tab, a turn or another agent in between starts the count over; no server below: it stays', async () => {
  const f = fold();
  await vi.advanceTimersByTimeAsync(1000);
  f.st.quiet = false;
  await vi.advanceTimersByTimeAsync(1000);
  f.st.quiet = true;
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.asked).toEqual([]);
  f.off();
  const none = fold({ attach: async () => null });
  await vi.advanceTimersByTimeAsync(2000);
  expect(none.stopped()).toBe(0);
  none.off();
});

it('no session yet: it stays (its unsent comments live only here); a refusal is tried again later', async () => {
  const f = fold({ what: () => ({ root: '/w/notes', provider: 'codex' }) });
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.asked).toEqual([]);
  expect(f.stopped()).toBe(0);
  f.off();
  let n = 0;
  const bad = fold({ attach: async () => { n++; throw new Error('no such folder'); } });
  await vi.advanceTimersByTimeAsync(4000);
  expect(n).toBeGreaterThan(1);
  expect(bad.stopped()).toBe(0);
  bad.off();
});

it('a tab that came while the folder was handed over: the window ends all the same (the session is below now)', async () => {
  const f = fold({ attach: async (ask) => { f2.st.quiet = false; return { port: 4777, agent: 'claude-abcdef', opened: true, shown: false, url: String(ask.root) }; } });
  const f2 = f;
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.stopped()).toBe(1);
});
