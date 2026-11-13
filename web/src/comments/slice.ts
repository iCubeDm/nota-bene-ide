import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { anchorSource, isMediaAnchor, type Comment, type CommentOp, type MediaAnchor } from '@nota-bene/shared';
import { fileKey } from '../files/sources.ts';
// store.ts imports this file for the reducer; every use of serverEvent below is lazy (inside callbacks), so the cycle is safe.
import { connState, serverEvent, type AppThunk, type RootState } from '../store/store.ts';

export type CommentCard = { id: string; x: number; y: number };
/** a local change on its way to the server (protocol 19): it shows at once and is sent until the server acks or refuses it */
export type QueuedOp = { opId: string; sessionId: string | null; ops: CommentOp[] };
/** the server that takes comment ops */
export const OPS_PROTOCOL = 19;
export type CommentsState = {
  /** what the user sees: the server's set with the queued changes of this session on top */
  items: Comment[];
  /** protocol 19 (from `hello`): changes go as ops; before it, as the whole set */
  ops: boolean;
  /** the server's set as last received, and the session it belongs to */
  server: Comment[]; sessionId: string | null;
  /**
   * local changes the server has not acked, oldest first. All go on the wire at once (`wired`: sent on this socket): the
   * socket keeps their order, every op may be applied twice, and a message sent after them finds them applied
   */
  queue: QueuedOp[]; wired: string[]; /** a local change the server has not received */ unsynced: boolean; /** local set re-sent on reconnect; the server's initial (stale) push is still to come and must be ignored once */ resent: boolean; /** ids handed to the socket whose `comments` echo has not arrived yet (client-only; keeps a double send out) */ sendingIds: string[]; ui: { panelOpen: boolean; card: CommentCard | null } };

const readPanelOpen = (): boolean => {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem('panel:comments') !== '0';
  } catch {
    return true; // storage unavailable: the default, open
  }
};

export const commentsSlice = createSlice({
  name: 'comments',
  initialState: (): CommentsState => ({ items: [], ops: false, server: [], sessionId: null, queue: [], wired: [], unsynced: false, resent: false, sendingIds: [], ui: { panelOpen: readPanelOpen(), card: null } }),
  reducers: {
    setItems: (s, a: PayloadAction<Comment[]>) => void (s.items = a.payload),
    markSending: (s, a: PayloadAction<string[]>) => void (s.sendingIds = [...s.sendingIds, ...a.payload]),
    unmarkSending: (s, a: PayloadAction<string[]>) => void (s.sendingIds = s.sendingIds.filter((id) => !a.payload.includes(id))),
    setUnsynced: (s, a: PayloadAction<boolean>) => void (s.unsynced = a.payload),
    enqueue: (s, a: PayloadAction<QueuedOp>) => void ((s.queue = [...s.queue, a.payload]), (s.items = view(s))),
    setWired: (s, a: PayloadAction<string[]>) => void (s.wired = [...s.wired, ...a.payload]),
    markResent: (s) => void ((s.unsynced = false), (s.resent = true)),
    setPanelOpen: (s, a: PayloadAction<boolean>) => void (s.ui.panelOpen = a.payload),
    openCommentCard: (s, a: PayloadAction<CommentCard>) => void (s.ui.card = a.payload),
    closeCommentCard: (s) => void (s.ui.card = null),
  },
  // only a `comments` event replaces items; `replay` must not clear them (the server sends replay first)
  extraReducers: (b) =>
    b.addCase(connState, (s, a) => {
      if (a.payload === 'open') return;
      s.sendingIds = []; // the in-flight send may be lost with the socket
      s.wired = []; // the ops too: they are sent again on the next open (ops are idempotent)
      if (a.payload === 'occupied' || a.payload === 'taken') {
        // another tab owns the window and its comments are authoritative: our offline edits are dropped, so the attach
        // after a takeover resyncs nothing and adopts the server's set
        s.unsynced = false;
        s.resent = false;
        return;
      }
      // the re-send was never confirmed (its stale initial push did not arrive): it may be lost too, so send it again next open
      if (s.resent) { s.resent = false; s.unsynced = true; }
    }).addCase(serverEvent, (s, a) => {
      const ev = a.payload;
      if (ev.kind === 'hello') {
        s.ops = ev.protocol >= OPS_PROTOCOL;
        if (s.ops && !s.unsynced) s.items = view(s);
        if (!s.ops && s.queue.length) {
          // an older server after all (a downgrade): what is queued goes as the whole set, as before protocol 19
          s.items = view(s);
          s.queue = [];
          s.wired = [];
          s.unsynced = true;
        }
        return;
      }
      if (ev.kind === 'session') {
        s.sessionId = ev.id;
        s.items = s.ops ? view(s) : s.items;
        return;
      }
      if (ev.kind === 'comment-ack' || ev.kind === 'comment-refused') {
        // gone or sent: another window changed the comment first, and this change is dropped (the store toasts it);
        // failed: the server could not store it, so it stays queued, and stays wired until the next open (sent again
        // at once, it would be refused again in a loop)
        if (ev.kind === 'comment-refused' && ev.reason === 'failed') return;
        s.queue = s.queue.filter((o) => o.opId !== ev.opId);
        s.wired = s.wired.filter((id) => id !== ev.opId);
        s.items = view(s);
        return;
      }
      // the set arrives before `hello`, so it is kept whatever the protocol turns out to be
      if (ev.kind === 'comments') s.server = ev.items;
      if (ev.kind === 'comments' && s.ops && !s.unsynced) {
        // one socket delivers in order, so the latest set is the server's; the queued changes stay on top of it
        if (ev.ack?.length) s.queue = s.queue.filter((o) => !ev.ack!.includes(o.opId));
        s.items = view(s);
        const items = s.items;
        s.sendingIds = s.sendingIds.filter((id) => items.find((c) => c.id === id)?.status === 'pending');
        return;
      }
      if (a.payload.kind === 'comments') {
        // drop an id once the echo shows it sent or gone; a foreign echo that still lists it as pending keeps it in flight
        const items = a.payload.items;
        s.sendingIds = s.sendingIds.filter((id) => items.find((c) => c.id === id)?.status === 'pending');
      }
      // while unsynced, local offline edits win; they are re-sent on reconnect (resyncComments)
      if (a.payload.kind !== 'comments') return;
      if (s.unsynced) return;
      if (s.resent) { s.resent = false; return; } // the server's initial push predates our re-send: stale, skip it once
      s.items = a.payload.items;
    }),
});

export const { markSending, unmarkSending, setPanelOpen, openCommentCard, closeCommentCard } = commentsSlice.actions;

/**
 * The server's set with the queued changes of the shown session on top. An op made before the session had an id
 * (null) is the current session's: the server applies it there.
 */
function view(s: Pick<CommentsState, 'server' | 'queue' | 'sessionId'>): Comment[] {
  let items = s.server;
  for (const q of s.queue) {
    if (q.sessionId !== null && q.sessionId !== s.sessionId) continue;
    for (const o of q.ops) items = fold(items, o);
  }
  return items;
}
function fold(items: Comment[], o: CommentOp): Comment[] {
  if (o.op === 'remove') return items.filter((c) => c.id !== o.id);
  const at = items.findIndex((c) => c.id === o.comment.id);
  if (o.op === 'add') return at < 0 ? [...items, o.comment] : items;
  return at < 0 || items[at]!.status === 'sent' ? items : items.map((c, i) => (i === at ? o.comment : c));
}

/** Sends the queued changes not on the wire yet, in order (protocol 19); an offline whole set goes first. */
export const flushComments = (): AppThunk => (d, getState, { send }) => {
  const st = getState().comments;
  // a whole set changed offline before the server was known to take ops goes first, as a whole set (a 19 server merges it)
  if (st.unsynced || !st.ops) d(resyncComments());
  if (!st.ops) return;
  const wired: string[] = [];
  for (const q of st.queue) {
    if (st.wired.includes(q.opId)) continue;
    if (!send({ type: 'comment-op', opId: q.opId, sessionId: q.sessionId, ops: q.ops })) break;
    wired.push(q.opId);
  }
  if (wired.length) d(commentsSlice.actions.setWired(wired));
};

/** A local change: queued as an op for a protocol-19 server, else the whole set as before. */
const change = (op: CommentOp, items: Comment[]): AppThunk => (d, getState) => {
  if (!getState().comments.ops) return void d(sync(items));
  d(commentsSlice.actions.enqueue({ opId: crypto.randomUUID(), sessionId: getState().feed.session?.id ?? null, ops: [op] }));
  d(flushComments());
};

/** Update locally first, then send the FULL set; a closed socket keeps the local change for the next sync. */
// Accepted race: two edits within one round trip can see the first echo overwrite the second locally until the second echo lands.
const sync = (items: Comment[]): AppThunk => (d, getState, { send }) => {
  d(commentsSlice.actions.setItems(items));
  d(commentsSlice.actions.setUnsynced(!send({ type: 'comments', sessionId: getState().feed.session?.id ?? null, items })));
};

/** On socket open: re-send local changes made while offline (local wins; last-writer-wins between windows is accepted). */
export const resyncComments = (): AppThunk => (d, getState, { send }) => {
  const st = getState().comments;
  if (st.unsynced && send({ type: 'comments', sessionId: getState().feed.session?.id ?? null, items: st.items })) d(commentsSlice.actions.markResent());
};

/** `id`: caller-given (a media comment's mark folder is named by it, so it exists before the comment); else a fresh one. */
export const addComment = (c: Omit<Comment, 'id' | 'status' | 'createdAt'> & { id?: string }): AppThunk => (d, getState) => {
  const next: Comment = { ...c, id: c.id ?? crypto.randomUUID(), status: 'pending', createdAt: Date.now() };
  d(change({ op: 'add', comment: next }, [...selectComments(getState()), next]));
};

export const editComment = (id: string, text: string): AppThunk => (d, getState) => {
  const items = selectComments(getState()).map((c) => (c.id === id ? { ...c, text } : c));
  const edited = items.find((c) => c.id === id);
  if (edited) d(change({ op: 'edit', comment: edited }, items));
};

export const removeComment = (id: string): AppThunk => (d, getState) => {
  d(change({ op: 'remove', id }, selectComments(getState()).filter((c) => c.id !== id)));
};

export const selectComments = (s: RootState): Comment[] => s.comments.items;
export const selectCommentsUi = (s: RootState) => s.comments.ui;
const EMPTY: Comment[] = Object.freeze([]) as unknown as Comment[];
const selectSendingIds = (s: RootState) => s.comments.sendingIds;
/** Pending and not already on the wire. */
export const selectPending = createSelector([selectComments, selectSendingIds], (items, sending) =>
  items.filter((c) => c.status === 'pending' && !sending.includes(c.id)));
const selectSentByMessage = createSelector([selectComments], (items) => {
  const m: Record<string, Comment[]> = {};
  for (const c of items) if (c.status === 'sent' && c.sentIn !== undefined) (m[c.sentIn] ??= []).push(c);
  return m;
});
export const selectSentFor = (s: RootState, messageId: string): Comment[] => selectSentByMessage(s)[messageId] ?? EMPTY;

/** Pending comments per file, keyed by `fileKey(path, ref)` (the path alone in this folder). */
export const selectPendingCountByPath = createSelector([selectComments], (items) => {
  const m: Record<string, number> = {};
  for (const c of items) {
    const src = anchorSource(c.anchor);
    if (c.status !== 'pending' || src?.kind !== 'file') continue;
    const k = fileKey(src.path, src.ref);
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
});

export type MediaComment = Comment & { anchor: MediaAnchor };
/** The media comments on one file of one source (`ref` only for another source), in store order. Memoised per (path, ref). */
export const selectMediaComments = createSelector(
  [selectComments, (_s: RootState, path: string) => path, (_s: RootState, _p: string, ref?: string) => ref ?? ''],
  (items, path, ref): MediaComment[] =>
    items.filter((c): c is MediaComment => isMediaAnchor(c.anchor) && c.anchor.source.path === path && (c.anchor.source.ref ?? '') === ref),
);
