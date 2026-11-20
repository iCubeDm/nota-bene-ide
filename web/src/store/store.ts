import { combineSlices, configureStore, createAction, createListenerMiddleware, createSlice, type Middleware, type Reducer, type ThunkAction, type ThunkDispatch, type TypedStartListening, type UnknownAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector, useStore, type TypedUseSelectorHook } from 'react-redux';
import type { ImageRef, ServerEvent, Voice } from '@nota-bene/shared';
import { dictationAsk } from '../voice/lang.ts';
import { agentConnection, bindConnections, connectionManager, SELF, type AgentConnection, type AgentId, type Connect, type ConnectionManager, type ConnState } from '../sdk/connections.ts';
import { t } from '../i18n/index.ts';
import { activate, tabsSlice, type Tab, type TabsState } from '../tabs/slice.ts';
import { AUDIO, VIDEO } from '../files/kinds.ts';
import { browserPip, MediaController, type PipApi } from '../media/mediaController.ts';
import { agentName, itemsOf } from '../subagent/slice.ts';
import { toast } from '../shell/toast.ts';
import { TOOL_SRC } from '../feed/uiSlice.ts';
import { adoptHello } from '../sdk/storage.ts';
import type { Plugin, PluginState } from '../sdk/plugin.ts';
import { learnServerSep } from '../lib/paths.ts';
import { persistListeners } from './persist.ts';
import { emptyFeed, historyPrepended, prependHistory, reduce, type FeedState } from './feed.ts';

/** A server error is a toast (R-M4-5), never a feed item. A middleware, not a reducer: reducers have no side effects. */
export const toastMiddleware: Middleware = () => (next) => (action) => {
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

/** The core's slices; the plugins' are injected by makeStore. */
const coreReducer = () => combineSlices(feedSlice, connSlice, tabsSlice).withLazyLoadedSlices<PluginState>();
export type RootState = ReturnType<ReturnType<typeof coreReducer>> & PluginState;
/** How a listener (`Plugin.listeners`) registers on the store's one listener middleware. */
export type StartListening = TypedStartListening<RootState, ThunkDispatch<RootState, Extra, UnknownAction>>;

/** The reducer of the core and every plugin's slices, each injected once. A slice name taken twice is a build error. */
function rootReducer(plugins: readonly Plugin[]): Reducer<RootState> {
  const reducer = coreReducer();
  const names = new Set<string>([feedSlice.reducerPath, connSlice.reducerPath, tabsSlice.reducerPath]);
  for (const s of plugins.flatMap((p) => p.slices ?? [])) {
    if (names.has(s.reducerPath)) throw new Error(`store: the slice "${s.reducerPath}" is declared twice`);
    names.add(s.reducerPath);
    reducer.inject(s);
  }
  // every PluginState slice is present from the first state on: injected before the store exists
  return reducer as Reducer<RootState>;
}

/** Whether Redux DevTools are on: dev builds only. Read at call time so tests can stub it. */
export const devToolsEnabled = (): boolean => import.meta.env.DEV;

const mediaByStore = new WeakMap<object, MediaController>();
const pluginsByStore = new WeakMap<object, readonly Plugin[]>();

/**
 * The middleware appended after the defaults, in order (behavior: each sees an action before the ones after it): the
 * core's toast, each plugin's in `PLUGINS` order, the core's media last. The one listener middleware is prepended, so
 * its listeners run once all of these have passed the action on.
 */
export const middlewareOf = (plugins: readonly Plugin[], media: Middleware): Middleware[] =>
  [toastMiddleware, ...plugins.flatMap((p) => p.middleware ?? []), media];

/**
 * Tells the media controller about every tab change, whatever caused it (tab click, openFile, close actions, restore):
 * removed tabs go to onClose first, then a changed active tab to onSwitch. It runs right after the reducer, inside the
 * dispatch, so before React renders the new pane, and still inside the click's user activation (PiP needs one).
 */
const mediaMiddleware = (media: MediaController): Middleware => (api) => {
  // diffed against the last tabs it reported, not the state before this action, so a change is reported once however
  // the dispatches nest. The root-change listener (enterRoot on a new root) sits outside this middleware: it dispatches
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
 * mirrors its state into the `conn` slice. `plugins`: the app's `PLUGINS`. A test may pass a subset, but `RootState`
 * still names every plugin's slice: a subset suits only code that reads the core's state and that subset's.
 */
export function makeStore(o: {
  url: string;
  plugins: readonly Plugin[];
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
  // one listener middleware: the core's listeners first, then each plugin's in order (see Plugin.listeners)
  const listeners = createListenerMiddleware<RootState, ThunkDispatch<RootState, Extra, UnknownAction>>();
  persistListeners(listeners.startListening);
  for (const p of o.plugins) p.listeners?.(listeners.startListening);
  const store = configureStore({
    reducer: rootReducer(o.plugins),
    middleware: (gdm) => gdm({ thunk: { extraArgument: { connections } satisfies Extra } }).prepend(listeners.middleware).concat(...middlewareOf(o.plugins, mediaMiddleware(media))),
    devTools: devToolsEnabled(),
  });
  mediaByStore.set(store, media);
  pluginsByStore.set(store, o.plugins);
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
      store.dispatch(serverEvent(ev, SELF));
    },
    mirror: (s) => store.dispatch(connState(s)),
  });
  conns.push(self);
  self.open();
  return store;
}

export type AppStore = ReturnType<typeof makeStore>;
export type AppDispatch = AppStore['dispatch'];
export type AppThunk<R = void> = ThunkAction<R, RootState, Extra, UnknownAction>;

export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
export const useAppDispatch: () => AppDispatch = useDispatch;
/** The store's media controller (see makeStore). */
export const useMedia = (): MediaController => mediaByStore.get(useStore())!;
/** The plugins the store was made with, in order. */
export const usePlugins = (): readonly Plugin[] => pluginsByStore.get(useStore())!;

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
