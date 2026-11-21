// The subagents' conversations (issue 545): the subagent plugin reads them, the comments name and find their sources in
// them, the tasks see their calls' results. Core, not the subagent plugin's: plugins never import each other.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { SubagentView } from '@nota-bene/shared';
import { emptyFeed, reduce, type FeedItem, type FeedState } from './feed.ts';
import { openAgent } from '../tabs/slice.ts';
import type { AppThunk, RootState } from './store.ts';

/**
 * Subagent conversations (M2 step 1), by the tool-use id of the Agent call that started each. Fetched whole from
 * `GET /subagent` and reduced from an empty feed by the same pure `reduce()` as the main chat; kept apart from the main
 * `feed` slice, which they never touch. `session`: the conversation they were read for (an entry of another session is
 * not shown). `status`: loading (first fetch, nothing yet), ok, gone (404 / 409: not in this session), error.
 */
type SubagentEntry = {
  tool: string; session: string; status: 'loading' | 'ok' | 'gone' | 'error';
  feed: FeedState; running: boolean; type: string; description: string; error?: string;
  /** what the last accepted answer looked like: an identical refetch changes nothing (no re-render, no repaint) */
  sig: string;
};
type SubagentsState = { byTool: Record<string, SubagentEntry> };

const sigOf = (v: SubagentView): string => `${v.events.length}|${v.running}|${JSON.stringify(v.events[v.events.length - 1] ?? null)}`;
const blank = (tool: string, session: string): SubagentEntry => ({ tool, session, status: 'loading', feed: emptyFeed, running: false, type: '', description: '', sig: '' });

type Who = { tool: string; session: string };

export const subagentsSlice = createSlice({
  name: 'subagents',
  initialState: { byTool: {} } as SubagentsState,
  reducers: {
    /** A fetch starts: a first one (or one for another session) makes the entry; a refetch keeps what is shown. */
    requested: (s, a: PayloadAction<Who>) => {
      const cur = s.byTool[a.payload.tool];
      if (!cur || cur.session !== a.payload.session) s.byTool[a.payload.tool] = blank(a.payload.tool, a.payload.session);
    },
    loaded: (s, a: PayloadAction<Who & { view: SubagentView }>) => {
      const { tool, session, view } = a.payload;
      const cur = s.byTool[tool];
      if (!cur || cur.session !== session) return; // answered for a conversation that is no longer the entry's
      const sig = sigOf(view);
      if (cur.status === 'ok' && cur.sig === sig) return;
      s.byTool[tool] = {
        tool, session, status: 'ok', sig, running: view.running, type: view.type, description: view.description,
        feed: view.events.reduce(reduce, emptyFeed),
      };
    },
    failed: (s, a: PayloadAction<Who & { status: 'gone' | 'error'; error?: string }>) => {
      const { tool, session, status, error } = a.payload;
      const cur = s.byTool[tool];
      if (!cur || cur.session !== session) return;
      s.byTool[tool] = { ...cur, status, ...(error ? { error } : {}) }; // sig kept: the same answer later is no change
    },
  },
});

export const { requested: subagentRequested, loaded: subagentLoaded, failed: subagentFailed } = subagentsSlice.actions;

/** The entry for the CURRENT conversation; undefined when none was fetched for it. */
export const selectSubagent = (s: RootState, tool: string): SubagentEntry | undefined => {
  const e = s.subagents.byTool[tool];
  return e && e.session === s.feed.session?.id ? e : undefined;
};

/** The feed items a message source lives in: the main chat's, or a loaded subagent's (null: that subagent is not loaded). */
export const itemsOf = (s: RootState, agent?: string): FeedItem[] | null => {
  if (!agent) return s.feed.items;
  const e = selectSubagent(s, agent);
  // a failed poll keeps what was read: its comment cards must not turn into orphans for a network blip
  return e && (e.status === 'ok' || (e.status === 'error' && e.feed.items.length > 0)) ? e.feed.items : null;
};

/** What names a subagent in a batch line or a tab: its description, else the tab's title, else its type. */
export const agentName = (s: RootState, tool: string): string => {
  const e = selectSubagent(s, tool);
  if (e?.description) return e.description;
  const tab = s.tabs.open.find((t) => t.kind === 'agent' && t.tool === tool);
  if (tab?.kind === 'agent' && tab.title) return tab.title;
  // after a reload with the tab closed: the call itself is in the replayed chat (or in its parent subagent's feed)
  const call = s.feed.items.find((it) => it.kind === 'tool' && it.id === tool);
  const d = call?.kind === 'tool' ? call.input.description : undefined;
  return (typeof d === 'string' && d) || e?.type || '';
};

/** Opens (or shows) a subagent's tab by its Agent call's id, named by what is known of it (a jump from a comment card). */
export const openSubagentTab = (tool: string): AppThunk => (d, getState) => {
  d(openAgent({ tool, title: agentName(getState(), tool) }));
};
