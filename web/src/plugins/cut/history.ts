// The editor's undo and redo (issue 409): the edits before and after the one shown. Pure; the values are never copied.

export type History<T> = { past: T[]; now: T; future: T[] };

export const start = <T,>(now: T): History<T> => ({ past: [], now, future: [] });

/** `next` as a new step (the steps undone are gone); the same value is none. At most `keep` steps back. */
export function commit<T>(h: History<T>, next: T, keep = 200): History<T> {
  if (next === h.now) return h;
  return { past: [...h.past, h.now].slice(-keep), now: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), now: h.past[h.past.length - 1]!, future: [h.now, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.now], now: h.future[0]!, future: h.future.slice(1) };
}
