import { configureStore, createAction, createListenerMiddleware, createSlice, type Middleware, type ThunkAction, type UnknownAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector, useStore, type TypedUseSelectorHook } from 'react-redux';
import type { ImageRef, ServerEvent, Voice } from '@nota-bene/shared';
import { dictationAsk } from '../voice/lang.ts';
import { agentConnection, bindConnections, connectionManager, SELF, type AgentConnection, type AgentId, type Connect, type ConnectionManager, type ConnState } from '../sdk/connections.ts';
import { t } from '../i18n/index.ts';
import { composerSlice } from '../composer/slice.ts';
import { refusedMiddleware } from '../composer/refused.ts';
import { historyMiddleware, historySlice } from '../composer/history.ts';
import { controlsListener, controlsSlice } from '../controls/slice.ts';
import { commentsSlice, flushComments } from '../comments/slice.ts';
import { activate, tabsSlice, type Tab, type TabsState } from '../tabs/slice.ts';
import { AUDIO, VIDEO } from '../files/kinds.ts';
import { browserPip, MediaController, type PipApi } from '../media/mediaController.ts';
import { filesSlice } from '../files/slice.ts';
import { markupSlice } from '../media/markup/slice.ts';
import { treeSlice } from '../tree/slice.ts';
import { statsSlice } from '../stats/slice.ts';
import { remoteSlice } from '../remote/slice.ts';
import { tasksSlice, tasksUiSlice } from '../tasks/slice.ts';
import { agentName, itemsOf, subagentsSlice } from '../subagent/slice.ts';
import { toast } from '../shell/toast.ts';
import { recordCompactMs } from '../feed/compactTiming.ts';
import { feedUiSlice, TOOL_SRC } from '../feed/uiSlice.ts';
import { adoptHello } from '../sdk/storage.ts';
import { setTmpDirs } from '../files/tmpImages.ts';
import { learnServerSep } from '../lib/paths.ts';
import { persistListeners, type PersistState } from './persist.ts';
import { emptyFeed, historyPrepended, prependHistory, reduce, type FeedState } from './feed.ts';

/** A live compaction's duration feeds the estimate of the next one (a replay is history: it would count twice). */
const compactTimingMiddleware: Middleware = () => (next) => (action) => {
  if (serverEvent.match(action) && action.payload.kind === 'agent') {
    const e = action.payload.e;
    if (e.t === 'compacted' && e.ms) recordCompactMs(e.ms);
  }
  return next(action);
};

/** A server error is a toast (R-M4-5), never a feed item. A middleware, not a reducer: reducers have no side effects. */
const toastMiddleware: Middleware = () => (next) => (action) => {
  // not `busy`: the server broadcasts those refusals to every window, and a race outcome is not a server error (the asking control shows it inline)
  if (serverEvent.match(action) && action.payload.kind === 'server-error' && action.payload.where !== 'busy') {
    // a warning the server names by `where` is shown in the page's language, not as the server's English text
    if (action.payload.where === 'git-bash') toast(t('gitBashTitle'), t('gitBashMissing'));
    else toast(t('serverError', action.payload.where), action.payload.message);
  }
  return next(action);
};

/** The only way server data enters the store; `meta.agent` names the connection it came from (reducers ignore it until issue 383). */
export const serverEvent = createAction('server/event', (ev: ServerEvent, agent: AgentId = SELF) => ({ payload: ev, meta: { agent } }));
export const connState = createAction<ConnState>('conn/state');

// reduce() is pure and returns a new object. Returning a new state from an Immer case reducer is
// allowed, so we hand it the draft cast to FeedState: reduce only reads it and spreads/slices
// (never mutates), and Immer drops the draft when a new value is returned. No current() needed.
export const feedSlice = createSlice({
  name: 'feed',
  initialState: emptyFeed,
  reducers: {},
  extraReducers: (b) => b
    .addCase(serverEvent, (state, a) => reduce(state as FeedState, a.payload))
    // an archived segment (R-M7-4): not a server event, so no other slice (tasks, controls, comments) ever sees it
    .addCase(historyPrepended, (state, a) => prependHistory(state as FeedState, a.payload)),
});

export type { ConnState };

export const connSlice = createSlice({
  name: 'conn',
  initialState: { state: 'connecting' as ConnState },
  reducers: {},
  extraReducers: (b) => b.addCase(connState, (_s, a) => ({ state: a.payload })),
});

type Extra = { connections: ConnectionManager };

/** Whether Redux DevTools are on: dev builds only. Read at call time so tests can stub it. */
export const devToolsEnabled = (): boolean => import.meta.env.DEV;

const mediaByStore = new WeakMap<object, MediaController>();

/**
 * Tells the media controller about every tab change, whatever caused it (tab click, openFile, close actions, restore):
 * removed tabs go to onClose first, then a changed active tab to onSwitch. It runs right after the reducer, inside the
 * dispatch, so before React renders the new pane, and still inside the click's user activation (PiP needs one).
 */
const mediaMiddleware = (media: MediaController): Middleware => (api) => {
  // diffed against the last tabs it reported, not the state before this action, so a change is reported once however
  // the dispatches nest. The persistence listener (enterRoot on a new root) sits outside this middleware: it dispatches
  // after the triggering action has come back through here, so that restore is its own pass, never nested in this one
  let seen: TabsState | null = null;
  return (next) => (action) => {
    seen ??= (api.getState() as { tabs: TabsState }).tabs;
    const result = next(action);
    const after = (api.getState() as { tabs: TabsState }).tabs;
    const before = seen;
    if (after !== before) {
      seen = after;
      // another root (not the first one): every old file tab is closed, even one whose id the new root's tabs share
      const rerooted = before.root !== null && after.root !== before.root;
      const kept = new Set<string>(rerooted ? ['chat'] : after.open.map((t) => t.id));
      for (const t of before.open) if (!kept.has(t.id)) media.onClose(t.id);
      if (after.active !== before.active) media.onSwitch(before.active, after.active);
    }
    return result;
  };
};

/**
 * Creates the store and its connection manager with exactly one connection (SELF). The connection lives only in this
 * closure (reached by thunks through the thunk `extra` argument), never in Redux state: it is not serializable; the store
 * mirrors its state into the `conn` slice.
 */
export function makeStore(o: {
  url: string;
  connect?: Connect;
  pip?: PipApi;
}) {
  const conns: AgentConnection[] = [];
  const connections = connectionManager(() => conns);
  // one media controller per store; it holds DOM elements, so it lives here and not in state (components reach it via useMedia)
  const media: MediaController = new MediaController({
    pip: o.pip ?? browserPip,
    activate: (id) => store.dispatch(activate(id as Tab['id'])),
    // video and audio only: an image has nothing to pause
    isMedia: (id) => {
      const tab = store.getState().tabs.open.find((t) => t.id === id);
      return tab?.kind === 'file' && (VIDEO.test(tab.path) || AUDIO.test(tab.path));
    },
  });
  const persist = createListenerMiddleware<PersistState>();
  persistListeners(persist);
  const store = configureStore({
    reducer: { feed: feedSlice.reducer, conn: connSlice.reducer, comments: commentsSlice.reducer, composer: composerSlice.reducer, tabs: tabsSlice.reducer, tree: treeSlice.reducer, files: filesSlice.reducer, controls: controlsSlice.reducer, stats: statsSlice.reducer, remote: remoteSlice.reducer, tasks: tasksSlice.reducer, tasksUi: tasksUiSlice.reducer, markup: markupSlice.reducer, feedUi: feedUiSlice.reducer, subagents: subagentsSlice.reducer, promptHistory: historySlice.reducer },
    middleware: (gdm) => gdm({ thunk: { extraArgument: { connections } satisfies Extra } }).prepend(controlsListener.middleware, persist.middleware).concat(toastMiddleware, compactTimingMiddleware, refusedMiddleware, historyMiddleware, mediaMiddleware(media)),
    devTools: devToolsEnabled(),
  });
  mediaByStore.set(store, media);
  bindConnections(store, connections);
  const self = agentConnection({
    id: SELF,
    base: '',
    url: o.url,
    ...(o.connect ? { connect: o.connect } : {}),
    deliver: (ev) => {
      if (ev.kind === 'hello') adoptHello(ev);
      // the server's separator, for paths in agent text (lib/paths.ts serverSep): from its first absolute path
      if (ev.kind === 'hello') learnServerSep(ev.tmpDirs?.[0]);
      if (ev.kind === 'session') learnServerSep(ev.root);
      if (ev.kind === 'hello') setTmpDirs(ev.tmpDirs);
      store.dispatch(serverEvent(ev, SELF));
      // protocol 19: another window changed or deleted the comment first, so this change was not made
      if (ev.kind === 'comment-refused' && ev.reason !== 'failed') toast(t('commentChangedElsewhere'), '');
      // the next queued comment change goes once the server is known (hello) and the previous one is answered
      if (ev.kind === 'hello' || ev.kind === 'comments' || ev.kind === 'comment-ack' || ev.kind === 'comment-refused') store.dispatch(flushComments());
    },
    mirror: (s) => {
      store.dispatch(connState(s));
      if (s === 'open') store.dispatch(flushComments());
    },
  });
  conns.push(self);
  self.open();
  return store;
}

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
export type AppThunk<R = void> = ThunkAction<R, RootState, Extra, UnknownAction>;

export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
export const useAppDispatch: () => AppDispatch = useDispatch;
/** The store's media controller (see makeStore). */
export const useMedia = (): MediaController => mediaByStore.get(useStore())!;

export const selectFeed = (s: RootState): FeedState => s.feed;
export const selectBusy = (s: RootState): boolean => s.feed.busy;
export const selectConn = (s: RootState): ConnState => s.conn.state;
export const selectTurnSeq = (s: RootState): number => s.feed.turnSeq;
export const selectSession = (s: RootState) => s.feed.session;

export const sendMessage =
  (text: string, force: boolean, commentIds?: string[], images?: ImageRef[], id: string = crypto.randomUUID(), voice?: Voice): AppThunk<boolean> =>
  (_d, getState, { connections }) => {
    const st = getState();
    if (selectConn(st) !== 'open') return false;
    return connections.current().send({
      type: 'send', id, text, force: force && selectBusy(st),
      ...(commentIds?.length ? { commentIds } : {}),
      ...(images?.length ? { images } : {}),
      ...(voice ? { voice: { id: voice.id, ms: voice.ms, wave: voice.wave }, ...dictationAsk(st) } : {}),
    });
  };

export const interrupt = (): AppThunk => (_d, getState, { connections }) => {
  if (selectBusy(getState())) connections.current().send({ type: 'interrupt' });
};

/** «Работать здесь»: take the window over from the other tab (R-M7-5/8). */
export const takeOver = (): AppThunk => (_d, _g, { connections }) => connections.current().takeOver();

export const answerPermission = (id: string, allow: boolean, response?: import('@nota-bene/shared').InteractionAnswer): AppThunk => (_d, _g, { connections }) => {
  connections.current().send({ type: 'permission', id, allow, ...(response ? { response } : {}) });
};

const ARG_CUT = 60;

/**
 * Where a comment's source sits: "reply #n" for a FINAL assistant item (n = 1-based among final
 * assistant items in feed order), "my message" for a user item, "<name> command (arg)" for an action, null otherwise; `plain` (the batch text) names a reply just "reply", no number. The feed keeps no time per assistant
 * item, so the " · time" part of `reply` is dropped rather than invented.
 */
export const selectReplyLabel = (s: RootState, messageId: string, plain = false, agent?: string): string | null => {
  if (agent) return agentLabel(s, messageId, agent);
  if (messageId.startsWith(TOOL_SRC)) {
    // an agent action's command or output (R-M7-20): "Bash command (npm test)", the arg cut to 60 characters
    const id = messageId.slice(TOOL_SRC.length);
    const it = s.feed.items.find((x) => x.kind === 'tool' && x.id === id);
    if (it?.kind !== 'tool') return null;
    return t('srcTool', it.name, it.arg.length > ARG_CUT ? `${it.arg.slice(0, ARG_CUT)}…` : it.arg);
  }
  if (messageId.startsWith('plan:')) return s.feed.items.some((it) => it.kind === 'permission' && `plan:${it.id}` === messageId) ? t('mode_plan') : null;
  let n = 0;
  for (const it of s.feed.items) {
    if (it.kind === 'assistant' && it.final) n++;
    if ((it.kind === 'assistant' || it.kind === 'user') && it.id === messageId) {
      if (it.kind === 'user') return t('srcMine');
      if (!it.final) return null;
      return plain ? t('replyPlain') : t('reply', n, '').replace(/\s*·\s*$/, '');
    }
  }
  return null;
};

/**
 * The label of a place inside a subagent's conversation (no numbers, like the plain `reply`; the quote is the locator):
 * "subagent reply «description»", and for an action "Bash command (npm test) · subagent «description»". An action the
 * conversation does not (yet) hold is unknown (null); a reply is named even before the conversation is loaded, so a
 * batch never calls it a chat message.
 */
function agentLabel(s: RootState, messageId: string, agent: string): string | null {
  const name = agentName(s, agent);
  if (messageId.startsWith(TOOL_SRC)) {
    const id = messageId.slice(TOOL_SRC.length);
    // not loaded (a reload with the tab closed): the same call forwarded into the chat names it, if it is there
    const it = (itemsOf(s, agent) ?? s.feed.items).find((x) => x.kind === 'tool' && x.id === id);
    if (it?.kind !== 'tool') return null;
    return t('srcAgentTool', t('srcTool', it.name, it.arg.length > ARG_CUT ? `${it.arg.slice(0, ARG_CUT)}…` : it.arg), name);
  }
  return t('srcAgentReply', name);
}
