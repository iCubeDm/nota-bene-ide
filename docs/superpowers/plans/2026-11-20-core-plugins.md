# Core + SDK + plugins (issue 511) step plan

**Goal:** move the web and phone apps onto Core + SDK + plugins without a rewrite and without a user-visible change.

**Spec:** `docs/superpowers/specs/2026-11-20-core-plugins-design.md`. Every step is one PR into `gh-511-core-plugins`,
titled `gh-511: <what>`, body `Part of #511`. The epic PR goes to `main` after the owner's review.

## Rules for every step

- Green before review: `npx tsc -b`, `rtk test npx vitest run --project node --project web` (the full `npm test` once,
  under the shared lock), `npm run build -w web` when `web/` changes, `npm run gen:protocol -- --check` when `shared/`
  or the generator changes. When `mobile/` or `shared/` changes, the Mobile workflow's checks locally: in
  `mobile/app` `flutter analyze --fatal-infos`, `dart format --output=none --set-exit-if-changed lib test`,
  `flutter test`; in `mobile/protocol` and `mobile/channel` `dart analyze --fatal-infos` and `dart test` (CI's
  `protocol` job).
- No behavior change unless the step says so. Existing tests stay; a test changes only where the code it names moved.
- The boundary baseline (`scripts/boundaries.baseline.json`, from step 1) only shrinks; each PR body states the counts
  before and after (the test prints them). Expected counts below are estimates from today's 229 / 398 / 74.
- No new user-visible strings are expected; if a step adds one, it gets all six languages in the same PR.
- E2E (`npm run e2e`, ports 4791–4795) runs on the steps marked **e2e**, where DOM order or wiring moves.

Steps are grouped by number; lettered steps are separate PRs in that order. Steps 1–4 touch contracts and are the
riskiest across processes; 5a and 8a are the riskiest in the web core. Phone steps 12–13 depend only on 2a–4 and may
run in parallel with 5–11.

---

### 1. Boundary check and baseline

- **Goal:** measure and freeze the import mesh before anything moves.
- **Files:** `scripts/boundaries.test.ts` (new, no dependency), `scripts/boundaries.baseline.json` (new),
  `web/src/sdk/index.ts` and `web/src/sdk/ui.ts` (empty modules so the rule has a target).
- **Produces:** the rules of the spec (plugin → only SDK, core → no plugin, `@/testing` test-only, test files exempt,
  `localStorage` outside the SDK, protocol comparisons (numbers or constants) in `web/src` and `mobile/app/lib`, new
  `useSyncExternalStore` outside the SDK); `UPDATE_BOUNDARIES=1`.
- **Tests:** the check on the real tree; scanner cases on a temp fixture tree: a multi-line `import { a,\n b } from`,
  `import type`, `export { x } from`, `export * from`, side-effect `import '…'`, `import('…')`, a specifier inside a
  string or a comment (not counted), `@/` and relative resolution; a new violation fails, a stale entry fails. If a
  case cannot pass with the regex, the scanner switches to oxc (`rolldown/utils`) in this PR and says why.
- **Baseline:** created: ~229 plugin→plugin, ~398 plugin→core, ~74 core→plugin, ~21 `localStorage` files, 22 web and
  5 phone protocol-gate files, 28 `useSyncExternalStore` files.

### 2a. Capability table in `shared`, generated for Dart; phone gates

- **Goal:** the `FEATURES` table exists and the phone has no protocol comparison.
- **Files:** `shared/src/features.ts` (new; the history comments move here from `protocol.ts`), `shared/src/protocol.ts`
  (re-export), `scripts/protocol/schema.ts` (`x-features`), `scripts/protocol/dart.ts` (`enum Feature`,
  `hasFeature`), `mobile/protocol/lib/src/protocol.g.dart` (generated), `shared/schema/protocol.schema.json`; phone
  `chat/window_tab.dart`, `chat/controls.dart`, `comments/comments.dart` (`opsProtocol`),
  `comments/comment_sheet.dart` (`imagesAloneProtocol`), `files/image_screen.dart` (`wholePictureProtocol`),
  `store/voice_lang.dart` (`detectProtocol`); `docs/agent-reference.md` and `docs/architecture.md` §3.3 (the versioning
  rule only).
- **Produces:** `FEATURES` (several names may share a number), `type Feature`, `has(protocol, f)`; Dart `Feature`,
  `hasFeature`.
- **Tests:** `shared/src/features.test.ts` (`PROTOCOL` equals the largest entry; `has` at, below, above and with
  `undefined`); `scripts/protocol/dart.test.ts` (the enum is emitted, shared numbers allowed);
  `mobile/protocol/test/protocol_test.dart` (`hasFeature`); the phone's old-server tests pass unchanged.
- **Baseline:** phone protocol gates 5 → 0.

### 2b. Web gates through `has`

- **Goal:** no protocol comparison in `web/src`; the 14 `*_PROTOCOL` constants are gone.
- **Files:** the 22 files the check finds: `attachments/ComposerAttachments.tsx`, `comments/CommentPopup.tsx`,
  `comments/SelectionButton.tsx`, `comments/labels.ts` (`SINCE` → a `Feature` per label), `comments/send.ts`,
  `comments/slice.ts`, `composer/Composer.tsx`, `composer/shellMode.ts`, `controls/slice.ts`, `cut/CutBody.tsx`,
  `files/FileView.tsx`, `media/PlayerBar.tsx`, `media/markup/MarkupLayer.tsx`, `media/playerKeys.ts`,
  `remote/slice.ts`, `settings/SettingsView.tsx`, `subagent/AgentView.tsx`, `subagent/slice.ts`,
  `tasks/ShellView.tsx`, `tasks/TasksDrawer.tsx`, `tasks/slice.ts`, `voice/lang.ts`; and the constants' other homes
  (`page/frame.ts`, `cut/pin.ts`, `media/markup/slice.ts`, and their importers).
- **Tests:** the existing old-server tests (CommentPopup.voice, micSend, controls, CutBody.comments, labels, remote,
  tasks, …) pass unchanged, now through names.
- **Baseline:** web protocol gates 22 → 0.

### 3. The host stream's `windows` message, typed, with a stable window id

- **Goal:** one definition of the window list for server, channel and app; port demoted to transport.
- **Files:** `shared/src/host.ts` (new: `HostWindow` with optional `id`, `LastMessage`, `HostStreamMessage`,
  `HOST_WINDOW_INFO`), `shared/src/agent.ts` (`AgentProvider` moved here; `server/src/agent/provider.ts` re-exports),
  `shared/src/protocol.ts` (re-export), `shared/fixtures/protocol.json` (host fixtures with and without `id`),
  `scripts/protocol/schema.ts` (`ROOTS` += `HostStreamMessage`), generated files; `server/src/windows.ts` (new:
  `windowKey(provider, root)`), `bin/nota-bene.mjs` (the per-folder lock uses it), `server/src/remote/discover.ts`
  (`HostWindow` → `ProvedWindow`), `server/src/remote/device.ts` (`#hostStream` builds `HostStreamMessage` with ids and
  the duplicate rule; `INFO_FIELDS` gone), `server/src/remote/hostLink.ts` (`HostWindowInfo` gone),
  `server/src/projects.ts` (`remoteRows` typed), `server/src/remote/connector.test.ts` (rename);
  `mobile/channel/pubspec.yaml` (`nb_protocol` as a dependency), `mobile/channel/lib/src/channel.dart` (generated
  `HostWindow`; extensions `withIcon` and `key => id ?? 'port:$port'`); `mobile/app`: `notify/visible.dart`,
  `home.dart` (`lastChat` by key, the old `"host port root"` form read once), `hosts/host_link.dart`,
  `chat/window_tab.dart` (lookups by key; `iconSupported` a per-host flag); `server/src/remote/CHANNEL.md` (the real fields, the
  ignore-unknown-fields rule for the host stream stated, a Reconnects section).
- **Produces:** `HostWindow.id = provider:sha1(root)[0..16]`, `<id>:<port>` for the higher ports of a duplicate; the
  phone's window key `(hostId, key)`.
- **Tests:** `server/src/windows.test.ts` (same hash as the lock's); `server/src/remote/device.test.ts` (the message
  carries `id` and only `HOST_WINDOW_INFO` fields; same id across a restart on another port; two windows with one root
  and provider: the lower port keeps the bare id, the other gets `<id>:<port>`); `hostLink.test.ts` (typed list);
  `scripts/protocol/fixtures.test.ts`; `mobile/channel` `dart test` incl. a host message without `id` and
  `cross_test.dart` against the real relay; app `host_link_test.dart`, `hosts_screen_test.dart`,
  `notify_events_test.dart`, `window_tab_test.dart`, a case for the old `lastChat` form and one for a window that moves
  to another port keeping its chat open.
- **Behavior:** none visible. No `PROTOCOL` or channel version bump (spec: optional additive field).
- **Baseline:** unchanged (server and Dart are outside the web rule).

### 4a. Feed golden fixture

- **Goal:** a parity check for the phone's port of the feed before its `WindowTab` is split.
- **Files:** `web/src/store/feedParity.test.ts` (new; the projection and `phase` are defined in this test, not in
  `store/feed.ts`), `mobile/app/test/fixtures/feed/*.json` (written by it), `mobile/app/test/feed_test.dart`,
  `mobile/app/lib/chat/session_state.dart` (phase by `toolKind` first, name second).
- **Produces:** the `{ events, items }` fixture format.
- **Tests:** the web test writes and checks (`UPDATE_FIXTURES=1`); `feed_test.dart` compares every case;
  `session_state_test.dart`. A deliberate one-field drift fails both sides; the PR states it was tried.
- **Behavior:** none, unless the fixture finds a real web/phone difference: then the phone is fixed to the web's result
  in this PR and the PR says what changed.

### 4b. vcs and file answers through the generator

- **Goal:** no hand-written Dart copies of shared answer types.
- **Files:** `scripts/protocol/schema.ts` (`ROOTS` += `VcsDiff`, `VcsPatch`, `VcsLog`, `VcsCommitDetail`,
  `GitSwitchAnswer`, `TreeEntry`, a `/complete` answer type), `shared/src/protocol.ts` (that type), fixtures, generated
  files; `mobile/app/lib/files/git.dart`, `files/remote.dart`, `hosts/project_icon.dart` on generated classes.
- **Produces:** generated `VcsFile`, `VcsDiff`, … in Dart.
- **Tests:** `scripts/protocol/fixtures.test.ts` (new roots' fixtures valid); `git_test.dart`, `files_pane_test.dart`,
  `project_icon_test.dart` pass on the generated types.

### 5a. Connection manager

- **Goal:** the connection becomes an SDK object with one owner of its state. **e2e**
- **Files:** `web/src/sdk/connections.ts`, `web/src/store/store.ts` (`makeStore` builds the manager; thunk extra
  `{ connections }`; `serverEvent` `meta.agent`; one `connState` dispatch mirrors the connection), `net/socket.ts`
  untouched.
- **Produces / consumes:** `AgentConnection` (incl. `onEvent`), `ConnectionManager`, `SELF`, `useConnection`,
  `useConnState`, `useFeature`.
- **Tests:** `sdk/connections.test.ts` (one connection, `SELF`, state mirrored once per change, `onEvent` after the
  dispatch, the hello adoption point, `has`, `fetch`/`url` with base); `store.test.ts` and `net/socket.test.ts`
  unchanged and green.
- **Baseline:** unchanged (no imports move yet).

### 5b. SDK re-exports and the import codemod

- **Goal:** plugins reach core only through `@/sdk` and `@/sdk/ui`.
- **Files:** `web/src/sdk/index.ts` (connection, feed selectors, `chat.*`, i18n, keymap, toast, lib/anchors/refs
  re-exports by name), `web/src/sdk/ui.ts` (`components/ui`, `ConfirmDialog`, `PanelResizer`); a mechanical rewrite
  of plugin imports of `@/i18n`, `@/lib`, `@/net/auth` (`apiFetch` → `conn.fetch`), `toast`, `withKey`, store hooks
  and selectors.
- **Tests:** the full web suite and `tsc -b` (a pure import change); the boundary test.
- **Baseline:** plugin→core ~398 → ~120.

### 5c. Test harness

- **Goal:** one harness for the later steps' tests.
- **Files:** `web/src/testing/index.tsx` (new), `web/src/cut/testCut.tsx` on top of it.
- **Produces:** `testStore`, `FakeConnection`, `stubRoutes`, `renderWith`, `events.*`.
- **Tests:** harness self-tests (an unmatched route answers 404 and is recorded; `emit` reaches the store; `sent`
  records); the CutBody tests on the new `testCut`.

### 6. Routes and repositories: one shared poll

- **Goal:** the twelve hand-written poll loops and the 57 route literals go through one mechanism.
- **Files:** `web/src/sdk/routes.ts`, `web/src/sdk/repository.ts`; call sites `projects/api.ts:61-130`,
  `vcs/store.ts:75-130` (`watchDiff`, `usePatch`), `vcs/useLiveDiff.ts`, `vcs/LogView.tsx`, `files/sources.ts`,
  `shell/RestartMenu.tsx`, `shell/GitBranch.tsx`, `usage/UsageView.tsx`, `shell/UpdateNotice.tsx`,
  `settings/SettingsView.tsx` (`useLoad`), `voice/WhisperPrompt.tsx`, `cut/export/ExportControl.tsx`,
  `tasks/ShellView.tsx`, `subagent/`; the 11 files building `/file` and `/attach` URLs.
- **Produces:** `routes`, `defineResource`, `useResource`, `repository` (refetch on `Resource.events` through
  `AgentConnection.onEvent`).
- **Tests:** `sdk/repository.test.ts` with fake timers: one fetch for two watchers of one key, in-flight dedupe, timeout
  marks `failed` and keeps data, paused while hidden and while not `open` and resumes on both, unchanged text keeps the
  object, an `events` kind refetches, ref-counted stop; `routes.test.ts` (encoding, `src`/`ref`); each migrated
  component's existing tests green with identical intervals.
- **Baseline:** `visibilityState` outside the SDK → 0 (a text rule added in this step); plugin→plugin −~10.

### 7. Storage, prefs, flags and `track`

- **Goal:** one data-access interface for local and server storage; one `hello` adoption.
- **Files:** `web/src/sdk/storage.ts`, `flags.ts`, `track.ts`; `i18n/index.ts`, `shell/theme.ts`, `shell/uiScale.ts`,
  `shell/sounds.ts`, `projects/railPref.ts`, `settings/SettingsView.tsx` (the six shared-pref copies), `vcs/store.ts:7-30`
  (UI state through storage), `projects/api.ts:42-50,199-203` (module globals), the other `localStorage` users
  (tabs, tree, comments emoji, PanelResizer, UpdateNotice, ChangesPanel, compactTiming, wrap, recent, FileEditor,
  CtxNudge, seekStep, persist); `store/store.ts` (the hello adoptions → one).
- **Produces:** `storage.local`, `storage.pref` (posts through `connections.current().fetch`), `useStored`,
  `SharedPrefs`, `flag`, `useFlag`, `FLAGS`, `track`.
- **Tests:** `sdk/storage.test.ts` (keys unchanged: a value saved by today's code is read; pref set chains and the last
  wins, through the connection's `fetch`; a hello value adopts; a pending local choice is not undone by an older read;
  storage unavailable falls back); `track.test.ts` (ring of 200, no fetch); existing theme/uiScale/i18n/sounds/
  railPref/Settings tests green.
- **Baseline:** `localStorage` outside the SDK → 0 (except `net/auth.ts`); `useSyncExternalStore` −6; plugin→core −~20.

### 8a. Plugin definition and slice injection

- **Goal:** the store stops importing plugin slices. **e2e**
- **Files:** `web/src/sdk/plugin.ts`, `web/src/sdk/registry.ts` (empty registries), `web/src/plugins.ts` (new,
  `PLUGINS`), `web/src/main.tsx`; `store/store.ts` (`combineSlices(...).withLazyLoadedSlices<PluginState>()`, slices
  only); a `plugin.ts` in each plugin folder declaring its slices and the `PluginState` augmentation.
- **Produces:** `definePlugin`, `Plugin`, `PluginState`, `makeStore({ plugins })`.
- **Tests:** `store.test.ts` (every slice present under today's name, initial state equal to today's); `tsc -b` with
  no `any` added; full web suite through the harness default `PLUGINS`.
- **Baseline:** core→plugin from `store/store.ts` slice imports → 0 (~-14).

### 8b. Middleware, listeners, root change and pagePause

- **Goal:** the remaining wiring in the store and persist moves to its owners.
- **Files:** `store/store.ts` (`toastMiddleware`, `compactTimingMiddleware`, `refusedMiddleware`, `historyMiddleware`,
  `controlsListener`, the `flushComments` wiring move to their plugins), `store/persist.ts` (listener host; the
  root-change listener dispatches `enterRoot({ root, first, tabs })`: the core tabs ride in the action, so the media
  middleware sees one tab switch), `files` (tree dirs, recent, sources reload, ref cache in its listener),
  `shell/pagePause.ts` (AND of `Plugin.pause`).
- **Produces:** `Plugin.middleware`, `Plugin.listeners`, `Plugin.pause`; the documented listener order (core first,
  then `PLUGINS` order).
- **Tests:** `store.test.ts` (middleware order as today: controlsListener, persist prepended; toast … media appended);
  the persistence cases in `store.test.ts` and `tabs/slice.test.ts` unchanged (a new root restores tabs and tree
  dirs, the first root does not clear the ref cache, another does); a pagePause case per contributing plugin.
- **Baseline:** core→plugin from `store/` → 0; from `shell/pagePause.ts` → 0.

### 8c. `tree/` into `files/`

- **Goal:** one plugin folder for the tree and files. A move, no behavior change.
- **Files:** `web/src/tree/slice.ts` → `web/src/files/treeSlice.ts` (slice name stays `tree`), imports updated;
  `tree/plugin.ts` folds into `files/plugin.ts` (slices `[treeSlice, filesSlice]`, tree's listeners first, as the
  separate `tree` plugin ran before `files`), and `plugins.ts` drops the `tree` entry.
- **Tests:** the full web suite.
- **Baseline:** files↔tree edges → 0.

### 9a. Tabs registry

- **Goal:** tab kinds are shown by their plugins, not imported. **e2e**
- **Files:** `sdk/registry.ts` (`buildRegistry`, the `tabs` registry), `tabs/Panes.tsx`, `tabs/TabStrip.tsx`,
  `tabs/TabsMenu.tsx` (one `tabLabel`), `tabs/slice.ts` (no `diagram/` import: `sha1` → `lib/`, `DiagramLang` in the
  core), `tabs/fileLabels.ts` → `files/`; a `TabView` in each plugin that shows a kind.
- **Produces:** `TabView` (rendering only: label, icon, strip extras, menu detail, edit, pane), `TabKinds`. Tab ids and
  saved forms stay in the core with the tabs' actions, which several plugins dispatch. `fileViews` moved to 10c.
- **Tests:** `registry.test.ts` (duplicate kind throws at build; every kind has a view); `TabStrip`, `tabs/slice`,
  `agentTabs`, `fileLabels`, `FileView` tests green; a test that the menu and the strip label every tab the same; e2e.
- **Behavior:** none intended. If `TabsMenu` ignoring `fileLabels` (inventory web-core #5) is fixed by the single
  `tabLabel`, the PR says so; that is the only visible change allowed here.
- **Baseline:** core→plugin from `tabs/` 17 → 0; plugin→plugin unchanged (the file bodies are 10c's).

### 9b. Slots and the four shell moves

- **Goal:** the frame renders contributions; feature files leave `shell/`. **e2e**
- **Files:** `App.tsx`, `shell/Header.tsx`, `shell/Footer.tsx`, `shell/ToolStrip.tsx` render `slots` (`order` values
  reproduce today's order); `shell/GitBranch.tsx` → `vcs/`, `RestartMenu.tsx` and `StopButton.tsx` → `controls/`,
  `TasksIndicator.tsx` → `tasks/`, `UpdateNotice.tsx` → `update/` (new plugin).
- **Produces:** `Slot`.
- **Tests:** `Header`, `ToolStrip`, `GitBranch`, `RestartMenu`, `StopButton`, `UpdateNotice` tests green; a slot-order
  test; e2e (DOM order and focus).
- **Baseline:** core→plugin from `shell/` (except keymap) → 0; shell↔controls, shell↔tabs → 0.

### 9c. Commands registry

- **Goal:** keys are contributed by their plugins.
- **Files:** `shell/keymap.ts` over `commands` (`BINDINGS` entries move to their plugins; matching, modal and field
  rules and `withKey` unchanged).
- **Produces:** `Command`.
- **Tests:** `shell/keymap.test.tsx` unchanged and green; duplicate command id throws at build; every tooltip key still
  resolves through `withKey`.
- **Baseline:** core→plugin from `shell/keymap.ts` → 0.

### 10a. Composer extraction

- **Goal:** `Composer.tsx` (511 lines, 44 hooks) is split before its imports change.
- **Files:** `composer/Composer.tsx`, new `composer/useComposerKeys.ts`, `composer/usePromptRecall.ts`.
- **Tests:** Composer tests unchanged and green; the hooks tested where logic moved.
- **Baseline:** unchanged.

### 10b. Feed, anchor-kind and send-part registries

- **Goal:** the feed and the comment batch stop importing the features they show; comment logic leaves `store.ts`.
  **e2e**
- **Files:** `feed/Feed.tsx` (`feed`), `feed/ToolLine.tsx` and `subagent/` (`tools`), `feed/UserMessage.tsx`
  (`userParts`, `anchors`); `comments/compose.ts`, `labels.ts`, `send.ts` over `anchors` (cut, page, media, attachment,
  text, message registered by their plugins); `store/store.ts:245-300` `selectReplyLabel`/`agentLabel` → `comments/`;
  `sendMessage` → `chat.send` collecting `sendParts` (comments, attachments, voice); `composer/refused.ts` through
  `SendPart.refused`.
- **Produces:** `FeedRenderer`, `ToolRenderer`, `UserPart`, `AnchorKind`, `SendPart`.
- **Tests:** `comments/compose.test.ts` and `send.where.test.ts` (the agent-facing batch text, a contract) unchanged
  byte for byte; `Feed`, `UserMessage`, `toolComments`, `AgentCard`, Composer tests green; the anchor parity tests
  (`anchors/mobileParity`, `mobileChatParity`) and the feed fixture unchanged.
- **Baseline:** plugin→plugin −~120 (feed's 22-folder fan-out, composer↔comments, feed↔subagent, comments→cut/page/media).
  The SDK barrels' reach (`sdkReach` in `scripts/boundaries.test.ts`) loses `store/store.ts` → `voice/lang.ts`
  (`dictationAsk`, with `sendParts`), `subagent/slice.ts` and `feed/uiSlice.ts` (`agentName`, `itemsOf`, `TOOL_SRC`,
  with `selectReplyLabel`/`agentLabel`), and `media/mediaController.ts` (the controller is core: it moves to `store/`).

### 10c. File views registry

- **Goal:** file bodies are contributed, not imported. Needs 10b: the bodies reach the comment popup, the highlight
  layer and the jump through the SDK, so moving them adds no plugin→plugin entry. **e2e**
- **Files:** `files/FileView.tsx` over `fileViews` (cut, media, page, text register; each body handles its own jump),
  `files/view/HtmlBody.tsx` → `page/`, `files/view/MediaBody.tsx` and `useMediaMarkup.ts` → `media/`.
- **Produces:** `FileView`.
- **Tests:** the `FileView*` tests green (jump, cut, edit, tmp); duplicate file view id throws at build; e2e.
- **Baseline:** plugin→plugin −~20 (files↔cut, files→media/page). The SDK barrels' reach loses `refs/refs.ts` →
  `files/kinds.ts`, `files/sources.ts`, `files/tmpImages.ts` (refs resolves paths through what `files` registers) and
  `anchors/scroll.ts` → `page/frame.ts` (the frame's rect helpers move into `anchors/`): `sdkReach` is then empty.

### 11. Settings sections, resources registry, baseline to zero

- **Goal:** the last cross-plugin imports go; the baseline is empty or holds only entries the PR justifies.
- **Files:** `settings/SettingsView.tsx` split into sections registered by `controls` (defaults), `voice`,
  `projects`, `update`, `shell` (theme, scale, language, sounds) with one `post()` helper; `resources` registered by
  plugins (the harness stubs by key); the remaining baseline entries; the remaining `useSyncExternalStore` singletons
  folded per the state rule where the touched files hold them; the ~60 unused exports (inventory) removed there;
  the global `BINDINGS` in `shell/keymap.ts` (9c) goes: key labels come from `useRegistry().commands` through a pure
  `keysFor(commands, id)`, so `withKey` takes the commands (`shell/keymap.test.tsx` may change then).
- **Produces:** `SettingsSection`; the registry complete.
- **Tests:** `SettingsView.test.tsx` per section; the boundary test with an empty (or explicitly justified) baseline.
- **Baseline:** → 0 plugin→plugin, 0 core→plugin, 0 plugin→core outside the SDK; any survivor listed in the PR with
  its reason and the issue that removes it.

### 12. Phone: `Sdk` and `AppStores`, leaks, import test, string safety

- **Goal:** no app singletons; model files do not import UI; web strings cannot crash at runtime.
- **Files:** `mobile/app/lib/sdk.dart` (new: `Sdk`, `AppStores`), `main.dart` (`_load` builds `Sdk`),
  `comments/queue.dart`, `voice/outbox.dart`, `hosts/project_icon.dart` (no `.instance`), `chat/window_tab.dart` (takes
  stores), `test/support/rig.dart` (builds memory stores; resets gone); `ui/time.dart` (`ago` from `hosts_screen.dart`),
  the voice directory out of `voice/player.dart`, `l10n/locale.dart` (`resolveLocale` from `main.dart`);
  `test/imports_test.dart` (new); `scripts/protocol/mobileStrings.ts` (typed accessors, exhaustive mode map,
  `Intl.plural`), generated `comments/strings.g.dart`.
- **Tests:** `imports_test.dart` (nothing in `lib/` imports `main.dart`; the spec's model and store files import no
  `*_screen.dart`, `*_sheet.dart` or `voice/player.dart`); every app test through `rig.dart` with injected stores;
  `strings_test.dart` (every mode has a label; no `!` on a map lookup); `scripts/protocol/gen.test.ts`;
  `headless_test.dart` (locale without `main.dart`).
- **Behavior:** none.

### 13. Phone: `WindowTab` split into `WindowConnection` and `WindowState`

- **Goal:** the god object becomes a composition of a connection and a state, named as on the web.
- **Files:** `chat/window_connection.dart` (new: mux stream, reconnect, passive, takeover, send, `has`),
  `chat/window_state.dart` (new: feed, controls, held, compaction, restart, stats, `apply`), `chat/window_tab.dart`
  (composition only), the screens' reads where a field moved; `test/window_tab_test.dart` split along the same line.
- **Tests:** `window_connection_test.dart` (4001 taken, 4904 reopen after the list shows the window, passive reconnect,
  takeover wish kept until sent), `window_state_test.dart` (apply sequences, held/compaction), the feed fixture,
  `imports_test.dart`, the full `flutter test`; `cross_test.dart` unchanged.
- **Behavior:** none.

### 14. Docs

- **Goal:** the architecture document describes what is there.
- **Files:** `docs/architecture.md` (§4.1 Core, SDK and plugins with the folder table and the rule; §4.2 store
  injection and the listener order; new §4.5 SDK and registries with the state rule; §3.3 versioning by `FEATURES`;
  §2.3 `HostWindow.id` and the phone's `Sdk`, `WindowConnection`, `WindowState`; §7 harness and feed fixture),
  `AGENTS.md` (one project-map line for `web/src/sdk/` and the boundary check), `mobile/README.md` (structure lines
  only), the spec's "Calls made" amended with anything a step decided differently.
- **Tests:** Mermaid diagrams in `architecture.md` parse-checked; links resolve; no code change.
