// The composer's draft is the server's, per session (issue 174): every client of the window shows the open session's
// draft, the last write to arrive wins (no merge, no revision: one socket's frames are ordered).
import { isAnyOf } from '@reduxjs/toolkit';
import { DRAFT_MAX, has, type ClientMessage, type DraftImage, type ServerEvent } from '@nota-bene/shared';
import { addImage, imagesApplied, removeImage, serverEvent, type AppThunk, type RootState, type StartListening } from '@/sdk';
import { draftApplied, draftEdited, draftSynced, draftWritten, flushDraft, setDraft, type DraftSync } from './slice.ts';

type DraftEvent = Extract<ServerEvent, { kind: 'draft' }>;

/** at most one write this often, the first of a burst at once and the last after it */
export const DRAFT_THROTTLE_MS = 300;

/**
 * What a `draft` event does to this client: the sync after it, whether its text and images replace the local ones, and
 * `owed`: the session a dirty text is written to before it goes (a scope change). The receive side needs no feature
 * check: the event proves the server has drafts.
 * - its own echo (`ack` = pending): the wait ends, the text stays, so the typing client's caret never moves;
 * - the same session (or the first event): applied only while clean, otherwise this client's next write wins;
 * - from an id-less session to an id: as the same session, retagged (an adoption carries the adopted draft, which
 *   may lag the last keystrokes; a dirty text then goes under the new id);
 * - to another session (a switch, a /clear, a fork, from any client): a dirty text goes to the old session first (kept
 *   here when it cannot go, a text over DRAFT_MAX); a text typed in this client's switch stays and goes to the new one.
 * An event without `ack` is the server's state, not someone's write: it ends a wait no ack will answer (a write that
 * reached the server in another client's failed switch).
 */
export function received(s: DraftSync, ev: DraftEvent, switching: boolean): { sync: DraftSync; apply: boolean; owed?: string | null } {
  if (ev.ack !== undefined && ev.ack === s.pending) return { sync: { ...s, scope: ev.sessionId, pending: null }, apply: false };
  const state = ev.ack === undefined;
  if (s.scope === undefined || s.scope === null || ev.sessionId === s.scope) {
    return {
      sync: { ...s, scope: ev.sessionId, ...(state ? { pending: null } : {}), ...(state && !switching ? { typedInSwitch: false } : {}) },
      apply: s.pending === null && !s.dirty,
    };
  }
  if (s.typedInSwitch) return { sync: { scope: ev.sessionId, pending: null, dirty: true, typedInSwitch: false }, apply: false };
  return { sync: { scope: ev.sessionId, pending: null, dirty: false, typedInSwitch: false }, apply: true, ...(s.dirty ? { owed: s.scope } : {}) };
}

const local = (st: RootState): { text: string; images: DraftImage[] } =>
  ({ text: st.composer.draft, images: st.message.images.map(({ id, mediaType }) => ({ id, mediaType })) });

/** The write's id, or null when it did not go (offline, or a text over DRAFT_MAX: it stays on this client). */
function put(connection: { send(m: ClientMessage): boolean }, sessionId: string | null, d: ReturnType<typeof local>): string | null {
  if (d.text.length > DRAFT_MAX) return null;
  const id = crypto.randomUUID();
  return connection.send({ type: 'draft', id, sessionId, text: d.text, ...(d.images.length ? { images: d.images } : {}) }) ? id : null;
}

/** Writes the local edits, when there are some and they may go: a server of protocol 40, no switch of this client. */
export const writeDraft = (): AppThunk<boolean> => (d, getState, { connection }) => {
  const st = getState();
  const s = st.composer.sync;
  if (!s.dirty || s.typedInSwitch || st.controls.switching || !has(st.controls.protocol, 'draft')) return false;
  const id = put(connection, s.scope ?? null, local(st));
  if (id) d(draftWritten(id));
  return id !== null;
};

const receive = (ev: DraftEvent): AppThunk => (d, getState, { connection }) => {
  const st = getState();
  const r = received(st.composer.sync, ev, st.controls.switching !== null);
  // lands in the old session, with no echo; one that cannot go (over DRAFT_MAX) stays here rather than vanish
  if (r.owed !== undefined && put(connection, r.owed, local(st)) === null) {
    d(draftSynced({ ...r.sync, dirty: true }));
    return;
  }
  d(draftSynced(r.sync));
  if (!r.apply) return;
  d(draftApplied(ev.text));
  d(imagesApplied(ev.images ?? []));
};

/** The composer plugin's listeners: local edits, their throttled writes and flushes, and the server's drafts. */
export function draftListeners(start: StartListening): void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  type Api = { dispatch: (t: AppThunk<boolean>) => boolean; getState: () => RootState };
  const flush = (api: Api) => {
    clearTimeout(timer);
    timer = undefined;
    if (api.dispatch(writeDraft())) last = Date.now();
  };
  const soon = (api: Api) => {
    if (timer !== undefined || !api.getState().composer.sync.dirty) return;
    const wait = last + DRAFT_THROTTLE_MS - Date.now();
    if (wait <= 0) flush(api);
    else timer = setTimeout(() => flush(api), wait);
  };
  start({
    matcher: isAnyOf(setDraft, addImage, removeImage),
    effect: (_a, api) => {
      // a restart (the agent's or the server's) stays on its session: nothing typed in it waits for another
      const { switching, restarting } = api.getState().controls;
      api.dispatch(draftEdited({ inSwitch: switching !== null && !restarting }));
      soon(api);
    },
  });
  start({ actionCreator: flushDraft, effect: (_a, api) => flush(api) });
  start({
    actionCreator: serverEvent,
    effect: ({ payload: ev }, api) => {
      if (ev.kind === 'draft') {
        api.dispatch(receive(ev));
        soon(api);
      }
      // what was typed offline, or before the attach draft, goes now (an older server takes none)
      if (ev.kind === 'hello') flush(api);
    },
  });
  // this client's switch ended: the edits it held may go (to the new session, once its draft has come)
  start({ predicate: (_a, st, was) => was.controls.switching !== null && st.controls.switching === null, effect: (_a, api) => soon(api) });
}
