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

// the frame's prefs: theme, scale, sounds
export { theme, THEME_GROUPS, THEME_NAMES, useTheme } from '../shell/theme.ts';
export { uiScale, useUiScale } from '../shell/uiScale.ts';
export { playCue } from '../shell/sounds.ts';

// helpers
export { num, compact, compactParts, percent, money, byteSize, ago } from '../lib/format.ts';
export { serverSep, isDrivePath, isServerDrivePath, wireAbs, underDir, folderName, shortWinHome, shortHome } from '../lib/paths.ts';
export { keysInScope } from '../lib/keyScope.ts';
export { editable } from '../lib/editable.ts';
export { setValueAndCaret, insertPaths, AT_RE } from '../lib/insertText.ts';
export { ComposerFieldContext, useComposerField, type ComposerField } from './composerField.ts';
export { autosize, useAutosize } from '../lib/autosize.ts';
export { placeList, placeListFor, scrollTopFor, revealSelected } from '../lib/placeList.ts';
export { useNote, REFUSED } from '../lib/useNote.ts';
export { PATHS_MIME, draggedPaths, hasFiles, downloadUrl } from '../lib/drag.ts';
export { useFocusWithin } from '../shell/focusWithin.ts';
export { makeAnchor } from '../anchors/resolve.ts';
export { textOf, collapsedLength, rawIndexOf, offsetsOf, rangeForAnchor } from '../anchors/text.ts';
export { QUICK_LABELS, labelsFor, labelText, labelOf, instructionOf } from '../anchors/labels.ts';
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
export { SettingsContext, useSettings, systemPrefs, type SettingsHost, type SystemPrefs } from './settings.ts';

// where the project's files are: their kinds and URLs, the sources they are read from, the temp images, a media tab's start
export { AUDIO, IMAGE, VIDEO, HTML, kindOf, fileUrl, projectFileUrl, isPath, headVersion, type FileKind } from '../refs/kinds.ts';
export { useSources, loadSources, sourcesKnown, refOf, srcIdOfRef, isCommitRef, isFixed, fileKey } from '../refs/sources.ts';
export { setTmpDirs, useTmpDirs, isTmpTabPath, tmpImageUrl, tmpImagePathsIn, fetchTmpImage, type TmpLoad } from '../refs/tmpImages.ts';
export { setStartAt, takeStartAt, type StartAt } from '../refs/startAt.ts';
// what Markdown lets through of untrusted text
export { HARDEN } from '../components/markdown/harden.ts';

// this page: another computer's window, or on the window's own computer
export { remotePage, isLocalPage } from '../net/local.ts';

// keys
export { withKey, withKeys, keysFor, keysLabel, modKey, isMac } from '../shell/keymap.ts';

// paths in agent text
export { markRefs, markMentions, escapeMentions, refClick, fileOfImage, openMediaFile, clearRefCache } from '../refs/refs.ts';

// a rendered page's frame, carried across for the anchors (its text root, rects and selection), and scrolling to an anchor
export { outOf, rangeRects, rangeRect, pageRoot, textRootOf, pageSelection, clearPageSelections, pageRendered, usePageGen } from '../anchors/frame.ts';
export { scrollRangeIntoView, scrollRectIntoView, revealRangeSideways } from '../anchors/scroll.ts';

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
  useComments,
  useVoice,
  useAttachments,
  useService,
  refusedWhy,
  type RootState,
  type AppThunk,
  type AppDispatch,
  type AppStore,
  type StartListening,
  type VoiceSend,
} from '../store/store.ts';

// the agent's session-wide state: mode, model, commands, hello, a switch or restart, held sends
export {
  dictationSet, dictationLangSet, dictationAsk, planApproved, controlsListeners,
  selectMode, selectSuggestion, selectCapabilitiesKnown, selectCapabilities, selectSwitching, selectRestarting, selectRestartPending,
  selectCompactPending, selectHeld, selectOrderWaits, selectCanOrderCompact, selectModel, selectModels, selectCommands,
  selectModelSwitchable, selectIdleCompact, pickMode, pickModel, toggleIdleCompact, nextMode, reportActivity, resetActivityThrottle,
  ACTIVITY_THROTTLE_MS, runCommand, switchSession, restartAgent, stopWindow, restartServer, restartInPause, cancelCompact, cancelRestart,
  SERVER_RESTART_TIMEOUT_MS, type SwitchResult,
} from '../store/controls.ts';

// the images of the message being written
export { addImage, removeImage, markAttachment, uploadStarted, uploadFinished, selectImages, selectUploading, selectBuilding, selectMarking } from '../store/message.ts';

// the agent's usage figures and its background tasks
export { selectStats } from '../store/stats.ts';
export { selectLiveCalls, selectCallEnd } from '../store/tasks.ts';
// the subagents' conversations
export { selectSubagent, itemsOf, agentName, openSubagentTab, subagentRequested, subagentLoaded, subagentFailed } from '../store/subagents.ts';

export { seekAndPause, type MediaController, type PipApi } from '../store/mediaController.ts';
export { usePagePause } from '../shell/pagePause.ts';
export { SEEK_STEPS, seekStep, useSeekStep, type SeekStepValue } from '../store/seekStep.ts';
export { brief, renameSession, archiveSession, deleteSession } from '../store/sessions.ts';

import { answerPermission, interrupt, takeOver } from '../store/store.ts';
import { send } from '../store/send.ts';
export { sendBuilding, sendCount, sendWaiting } from '../store/send.ts';

/**
 * The chat's thunks. Each one calls through: this module may be evaluated inside the store module's import cycle (a
 * plugin the store imports imports the SDK), before those bindings exist.
 */
export const chat = {
  send: (...a: Parameters<typeof send>) => send(...a),
  interrupt: () => interrupt(),
  answer: (...a: Parameters<typeof answerPermission>) => answerPermission(...a),
  takeOver: () => takeOver(),
};

// tabs
export {
  openFile, openAgent, openShell, openDiagram, openChanges, openLog, openRemote, openSettings, activate, closeTab, reopenClosed,
  setAgentTitle, selectTabs, selectActiveTab, enterRoot, fileTabId, type Tab, type TabKinds, type AgentTab, type SavedFile, type DiagramLang,
} from '../tabs/slice.ts';
export { requestJump, clearJump, dropJump, selectJump, type Jump } from '../tabs/jump.ts';
export { feedRenderer, anchorView, type AnchorView, type AnchorKind, type TabView, type Slot, type SlotName, type Command, type KeyId, type Mods, type FeedRenderer, type AnyFeedRenderer, type FeedKind, type Held, type ToolRenderer, type ToolItem, type UserPart, type FileView, type SettingsSection, type SendPart, type Taken, type SendResult, type TextFileView, type MediaFileView, type MediaLoad, type FileBar, type CommentsService, type PendingComment, type VoiceService, type VoiceRecorder, type RecState, type AttachmentsService, type ImageEntry, type PendingThumb, type MediaComment, type MediaAnchorPatch, type Services, type FilesService, type FileLoad, type VcsService, type ProjectsService, type FeedUiService, type CutService, type MediaService, type CodeBlock, type TreeAction } from './registry.ts';
