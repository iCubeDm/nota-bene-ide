// The SDK of issue 511: the only core module a plugin imports (beside @/sdk/ui). Re-exports by name, so the surface a
// plugin sees is this one file. Leaf modules come first: the order here is the order they are evaluated in.

// translations and toasts
export { t, tIn, useT, getLang, setLang, chooseLang, LANGS, type Lang } from '../i18n/index.ts';
export { dismissToast, toast } from '../shell/toast.ts';

// storage
export { storage, useStored, bool, string, json, type Stored, type Sounds } from './storage.ts';

// the frame's prefs: theme, scale, sounds
export { theme, THEME_GROUPS, THEME_NAMES, useTheme } from '../shell/theme.ts';
export { uiScale, useUiScale } from '../shell/uiScale.ts';
export { playCue } from '../shell/sounds.ts';

// helpers
export { num, compact, compactParts, percent, money, byteSize, ago } from '../lib/format.ts';
export { folderName, shortWinHome, shortHome } from '../lib/paths.ts';
export { keysInScope } from '../lib/keyScope.ts';
export { editable } from '../lib/editable.ts';
export { setValueAndCaret, insertPaths, AT_RE } from '../lib/insertText.ts';
export { ComposerFieldContext, useComposerField } from './composerField.ts';
export { useAutosize } from '../lib/autosize.ts';
export { placeListFor, revealSelected } from '../lib/placeList.ts';
export { useNote, REFUSED } from '../lib/useNote.ts';
export { PATHS_MIME, draggedPaths, hasFiles, downloadUrl } from '../lib/drag.ts';
export { prepareImage, uploadImage, encodeImage, mediaTypeOf } from '../lib/image.ts';
export { useFocusWithin } from '../shell/focusWithin.ts';
export { useOnHome } from '../shell/Slots.tsx';
export { landingSession } from '../net/auth.ts';
export { makeAnchor } from '../anchors/resolve.ts';
export { textOf, collapsedLength, rawIndexOf, offsetsOf, rangeForAnchor } from '../anchors/text.ts';
export { QUICK_LABELS, labelsFor, labelText, labelOf, instructionOf } from '../anchors/labels.ts';
export { anchorLine, batchQuote, mediaTime, cutWhere, cutLine } from '../anchors/quote.ts';

// the connection
export {
  connection,
  useFeature,
  selectFeature,
  type Route,
} from './connections.ts';
export { routes } from './routes.ts';
export { defineResource, send, useResource, repository, pageVisible } from './repository.ts';
export { SettingsContext, useSettings, systemPrefs, type SettingsHost } from './settings.ts';

// where the project's files are: their kinds and URLs, the sources they are read from, the temp images, a media tab's start
export { HTML, kindOf, fileUrl, projectFileUrl, headVersion, type FileKind } from '../refs/kinds.ts';
export { useSources, loadSources, sourcesKnown, refOf, srcIdOfRef, isCommitRef, isFixed, fileKey } from '../refs/sources.ts';
export { isTmpTabPath, tmpImageUrl, tmpImagePathsIn, fetchTmpImage, type TmpLoad } from '../refs/tmpImages.ts';
export { setStartAt, takeStartAt, type StartAt } from '../refs/startAt.ts';
// what Markdown lets through of untrusted text
export { HARDEN } from '../components/markdown/harden.ts';

// this page: another computer's window, or on the window's own computer
export { remotePage, isLocalPage } from '../net/local.ts';

// keys
export { withKey, withKeys, keysFor, keysLabel, modKey, isMac } from '../shell/keymap.ts';

// paths in agent text
export { escapeMentions, refClick, fileOfImage, openMediaFile, clearRefCache } from '../refs/refs.ts';

// a rendered page's frame, carried across for the anchors (its text root, rects and selection), and scrolling to an anchor
export { outOf, rangeRects, rangeRect, pageRoot, textRootOf, pageSelection, clearPageSelections, pageRendered, usePageGen } from '../anchors/frame.ts';
export { itemsBox, itemRoots, itemRootOf } from '../anchors/items.ts';
export { scrollRangeIntoView, scrollRectIntoView, revealRangeSideways } from '../anchors/scroll.ts';

// the store, the feed model and chat
export { definePlugin, type Plugin, type PluginState } from './plugin.ts';
export { historyPrepended, retriedVoice, ARG_KEYS, isAgentTool, TOOL_SRC, toolSrcId, type FeedItem, type FeedState, type HistoryPage } from '../store/feed.ts';
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
  useService,
  refusedWhy,
  type RootState,
  type AppThunk,
  type AppDispatch,
  type AppStore,
  type StartListening,
} from '../store/store.ts';

// the agent's session-wide state: mode, model, commands, hello, a switch or restart, held sends
export {
  dictationSet, dictationLangSet, dictationAsk, planApproved, controlsListeners,
  selectMode, selectSuggestion, selectCapabilitiesKnown, selectCapabilities, selectSwitching, selectRestarting, selectRestartPending,
  selectCompactPending, selectHeld, selectOrderWaits, selectCanOrderCompact, selectModel, selectModels, selectCommands,
  selectModelSwitchable, selectIdleCompact, selectTmpDirs, pickMode, pickModel, toggleIdleCompact, nextMode, reportActivity, runCommand,
  switchSession, restartAgent, stopWindow, restartServer, restartInPause, cancelCompact, cancelRestart, type SwitchResult,
} from '../store/controls.ts';

// the images of the message being written
export { addImage, removeImage, markAttachment, uploadStarted, uploadFinished, selectImages, selectUploading, selectBuilding, selectMarking } from '../store/message.ts';

// the agent's usage figures and its background tasks
export { selectStats } from '../store/stats.ts';
export { selectLiveCalls, selectCallEnd } from '../store/tasks.ts';
// the subagents' conversations
export { selectSubagent, itemsOf, agentName, openSubagentTab, subagentRequested, subagentLoaded, subagentFailed } from '../store/subagents.ts';

export { seekAndPause } from '../store/mediaController.ts';
export { usePagePause } from '../shell/pagePause.ts';
export { SEEK_STEPS, seekStep, useSeekStep, type SeekStepValue } from '../store/seekStep.ts';
export { applyPlayerKey, inPlayerScope, ONCE, THEIRS, PLAYER_HELP, type Flash } from '../store/playerKeys.ts';
export { brief, renameSession, archiveSession, deleteSession, sessionsResource, type SessionsView, type SessionRow } from '../store/sessions.ts';

import { answerPermission, interrupt, takeOver } from '../store/store.ts';
import { send as sendChat } from '../store/send.ts';
export { sendCount, sendWaiting } from '../store/send.ts';

/** The chat's thunks. The store reaches no module that loads this one, so its bindings exist when this runs. */
export const chat = { send: sendChat, interrupt, answer: answerPermission, takeOver };

// tabs
export {
  openFile, openAgent, openShell, openDiagram, openView, activate,
  setAgentTitle, selectTabs, selectActiveTab, enterRoot, fileTabId, type TabKinds, type ViewTab, type AgentTab, type SavedFile, type DiagramLang,
} from '../tabs/slice.ts';
export { requestJump, clearJump, dropJump, selectJump } from '../tabs/jump.ts';
export { feedRenderer, anchorView, type Registry, type AnchorView, type TabView, type Slot, type SlotName, type Command, type Mods, type AnyFeedRenderer, type Held, type ToolRenderer, type UserPart, type FileView, type SettingsSection, type SendPart, type Taken, type TextFileView, type MediaFileView, type FileBar, type PendingComment, type ImageEntry, type MediaComment, type MediaAnchorPatch, type Services, type CodeBlock, type TreeAction } from './registry.ts';
