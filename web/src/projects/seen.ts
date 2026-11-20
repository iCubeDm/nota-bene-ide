// The page tells its window that the person saw the open session (POST /seen): while the page is visible and focused, at
// once, on gaining focus, and when a turn ends. The window counts the replies after that as unseen in the projects list.
import { useEffect } from 'react';
import { useStore } from 'react-redux';
import type { Store } from 'redux';
import { connections, routes, type RootState } from '@/sdk';

const GAP_MS = 2000;
type Feedish = { feed: { turnSeq: number; session: { id: string | null } | null } };

export function startSeen(store: Pick<Store<Feedish>, 'getState' | 'subscribe'>, doc: Document, win: Window, post: (session: string) => void): () => void {
  const looked = () => !doc.hidden && doc.hasFocus();
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mark = () => {
    const id = store.getState().feed.session?.id;
    if (!id || !looked()) return;
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) {
      // within the gap: once at its end, so the last turn is never left unseen
      timer ??= setTimeout(() => { timer = undefined; mark(); }, wait);
      return;
    }
    last = Date.now();
    post(id);
  };
  let seq = store.getState().feed.turnSeq;
  let session = store.getState().feed.session?.id ?? null;
  const unsub = store.subscribe(() => {
    const f = store.getState().feed;
    const id = f.session?.id ?? null;
    if (f.turnSeq === seq && id === session) return;
    seq = f.turnSeq;
    session = id;
    mark();
  });
  win.addEventListener('focus', mark);
  doc.addEventListener('visibilitychange', mark);
  mark();
  return () => {
    unsub();
    if (timer !== undefined) clearTimeout(timer);
    win.removeEventListener('focus', mark);
    doc.removeEventListener('visibilitychange', mark);
  };
}

const postSeen = (session: string) => {
  void connections.current().fetch(routes.seen(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session }) }).catch(() => {});
};

export function useSeen(): void {
  const store = useStore<RootState>();
  useEffect(() => startSeen(store, document, window, postSeen), [store]);
}
