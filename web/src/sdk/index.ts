// The SDK of issue 511: the only core module a plugin imports (beside @/sdk/ui). Re-exports by name, so the surface a
// plugin sees is this one file. Leaf modules come first: the order here is the order they are evaluated in.

// translations and toasts
export { t, tIn, useT, getLang, setLang, chooseLang, LANGS, type Lang, type I18nKey } from '../i18n/index.ts';
export { toast } from '../shell/toast.ts';
export { reloadPage } from '../shell/reloadPage.ts';

// storage, flags and usage events
export { storage, useStored, bool, string, json, oneOf, type Codec, type Stored, type Pref, type SharedPrefs, type Sounds } from './storage.ts';
export { flag, useFlag, FLAGS, type Flag } from './flags.ts';
export { track, type TrackProps } from './track.ts';

// helpers
export { num, compact, compactParts, percent, money, byteSize } from '../lib/format.ts';
export { serverSep, isDrivePath, isServerDrivePath, wireAbs, underDir, folderName, shortWinHome, shortHome } from '../lib/paths.ts';
export { keysInScope } from '../lib/keyScope.ts';
export { editable } from '../lib/editable.ts';
export { useFocusWithin } from '../shell/focusWithin.ts';
export { makeAnchor } from '../anchors/resolve.ts';
export { textOf, collapsedLength, rawIndexOf, offsetsOf, rangeForAnchor } from '../anchors/text.ts';
export { anchorLine, batchQuote, describeShape, mediaTime, mediaLine, cutWhere, cutQuote, cutLine, pageQuote, pageLines } from '../anchors/quote.ts';

// the connection
export { has, type Feature } from '@nota-bene/shared';
export {
  SELF,
  connections,
  useConnection,
  useConnState,
  useFeature,
  type AgentId,
  type AgentConnection,
  type ConnectionManager,
  type ConnState,
  type HelloEvent,
  type Route,
} from './connections.ts';
export { routes } from './routes.ts';
export { defineResource, useResource, repository, pageVisible, type Resource, type Snapshot } from './repository.ts';

// keys
export { withKey, withKeys, keyLabel, keysLabel, modKey, isMac } from '../shell/keymap.ts';

// core modules that still import plugins (later steps of issue 511 cut those edges)
export { scrollRangeIntoView, scrollRectIntoView, revealRangeSideways } from '../anchors/scroll.ts';
export { markRefs, markMentions, escapeMentions, refClick, fileOfImage, openMediaFile, clearRefCache } from '../refs/refs.ts';

// the store, the feed model and chat
export { definePlugin, type Plugin, type PluginState } from './plugin.ts';
export { emptyFeed, reduce, historyPrepended, retriedVoice, ARG_KEYS, isAgentTool, TOOL_SRC, toolSrcId, type FeedItem, type FeedState, type HistoryPage } from '../store/feed.ts';
export {
  useAppSelector,
  useAppDispatch,
  useMedia,
  serverEvent,
  connState,
  selectConn,
  selectFeed,
  selectBusy,
  selectSession,
  selectTurnSeq,
  useRegistry,
  refusedWhy,
  type RootState,
  type AppThunk,
  type AppDispatch,
  type AppStore,
  type StartListening,
  type VoiceSend,
} from '../store/store.ts';

export { seekAndPause, type MediaController, type PipApi } from '../store/mediaController.ts';
export { usePagePause } from '../shell/pagePause.ts';

import { answerPermission, interrupt, sendMessage, takeOver } from '../store/store.ts';

/**
 * The chat's thunks. Each one calls through: this module may be evaluated inside the store module's import cycle (a
 * plugin the store imports imports the SDK), before those bindings exist.
 */
export const chat = {
  send: (...a: Parameters<typeof sendMessage>) => sendMessage(...a),
  interrupt: () => interrupt(),
  answer: (...a: Parameters<typeof answerPermission>) => answerPermission(...a),
  takeOver: () => takeOver(),
};

// tabs
export { openFile, openAgent, activate, closeTab, selectTabs, enterRoot, type Tab, type TabKinds, type DiagramLang } from '../tabs/slice.ts';
export { feedRenderer, type TabView, type Slot, type SlotName, type Command, type KeyId, type Mods, type FeedRenderer, type AnyFeedRenderer, type FeedKind, type Held, type ToolRenderer, type ToolItem, type UserPart } from './registry.ts';
