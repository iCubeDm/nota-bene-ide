import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStore } from 'redux';
import { startSeen } from './seen.ts';

const A = '11111111-1111-4111-8111-111111111111';
type S = { feed: { turnSeq: number; session: { id: string | null } | null } };

function rig(o: { hidden?: boolean; focus?: boolean; session?: string | null } = {}) {
  let state: S = { feed: { turnSeq: 0, session: o.session === undefined ? { id: A } : o.session === null ? null : { id: o.session } } };
  const store = createStore((s: S = state, a: { type: string; s?: S }) => (a.type === 'set' ? a.s! : s));
  const set = (f: (s: S) => S) => { state = f(state); store.dispatch({ type: 'set', s: state }); };
  const doc = Object.assign(new EventTarget(), { hidden: o.hidden ?? false, hasFocus: () => focus }) as unknown as Document & { hidden: boolean };
  let focus = o.focus ?? true;
  const win = new EventTarget() as unknown as Window;
  const post = vi.fn();
  const stop = startSeen(store as never, doc, win, post);
  return { set, doc, win, post, stop, focusOn: (f: boolean) => { focus = f; } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('a visible, focused page marks its session at once', () => {
  const r = rig();
  expect(r.post).toHaveBeenCalledWith(A);
});

it('a hidden page or one without focus marks nothing; gaining focus marks', () => {
  const r = rig({ focus: false });
  r.set((s) => ({ feed: { ...s.feed, turnSeq: 1 } }));
  expect(r.post).not.toHaveBeenCalled();
  r.focusOn(true);
  r.win.dispatchEvent(new Event('focus'));
  expect(r.post).toHaveBeenCalledTimes(1);
  const h = rig({ hidden: true });
  h.set((s) => ({ feed: { ...s.feed, turnSeq: 1 } }));
  expect(h.post).not.toHaveBeenCalled();
});

it('a turn that ends while the page is looked at is marked, at most once per two seconds, the last one never lost', () => {
  const r = rig();
  r.post.mockClear();
  vi.advanceTimersByTime(2500);
  r.set((s) => ({ feed: { ...s.feed, turnSeq: 1 } }));
  expect(r.post).toHaveBeenCalledTimes(1);
  r.set((s) => ({ feed: { ...s.feed, turnSeq: 2 } }));
  expect(r.post).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(2000);
  expect(r.post).toHaveBeenCalledTimes(2);
});

it('no session, nothing to mark', () => {
  const r = rig({ session: null });
  r.win.dispatchEvent(new Event('focus'));
  expect(r.post).not.toHaveBeenCalled();
});
