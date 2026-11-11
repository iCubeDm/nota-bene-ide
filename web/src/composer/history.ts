import { createSlice, type Middleware, type PayloadAction } from '@reduxjs/toolkit';
import { fuzzyScore, PROMPT_MAX, type PromptEntry, type PromptSrc } from '@nota-bene/shared';
import { apiFetch } from '../net/auth.ts';
import { serverEvent, type AppThunk, type RootState } from '../store/store.ts';
import type { SentDraft, ShellDraft } from './slice.ts';

/** The prompts this session has taken, oldest first (the server keeps them: `/prompts`); `sid` is the session they belong to. */
type State = { sid: string | null; items: PromptEntry[] };

export const historySlice = createSlice({
  name: 'promptHistory',
  initialState: { sid: null, items: [] } as State,
  reducers: {
    // a new session's history is another one; the first id of a session with none yet keeps what was sent before it
    sessionChanged: (s, a: PayloadAction<string | null>) => {
      if (a.payload === s.sid) return;
      if (s.sid !== null || a.payload === null) s.items = [];
      s.sid = a.payload;
    },
    // the stored list first, then whatever was sent here that it does not have yet (a POST still in flight)
    loaded: (s, a: PayloadAction<PromptEntry[]>) => {
      const have = new Set(a.payload.map((x) => x.id));
      s.items = [...a.payload, ...s.items.filter((x) => !have.has(x.id))];
    },
    appended: (s, a: PayloadAction<PromptEntry>) => void (s.items.some((x) => x.id === a.payload.id) || s.items.push(a.payload)),
  },
});

export const selectPromptItems = (s: RootState): PromptEntry[] => s.promptHistory.items;
export const selectPromptSid = (s: RootState): string | null => s.promptHistory.sid;

/** Newest first, a prompt repeated right after itself once: what ↑ walks through. */
export function recallList(items: PromptEntry[]): PromptEntry[] {
  const out: PromptEntry[] = [];
  for (let i = items.length - 1; i >= 0; i--) if (out[out.length - 1]?.text !== items[i]!.text) out.push(items[i]!);
  return out;
}

/** Newest first, each text once (its newest copy): the list of the history dropdown. */
export function distinctList(items: PromptEntry[]): PromptEntry[] {
  const seen = new Set<string>();
  const out: PromptEntry[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (seen.has(items[i]!.text)) continue;
    seen.add(items[i]!.text);
    out.push(items[i]!);
  }
  return out;
}

/** the search list of the dropdown holds at most this many */
export const SEARCH_MAX = 30;

/**
 * The dropdown's list: no query = every distinct prompt, newest first; with one, the prompts that contain it (newest first),
 * then the ones it is a scattered subsequence of (best score first). Prose is long, so no length penalty in the score.
 */
export function searchPrompts(items: PromptEntry[], query: string): PromptEntry[] {
  const all = distinctList(items);
  const q = query.trim().toLowerCase();
  if (!q) return all;
  const exact = all.filter((x) => x.text.toLowerCase().includes(q));
  const have = new Set(exact.map((x) => x.id));
  const fuzzy = all
    .filter((x) => !have.has(x.id))
    .map((x) => [x, fuzzyScore(x.text, q, { penalty: 0 })] as const)
    .filter(([, sc]) => sc >= 0)
    .sort((a, b) => b[1] - a[1])
    .map(([x]) => x);
  return [...exact, ...fuzzy].slice(0, SEARCH_MAX);
}

const warn = (what: string, e: unknown) => console.warn(`prompt history: ${what}`, e);

/** Asks the server for the session's stored prompts; an answer for a session that is not the current one any more is dropped. */
export const loadHistory = (): AppThunk => (d, getState) => {
  const sid = getState().promptHistory.sid;
  apiFetch(sid === null ? '/prompts' : `/prompts?session=${encodeURIComponent(sid)}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ prompts: PromptEntry[] }>) : Promise.reject(new Error(`/prompts ${r.status}`))))
    .then((body) => { if (getState().promptHistory.sid === sid) d(historySlice.actions.loaded(body.prompts)); })
    .catch((e: unknown) => warn('load failed', e));
};

/** Shows the entry at once and tells the server in the background (a failure only logs: the list is a convenience). */
const record = (entry: Omit<PromptEntry, 'ts'>): AppThunk => (d, getState) => {
  if (!entry.text.trim() || entry.text.length > PROMPT_MAX) return;
  const full: PromptEntry = { ...entry, ts: Date.now() };
  const session = getState().feed.session?.id ?? null;
  d(historySlice.actions.appended(full));
  apiFetch('/prompts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, id: full.id, text: full.text, src: full.src }) })
    .then((r) => { if (!r.ok) warn('save failed', r.status); })
    .catch((e: unknown) => warn('save failed', e));
};

type Slice = { composer: { unconfirmed: SentDraft | null; shellUnconfirmed: ShellDraft | null } };

/**
 * Records a prompt once the server has taken it: the typed draft on its `user` echo, a `! cmd` on `shell-start` (both read
 * before the composer's reducer drops them), a voice message on its live `voice-text`. A replayed event is history, not a
 * new prompt. A new session id (or a replay) reloads the stored list.
 */
export const historyMiddleware: Middleware = (api) => (next) => (action) => {
  if (!serverEvent.match(action)) return next(action);
  const ev = action.payload;
  const c = (api.getState() as Slice).composer;
  const dispatch = api.dispatch as (a: unknown) => void;
  if (ev.kind === 'user' && c.unconfirmed?.id === ev.id) dispatch(record({ id: ev.id, text: c.unconfirmed.text, src: 'typed' }));
  else if (ev.kind === 'shell-start' && c.shellUnconfirmed?.id === ev.id) dispatch(record({ id: ev.id, text: c.shellUnconfirmed.draft, src: 'shell' as PromptSrc }));
  else if (ev.kind === 'voice-text' && ev.text) dispatch(record({ id: ev.id, text: ev.text, src: 'voice' }));
  const result = next(action);
  if (ev.kind === 'session' || ev.kind === 'replay') {
    const st = api.getState() as RootState;
    const id = st.feed.session?.id ?? null;
    if (id !== st.promptHistory.sid) dispatch(historySlice.actions.sessionChanged(id));
    if (id !== null) dispatch(loadHistory());
  }
  return result;
};
