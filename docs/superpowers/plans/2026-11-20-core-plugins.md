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

Steps 1–4 touch contracts and are the riskiest across processes; 5 and 8 are the riskiest in the web core. Phone steps
12–13 depend only on 2–4 and may run in parallel with 5–11.

---

### 1. Boundary check and baseline

- **Goal:** measure and freeze the import mesh before anything moves.
- **Files:** `scripts/boundaries.test.ts` (new), `scripts/boundaries.baseline.json` (new), root `package.json`
  (`rolldown` devDependency pinned to Vite's version), `web/src/sdk/index.ts` and `web/src/sdk/ui.ts` (empty
  re-export modules so the rule has a target).
- **Produces:** the rules of the spec (plugin→only SDK, core→no plugin, `@/testing` test-only, test files exempt,
  `localStorage` outside the SDK, numeric protocol gates in `web/src` and `mobile/app/lib`); `UPDATE_BOUNDARIES=1`.
- **Tests:** the check itself on the real tree; unit cases on a temp fixture tree (a new violation fails, a stale entry
  fails, type imports count, `@/` and relative paths resolve, dynamic imports count).
- **Baseline:** created: ~229 plugin→plugin, ~398 plugin→core, ~74 core→plugin, ~21 `localStorage` files, ~54 web and
  ~10 phone protocol gates.

### 2. Capability table in `shared`, generated for Dart

- **Goal:** no `protocol >= N` anywhere.
- **Files:** `shared/src/features.ts` (new; the history comments move here from `protocol.ts`), `shared/src/protocol.ts`
  (re-export, unused `*_PROTOCOL` constants deleted), `scripts/protocol/schema.ts` (`x-features`),
  `scripts/protocol/dart.ts` (`enum Feature`, `hasFeature`), `mobile/protocol/lib/src/protocol.g.dart` (generated),
  `shared/schema/protocol.schema.json`; every gate: web `comments/`, `composer/`, `media/`, `controls/`, others from the
  baseline; phone `chat/window_tab.dart`, `chat/controls.dart`, `comments/comments.dart`, `comments/comment_sheet.dart`,
  `files/image_screen.dart`, `store/voice_lang.dart`; `docs/agent-reference.md` and `docs/architecture.md` §3.3
  (the versioning rule only).
- **Produces:** `FEATURES`, `type Feature`, `has(protocol, f)`; Dart `Feature`, `hasFeature`.
- **Tests:** `shared/src/features.test.ts` (`PROTOCOL` equals the largest entry; `has` at, below, above and with
  `undefined`); `scripts/protocol/dart.test.ts` (the enum is emitted); `mobile/protocol/test/protocol_test.dart`
  (`hasFeature`); the existing old-server tests (CommentPopup.voice, micSend, controls, CutBody.comments, …) pass
  unchanged, now through names.
- **Baseline:** protocol gates → 0 (web and phone).

### 3. The host stream's `windows` message, typed, with a stable window id

- **Goal:** one definition of the window list for server, channel and app; port demoted to transport.
- **Files:** `shared/src/host.ts` (new: `HostWindow`, `LastMessage`, `HostStreamMessage`, `HOST_WINDOW_INFO`),
  `shared/src/protocol.ts` (re-export), `shared/fixtures/protocol.json` (host fixtures), `scripts/protocol/schema.ts`
  (`ROOTS` += `HostStreamMessage`), generated files; `server/src/remote/discover.ts` (`windowId`),
  `server/src/remote/device.ts` (`#hostStream`, `INFO_FIELDS` gone), `server/src/remote/hostLink.ts`
  (`HostWindowInfo` gone), `server/src/projects.ts` (`remoteRows` typed); `mobile/channel/pubspec.yaml` (`nb_protocol`
  as a dependency), `mobile/channel/lib/src/channel.dart` (generated `HostWindow`, `withIcon` as an extension);
  `mobile/app`: `notify/visible.dart`, `home.dart` (`lastChat` by id, the old form read once), `hosts/host_link.dart`,
  `chat/window_tab.dart` (lookups by id; `iconSupported` gone); `server/src/remote/CHANNEL.md` (fields, Reconnects).
- **Produces:** `HostWindow.id = provider:sha1(root)[0..16]`; the phone's window key `(hostId, id)` with `port:<n>` for
  a host that sends none.
- **Tests:** `server/src/remote/device.test.ts` (the message carries `id` and only `HOST_WINDOW_INFO` fields; same id
  across a restart on another port), `hostLink.test.ts` (typed list), `scripts/protocol/fixtures.test.ts` (fixtures
  valid); `mobile/channel` `dart test` incl. `cross_test.dart` against the real relay; app `host_link_test.dart`,
  `hosts_screen_test.dart`, `notify_events_test.dart`, `window_tab_test.dart`, a new case for the old `lastChat` form
  and a window that moves to another port keeping its chat open.
- **Behavior:** none visible. No `PROTOCOL` or channel version bump (spec: additive field).
- **Baseline:** unchanged (server and Dart are outside the web rule).

### 4. Feed golden fixture; vcs and file answers through the generator

- **Goal:** a parity check for the phone's port of the feed, and no hand-written copies of shared answer types, before
  the phone's `WindowTab` is split.
- **Files:** `web/src/store/feedParity.test.ts` (new), `mobile/app/test/fixtures/feed/*.json` (written by it),
  `mobile/app/test/feed_test.dart`, `mobile/app/lib/chat/session_state.dart` (phase by `toolKind` first);
  `scripts/protocol/schema.ts` (`ROOTS` += `VcsDiff`, `VcsPatch`, `VcsLog`, `VcsCommitDetail`, `GitSwitchAnswer`,
  `TreeEntry`, a `/complete` answer type), `shared/src/protocol.ts` (that type), fixtures, generated files;
  `mobile/app/lib/files/git.dart`, `files/remote.dart`, `hosts/project_icon.dart` on generated classes.
- **Produces:** `{ events, items }` fixture format; generated `VcsFile`, `VcsDiff`, … in Dart.
- **Tests:** the web test writes and checks; `feed_test.dart` compares every case; `git_test.dart`,
  `files_pane_test.dart`, `project_icon_test.dart` pass on the generated types. A deliberate drift (one field) fails both
  sides; the PR states it was tried.
- **Behavior:** none, unless the fixture finds a real web/phone difference: then the phone is fixed to the web's result
  in this PR and the PR says what changed.

### 5. Connection manager, SDK skeleton, test harness

- **Goal:** the SDK exists with its connection part, and the harness that later steps' tests use. **e2e**
- **Files:** `web/src/sdk/connections.ts`, `web/src/sdk/index.ts` (connection, feed selectors, `chat.*`, i18n, keymap,
  toast, lib/anchors/refs re-exports), `web/src/store/store.ts` (`makeStore` builds the manager; thunk extra
  `{ connections }`; `serverEvent` `meta.agent`), `web/src/testing/index.tsx` (new), `web/src/cut/testCut.tsx` on the
  harness; a codemod of plugin imports of `@/i18n`, `@/lib`, `@/net/auth` (`apiFetch` → `conn.fetch`), `toast`,
  `withKey`, store hooks and selectors to `@/sdk`; `@/components/ui` and `ConfirmDialog` to `@/sdk/ui`.
- **Produces / consumes:** `AgentConnection`, `ConnectionManager`, `useConnection`, `useConnState`, `useFeature`;
  `testStore`, `FakeConnection`, `stubRoutes`, `renderWith`, `events.*`.
- **Tests:** `sdk/connections.test.ts` (one connection, `SELF`, state, hello adoption point, `has`, `fetch`/`url` with
  base); `store.test.ts` and `net/socket.test.ts` unchanged and green; harness self-tests; the CutBody tests on the new
  `testCut`.
- **Baseline:** plugin→core ~398 → ~120 (the re-exports cover most direct core imports).

### 6. Routes and repositories: one shared poll

- **Goal:** the twelve hand-written poll loops and the 57 route literals go through one mechanism.
- **Files:** `web/src/sdk/routes.ts`, `web/src/sdk/repository.ts`; call sites `projects/api.ts:61-130`,
  `vcs/store.ts:75-130` (`watchDiff`, `usePatch`), `vcs/useLiveDiff.ts`, `vcs/LogView.tsx`, `files/sources.ts`,
  `shell/RestartMenu.tsx`, `shell/GitBranch.tsx`, `usage/UsageView.tsx`, `shell/UpdateNotice.tsx`,
  `settings/SettingsView.tsx` (`useLoad`), `voice/WhisperPrompt.tsx`, `cut/export/ExportControl.tsx`,
  `tasks/ShellView.tsx`, `subagent/`; the 11 files building `/file` and `/attach` URLs.
- **Produces:** `routes`, `defineResource`, `useResource`, `repository`.
- **Tests:** `sdk/repository.test.ts` with fake timers: one fetch for two watchers of one key, in-flight dedupe, timeout
  marks `failed` and keeps data, paused while hidden and while not `open` and resumes on both, unchanged text keeps the
  object, `events` refetch, ref-counted stop; `routes.test.ts` (encoding, `src`/`ref`); each migrated component's
  existing tests green with identical intervals.
- **Baseline:** `visibilityState` outside the SDK → 0 (added as a text rule in this step); plugin→plugin shrinks where
  a plugin read another's loader (~-10).

### 7. Storage, prefs, flags and `track`

- **Goal:** one data-access interface for local and server storage; one `hello` adoption.
- **Files:** `web/src/sdk/storage.ts`, `flags.ts`, `track.ts`; `i18n/index.ts`, `shell/theme.ts`, `shell/uiScale.ts`,
  `shell/sounds.ts`, `projects/railPref.ts`, `settings/SettingsView.tsx` (the six shared-pref copies), `vcs/store.ts:7-30`
  (UI state through storage), `projects/api.ts:42-50,199-203` (module globals), the other `localStorage` users
  (tabs, tree, comments emoji, PanelResizer, UpdateNotice, ChangesPanel, compactTiming, wrap, recent, FileEditor,
  CtxNudge, seekStep, persist); `store/store.ts` (the three hello adoptions → one).
- **Produces:** `storage.local`, `storage.pref`, `useStored`, `SharedPrefs`, `flag`, `useFlag`, `FLAGS`, `track`.
- **Tests:** `sdk/storage.test.ts` (keys unchanged: a value saved by today's code is read; pref set chains and the last
  wins; a hello value adopts; a pending local choice is not undone by an older read; storage unavailable falls back);
  `track.test.ts` (ring of 200, no fetch); existing theme/uiScale/i18n/sounds/railPref/Settings tests green.
- **Baseline:** `localStorage` outside the SDK → 0 (except `net/auth.ts`); plugin→core −~20.

### 8. Plugin definition and store injection

- **Goal:** the store stops importing features: plugins register slices, middleware and listeners. **e2e**
- **Files:** `web/src/sdk/plugin.ts`, `web/src/sdk/registry.ts` (empty registries for now), `web/src/plugins.ts` (new,
  `PLUGINS`), `web/src/main.tsx`; `store/store.ts` (`combineSlices(...).withLazyLoadedSlices<PluginState>()`;
  `toastMiddleware`, `compactTimingMiddleware`, `refusedMiddleware`, `historyMiddleware`, `controlsListener`,
  `flushComments` wiring move to their plugins), `store/persist.ts` (listener host; tab/tree/recent/sources listeners
  move to `files` and `tabs`), `shell/pagePause.ts` (AND of `Plugin.pause`); a `plugin.ts` in each plugin folder with
  its slices; `tree/` merged into `files/`.
- **Produces:** `definePlugin`, `Plugin`, `PluginState` augmentation, `makeStore({ plugins })`.
- **Tests:** `store.test.ts` (every plugin slice present under its name; middleware order as today:
  controlsListener, persist prepended; toast … media appended); the persistence cases in `store.test.ts` and `tabs/slice.test.ts` unchanged; `tsc -b` with no `any`
  added; full web suite through the harness default `PLUGINS`.
- **Baseline:** core→plugin from `store/` 22 → 0; shell's pagePause imports gone.

### 9. Views and commands registries

- **Goal:** tabs, slots, file views and keys are contributed, not imported. **e2e**
- **Files:** `tabs/Panes.tsx`, `tabs/TabStrip.tsx`, `tabs/TabsMenu.tsx` (one `tabLabel`), `tabs/slice.ts` (ids and
  save/restore from `TabView`; no `diagram/` import), `tabs/fileLabels.ts` → `files/`; `App.tsx`, `shell/Header.tsx`,
  `shell/Footer.tsx`, `shell/ToolStrip.tsx` render `slots`; `shell/GitBranch.tsx` → `vcs/`, `RestartMenu.tsx`,
  `StopButton.tsx` → `controls/`, `TasksIndicator.tsx` → `tasks/`, `UpdateNotice.tsx` → `update/` (new plugin);
  `files/FileView.tsx` over `fileViews` (cut, media, page, text register; each body handles its own jump);
  `shell/keymap.ts` over `commands` (`BINDINGS` entries move to their plugins; `withKey` unchanged).
- **Produces:** `TabView`, `TabKinds`, `Slot`, `FileView`, `Command`.
- **Tests:** `registry.test.ts` (duplicate kind or command id throws at build; slot order); `TabStrip`, `tabs/slice`,
  `keymap`, `FileView`, `Header`, `ToolStrip`, `GitBranch`, `RestartMenu`, `UpdateNotice` tests green; a test that the menu and the strip label a renamed file the
  same (today's label-chain bug class); e2e.
- **Behavior:** none intended. If `TabsMenu` ignoring `fileLabels` (inventory web-core #5) is fixed by the single
  `tabLabel`, the PR says so; that is the only visible change allowed here.
- **Baseline:** core→plugin from `shell/` and `tabs/` 48 → 0; plugin→plugin −~40 (files↔cut, files↔tabs, shell↔tabs,
  shell↔controls).

### 10. Feed, anchor-kind and send-part registries

- **Goal:** the feed and the comment batch stop importing the features they show; comment logic leaves `store.ts`.
  **e2e**
- **Files:** `feed/Feed.tsx` (`feed`), `feed/ToolLine.tsx` and `subagent/` (`tools`), `feed/UserMessage.tsx`
  (`userParts`, `anchors`); `comments/compose.ts`, `labels.ts`, `send.ts` over `anchors` (cut, page, media, attachment,
  text, message registered by their plugins); `store/store.ts:245-300` `selectReplyLabel`/`agentLabel` → `comments/`;
  `sendMessage` → `chat.send` collecting `sendParts` (comments, attachments, voice); `composer/refused.ts` through
  `SendPart.refused`; `composer/Composer.tsx` key handling and recall extracted (`useComposerKeys`, `usePromptRecall`).
- **Produces:** `FeedRenderer`, `ToolRenderer`, `UserPart`, `AnchorKind`, `SendPart`.
- **Tests:** `comments/compose.test.ts` and `send.where.test.ts` (the agent-facing batch text, a contract) unchanged
  byte for byte; `Feed`, `UserMessage`, `toolComments`, `AgentCard`, Composer tests green; the anchor parity tests
  (`anchors/mobileParity`, `mobileChatParity`) and the feed fixture unchanged.
- **Baseline:** plugin→plugin −~120 (feed's 22-folder fan-out, composer↔comments, feed↔subagent, comments→cut/page/media).

### 11. Settings sections, resources registry, baseline to zero

- **Goal:** the last cross-plugin imports go; the baseline is empty or holds only entries the PR justifies.
- **Files:** `settings/SettingsView.tsx` split into sections registered by `controls` (defaults), `voice`,
  `projects`, `update`, `shell` (theme, scale, language, sounds) with one `post()` helper; `resources` registered by
  plugins (the harness stubs by key); the remaining baseline entries; the ~60 unused exports (inventory) removed where
  the touched files hold them.
- **Produces:** `SettingsSection`; the registry complete.
- **Tests:** `SettingsView.test.tsx` per section; the boundary test with an empty (or explicitly justified) baseline.
- **Baseline:** → 0 plugin→plugin, 0 core→plugin, 0 plugin→core outside the SDK; any survivor listed in the PR with
  its reason and the issue that removes it.

### 12. Phone: `Sdk` and `AppStores`, leaks and string safety

- **Goal:** no app singletons; model files do not import UI; web strings cannot crash at runtime.
- **Files:** `mobile/app/lib/sdk.dart` (new: `Sdk`, `AppStores`), `main.dart` (`_load` builds `Sdk`),
  `comments/queue.dart`, `voice/outbox.dart`, `hosts/project_icon.dart` (no `.instance`), `chat/window_tab.dart` (takes
  stores), `test/support/rig.dart` (builds memory stores; resets gone); `ui/time.dart` (`ago` from `hosts_screen.dart`),
  the voice directory out of `voice/player.dart`, `l10n/locale.dart` (`resolveLocale` from `main.dart`);
  `scripts/protocol/mobileStrings.ts` (typed accessors, exhaustive mode map, `Intl.plural`), generated
  `comments/strings.g.dart`.
- **Tests:** every app test through `rig.dart` with injected stores; `strings_test.dart` (every mode has a label; no
  `!` on a map lookup); `scripts/protocol/gen.test.ts`; `headless_test.dart` (locale without `main.dart`).
- **Behavior:** none.

### 13. Phone: `WindowTab` split into `WindowConnection` and `WindowState`

- **Goal:** the god object becomes a composition of a connection and a state, named as on the web.
- **Files:** `chat/window_connection.dart` (new: mux stream, reconnect, passive, takeover, send, `has`),
  `chat/window_state.dart` (new: feed, controls, held, compaction, restart, stats, `apply`), `chat/window_tab.dart`
  (composition only), the screens' reads where a field moved; `test/window_tab_test.dart` split along the same line.
- **Tests:** `window_connection_test.dart` (4001 taken, 4904 reopen after the list shows the window, passive reconnect,
  takeover wish kept until sent), `window_state_test.dart` (apply sequences, held/compaction), the feed fixture, the
  full `flutter test`; `cross_test.dart` unchanged.
- **Behavior:** none.

### 14. Docs

- **Goal:** the architecture document describes what is there.
- **Files:** `docs/architecture.md` (§4.1 Core, SDK and plugins with the folder table and the rule; §4.2 store
  injection; new §4.5 SDK and registries; §3.3 versioning by `FEATURES`; §2.3 `HostWindow.id` and the phone's `Sdk`,
  `WindowConnection`, `WindowState`; §7 harness and feed fixture), `AGENTS.md` (one project-map line for `web/src/sdk/`
  and the boundary check), `mobile/README.md` (structure lines only), the spec's "Calls made" amended with anything a
  step decided differently.
- **Tests:** Mermaid diagrams in `architecture.md` parse-checked; links resolve; no code change.
