# Core + SDK + plugins in the web and phone apps (issue 511)

## Intent

The base is sound (one pure feed reducer, one `serverEvent` entry, the socket semantics, persistence listeners, i18n
parity, `withKey`, the comments op queue, a pure-Dart channel). The debt is one level below it: twelve hand-written poll
loops, three state mechanisms with no rule, feature folders importing each other in cycles, protocol gates written as
numbers, an untyped window list keyed by port, and a god `WindowTab` on the phone. The fix moves both apps step by step
onto one shape: a **Core** that owns connection, data, storage, capabilities and registries; one internal **SDK** that
is the only thing a feature module may import; and **plugins**, which are our own feature folders, compiled into the one
bundle. Nothing is rewritten; each step is a PR into `gh-511-core-plugins` with green checks and no user-visible change.

## Goals

- One SDK module per app; plugins import only it. A boundary check enforces it with a committed baseline that only
  shrinks.
- One way to load a resource: server events, else one shared poll (cache, in-flight dedupe, timeout, pause while the
  connection is not open or the page is hidden). Route URLs are built in one place.
- One storage interface over local storage and server prefs, with one `hello` adoption point.
- One capability table in `shared` (generated for Dart) instead of comparisons with protocol numbers.
- Registries as the plugin contract: views, feed renderers, comment anchor kinds, commands and keys, settings sections,
  resources.
- A connection manager whose shape allows several agents per page (groundwork for issue 383), while today's page keeps
  exactly one connection.
- The phone uses the same names; what must match lives in `shared`, is generated for Dart and is checked by fixtures.
- The host stream's `windows` message is typed in `shared`, with a stable window id; the port becomes transport only.

## Non-goals

- Runtime plugins, lazy-loaded plugin code, Module Federation, plugin API versioning or isolation.
- Third-party plugins.
- Telemetry that leaves the machine: `track` has no receiver, no upload, no consent flow.
- Several agents per page (issue 383 builds on this), a protocol floor for old servers or phone hosts (the table makes
  that a later one-line decision), the server composing comment batches, generating ARB from web strings.

## Anti-goals

- A framework: no DI container, no event bus beside Redux, no plugin lifecycle beyond "registered at build time".
- A Dart registry for its own sake: where a sealed generated type plus an exhaustive `switch` already gives
  compile-time completeness, a registry would only lose it (see the phone section).
- Big-bang migrations: tests, imports and call sites move when a step touches them; the baseline records the rest.

## The web SDK

### Location and entry points

- `web/src/sdk/index.ts`: the runtime API (below). New core code lives beside it in `web/src/sdk/` (`connections.ts`,
  `repository.ts`, `routes.ts`, `storage.ts`, `registry.ts`, `plugin.ts`, `track.ts`, `flags.ts`); `index.ts` also
  re-exports the existing core folders.
- `web/src/sdk/ui.ts`: the UI primitives (`components/ui/*`, `ConfirmDialog`, `PanelResizer`), kept out of `index.ts`
  so the runtime API stays readable.
- A plugin imports `@/sdk` and `@/sdk/ui`, its own folder, `@nota-bene/shared*` and npm packages. Nothing else.
- `web/src/testing/index.tsx`: the test harness, importable from test files only.
- Composition root: `web/src/main.tsx`, `web/src/App.tsx` and a new `web/src/plugins.ts` (the ordered `PLUGINS` list).
  Root-level files may import anything.

### Exported API

Names are final unless a step finds a collision; shapes are interfaces, not bodies.

**Connection** (`connections.ts`, over `net/socket.ts` and `net/auth.ts`, semantics unchanged)

- `type AgentId = string`; `SELF: AgentId = 'self'` (the one agent of today's page; issue 383 gives real ids).
- `interface AgentConnection { id; base: string /* URL prefix of the agent's routes, '' today */; state(): ConnState;
  subscribe(fn): () => void; hello(): HelloEvent | null; has(f: Feature): boolean; send(m: ClientMessage): boolean;
  fetch(route: Route, init?): Promise<Response> /* apiFetch(base + route) */; url(route: Route): string /* for img,
  video, iframe src */; takeOver(); stop() }`.
- `interface ConnectionManager { current(): AgentConnection; get(id): AgentConnection | undefined; list():
  AgentConnection[] }`. `makeStore` creates it with exactly one connection; `open()` is left to issue 383.
- `serverEvent(ev, agent = SELF)` gains `meta: { agent }` (reducers ignore it until 383); `connState`, `selectConn`.
- `onEvent(fn) → off`: the connection's events after the store has applied them; the non-React `repository` refetches
  through it (`Resource.events`), so there is no second path into Redux and no store listener in core data code.
- **Connection state has one owner, the connection.** The manager mirrors each change into the store with one
  `connState` dispatch; components read the `conn` slice (`useConnState` is a selector over it), never the
  connection object. `conn.state()` exists for non-React code (the repository's pause).
- Hooks: `useConnection()`, `useConnState()`, `useFeature(f)`.
- The thunk extra argument becomes `{ connections }` (today `{ send, takeOver, stopSocket }`).

**Data** (`routes.ts`, `repository.ts`)

- `routes`: one object of builders returning a `Route` (path + query, no base): `file(path, { src, ref })`,
  `attach(id)`, `tree(dir, src)`, `complete(q)`, `vcsDiff(src, base)`, `vcsFile(...)`, `vcsLog(...)`,
  `vcsCommit(...)`, `subagent(id, after)`, `taskOutput(id)`, `systemPrefs()`, `systemProjects()`, `systemUpdate()`,
  `usage(...)`, `dictation()`, `info()` and the rest of today's 57 literals. `/file` and `/attach` URLs (11 files today)
  go only through `conn.url(routes.file(...))`.
- `defineResource<A, T>({ key: (a: A) => string; route: (a: A) => Route; every?: ms; events?: ServerEvent['kind'][]
  /* refetch on these */; parse?: (r: Response) => Promise<T>; same?: 'text' | ((x: T, y: T) => boolean); timeout?: ms
  })` returns a `Resource<A, T>`.
- `useResource(res, args | null, { on?: boolean }) → { data: T | null; failed: boolean; loading: boolean; refresh() }`.
- `repository` (non-React): `load(res, args)`, `watch(res, args) → stop`, `peek(res, args)`, `invalidate(res, args?)`.
- One cache per connection keyed by `res.key(args)`, ref-counted watchers (the Changes panel and tab already share one
  diff poll, issue 471; every resource gets that), in-flight dedupe, `AbortSignal.timeout`, a single
  `visibilitychange` listener (today 10 `visibilityState` checks) and a single connection-state subscription for the
  pause. Unchanged response text keeps the old object, so a large diff does not re-render.

**Storage** (`storage.ts`, `flags.ts`, `track.ts`)

- `storage.local<T>(key, codec, fallback) → Stored<T> { get(); set(v); subscribe(fn); }`; `useStored(item)`.
  Keys stay exactly as today (`lang`, `nb.theme`, `tabs:<root>`, …), so nothing saved is lost. Codecs: `bool`,
  `string`, `json<T>(valid)`, `oneOf(values)`.
- `storage.pref<K extends keyof SharedPrefs>(name) → Pref<T> { get(); set(v) /* POST /system/prefs, chained, last
  wins */; subscribe(fn); }`; `set` posts through `connections.current().fetch(routes.systemPrefs(), …)`, so a pref
  follows the agent's base path; cached in local storage under its current key so a reload does not flash. `SharedPrefs`
  (`lang`, `uiScale`, `theme`, `dictationLang`, `projectRail`, `sounds`) is typed in `web/src/sdk/storage.ts`.
- One adoption point: the connection adopts `hello.lang`, `hello.uiScale`, `hello.theme`, `hello.dictationLang` into
  their prefs (today three separate calls in `store.ts:170-173` plus a fourth for dictation). `projectRail` and
  `sounds`, which `hello` does not carry, are read from `GET /system/prefs` by the same module.
- `flag(name) / useFlag(name)`: local feature flags, `storage.local('nb.flag.<name>', bool, FLAGS[name])`; `FLAGS` is a
  typed table in `flags.ts` (empty today; a flag is added with the feature it guards).
- `track(name: string, props?: Record<string, string | number | boolean>)`: appends to an in-memory ring of the last
  200 events, `track.recent()` reads it (tests, a future local view). No network, no storage.
- No plugin calls `localStorage`; the boundary check scans for it outside `web/src/sdk/` and `net/auth.ts`.

**The state rule.** Each piece of state has exactly one home:

| What | Where |
|---|---|
| server data pushed over the socket, and UI state several components or a reload share | a slice (core or a plugin's), fed by `serverEvent` / actions |
| server data fetched over HTTP | `useResource` / `repository` (its cache is the one copy) |
| anything that outlives the page (local or server prefs, saved UI state) | `storage.local` / `storage.pref` (a slice may mirror it through a listener, as `persist.ts` does) |
| state of one component instance | `useState` / `useReducer` |

No new `useSyncExternalStore` module singletons: the 28 existing ones fold into `storage`, `repository` or a slice when
a step touches them (the boundary check counts them outside `web/src/sdk/`).

**Capabilities**: `has(protocol, feature)` and `type Feature` re-exported from `@nota-bene/shared` (below);
`conn.has(f)` / `useFeature(f)` bind it to the connection's `hello.protocol`.

**Store and plugins** (`plugin.ts`, `registry.ts`, over `store/store.ts`)

- `definePlugin(p: Plugin): Plugin`, where `interface Plugin { id: string; slices?: Slice[]; middleware?: Middleware[];
  listeners?: (start: StartListening) => void /* persist-style, one per concern */; pause?: (s: RootState, o: { draft:
  boolean }) => boolean /* false while the plugin holds the page busy, for pagePause */; tabs?: TabView[]; slots?:
  Slot[]; fileViews?: FileView[]; feed?: FeedRenderer[]; tools?: ToolRenderer[]; userParts?: UserPart[]; anchors?:
  AnchorKind[]; commands?: Command[]; settings?: SettingsSection[]; resources?: Resource[]; sendParts?: SendPart[] }`.
- `makeStore({ url, plugins, connect?, pip? })`: the reducer is RTK 2 `combineSlices(feed, conn, tabs, …core)
  .withLazyLoadedSlices<PluginState>()`, each plugin's slices injected once at creation. `PluginState` is an interface
  that each plugin extends by module augmentation (`declare module '@/sdk' { interface PluginState extends
  WithSlice<typeof commentsSlice> {} }`), so `RootState` is fully typed without the store importing any plugin.
- `useAppSelector`, `useAppDispatch`, `type RootState`, `type AppThunk`, `useMedia` (the `MediaController` stays a
  core, tab-level service: pause and PiP follow tab switches).
- Feed model and chat actions: `selectFeed`, `selectBusy`, `selectSession`, `selectTurnSeq`, `type FeedItem`,
  `type FeedState`; `chat.send(text, opts)` (today's `sendMessage`, now also collecting `sendParts`),
  `chat.interrupt()`, `chat.answer(id, allow, response?)`, `chat.takeOver()`.
- Tabs: `openTab`, `openFile(path, at?)`, `activate`, `closeTab`, `selectTabs`, `type Tab`, augmentable
  `interface TabKinds` (`Tab = TabKinds[keyof TabKinds]`), registered the same way as `PluginState`.
- **Root change.** The listener that sees a new `feed.session.root` stays core (`store/persist.ts`) and dispatches
  `enterRoot({ root, first })` with no plugin data; today it reads `readSavedTabs` and `readSavedDirs`
  (`persist.ts:36-45`) and `tabs/slice.ts:76` takes them in the action. Each owner restores its own saved state in its
  own listener on `enterRoot`: core `tabs` its tabs; `files` its tree dirs, recent files, the sources reload and the
  ref cache. **Listener order** is registration order: core listeners first (the root-change listener first of all,
  then core `tabs`), then each plugin's in `PLUGINS` order, a plugin's own in its declared order. Saving listeners
  compare before/after as today, so a restore dispatched by an earlier listener is seen by the later ones.
- Registries are built once from `plugins` (`buildRegistry`), frozen, and read with `useRegistry()` or
  `registry(store)`.

**Translations and keys**: `t`, `useT`, `getLang`, `setLang`, `LANGS`, `type I18nKey`; `withKey`, `keyLabel`;
`toast`. The dictionaries stay in `i18n/` (core); `i18n.test.ts` parity is unchanged.

**Helpers**: `lib/` (paths, format, keyScope, editable), `anchors/` (text anchoring), `refs/` (paths in text) are
re-exported by name, not by wildcard, so the SDK surface is visible in one file.

### Registries and their entry types

| Registry | Entry | Replaces |
|---|---|---|
| `tabs` | `TabView { kind; id(tab); label(tab, t): string; icon?; render: FC<{ tab; active; rootGen }>; save?(tab): Saved; restore?(saved): Tab; single?: boolean }` | the `tab.kind` chain in `tabs/Panes.tsx`, label chains in `TabStrip`/`TabsMenu` (one `tabLabel`), `tabs/slice.ts` importing `diagram/render.ts` and `diagram/sha1.ts` for ids |
| `slots` | `Slot { slot: 'header.start' \| 'header.end' \| 'footer' \| 'strip.left' \| 'strip.right' \| 'composer.above' \| 'composer.actions' \| 'overlay'; order; render: FC }` | `App.tsx`, `Header`, `Footer`, `ToolStrip` importing features (GitBranch, RestartMenu, TasksIndicator, UpdateNotice, meters, panels, overlays) |
| `fileViews` | `FileView { id; match(path, kind): boolean; order; render: FC<{ path; src; ref?; tabId; active }>; jump?(target) }` | `files/FileView.tsx` importing cut, media, page, diagram; its `files.jump` special cases |
| `feed` | `FeedRenderer { kind: FeedItem['kind']; render: FC<{ item; held? }> }` | the `switch` in `feed/Feed.tsx` |
| `tools` | `ToolRenderer { match(it: ToolItem): boolean; render: FC<{ item }> }` | `feed/ToolLine.tsx` and `Feed.tsx` importing `subagent/` for Agent calls |
| `userParts` | `UserPart { id; order; render: FC<{ item: UserItem }> }` | `feed/UserMessage.tsx` importing voice, attachments |
| `anchors` | `AnchorKind { kind: Anchor['kind']; is(a): boolean; line(c: Comment, lang): string /* the batch and feed quote */; label?(c, s): string \| null; reveal?(c): void; card?: FC<{ comment }> }` | `UserMessage` importing cut, page, media quotes; `comments/compose.ts` per-kind branches; `store.ts` hosting `selectReplyLabel`/`agentLabel` |
| `commands` | `Command { id: KeyId; codes; mods; inFields?; when?(ctx): boolean; run(ctx: { store; connection; e }); label: I18nKey }` | the `BINDINGS` list in `shell/keymap.ts`, which imports comments, composer, files, projects, tasks, tree |
| `settings` | `SettingsSection { id; order; title: I18nKey; render: FC<{ active }> }` | the 421-line `SettingsView.tsx` and its five post/error copies (one `post()` helper in the section host) |
| `resources` | `Resource` (above) | lets the harness stub by key and core refetch on `events` |
| `sendParts` | `SendPart { id; collect(s): { commentIds?; text?; images? } \| null; sent?(id); refused?(id) }` | the composer importing `comments/send.ts`, `comments/slice.ts`, and `composer/refused.ts` reaching into comments |

`sendParts` is the one registry beyond the owner's list: without it the composer↔comments cycle stays, because a send
carries the pending comments.

## Core and plugins: every `web/src` folder

Core is what the SDK re-exports; core folders may import each other but never a plugin. Each plugin folder gets a
`plugin.ts` exporting its `definePlugin(...)`; everything else in the folder is private to it.

| Folder | Role | Notes |
|---|---|---|
| `sdk/` (new) | core | the facade and the new core modules |
| `net/` | core | socket, auth, `local.ts` (remote page) behind `connections` |
| `store/` | core | store assembly, `feed.ts` pure reduce, `chunks.ts`, `persist.ts` as the listener host; per-concern listeners move to their plugins |
| `i18n/` | core | translations |
| `lib/` | core | pure helpers |
| `components/` | core | UI primitives via `@/sdk/ui` |
| `theme/` | core | theme tests only |
| `anchors/` | core | text anchoring, used by comments, files, page, feed |
| `refs/` | core | paths in agent text; opens files through `openFile` |
| `tabs/` | core | the tab host over the `tabs` registry; `fileLabels.ts` moves to `files` |
| `shell/` | core | the frame: Header, Footer, ToolStrip, Logo, toasts, keymap host, theme, uiScale, sounds, Favicon, OneTab, LoginRequired, Stopped, PanelResizer, focusWithin, tabAlign, reloadPage, pagePause (now the AND of `Plugin.pause`). `GitBranch` → `vcs`; `RestartMenu`, `StopButton` → `controls`; `TasksIndicator` → `tasks`; `UpdateNotice` → `update` |
| `feed/` | plugin `feed` | the chat feed rendering; owns the `feed`, `tools`, `userParts` registries' host components |
| `composer/` | plugin `composer` | input, pickers, history; `Composer.tsx` key handling and recall extracted (511 lines, 44 hooks) |
| `comments/` | plugin `comments` | registers `anchors` (text, message), `sendParts`, slots (panel, popup, card, highlight layer) |
| `attachments/` | plugin `attachments` | `userParts`, `anchors` (attachment), `sendParts` (images) |
| `voice/` | plugin `voice` | `userParts` (bubble, clips), composer slot, settings section |
| `controls/` | plugin `controls` | mode, sessions, compact/clear, model, effort, restart, stop; `ConfirmDialog` → `@/sdk/ui` |
| `stats/` | plugin `stats` | footer meters, context nudge |
| `tasks/` | plugin `tasks` | drawer, `shell:` tab, indicator |
| `subagent/` | plugin `subagent` | `agent:` tab, `tools` renderer for Agent calls |
| `files/` + `tree/` | plugin `files` | tree, file tab, recent, sources; `tree/slice.ts` moves into `files/` (97 lines, used only by files and persist) |
| `media/` | plugin `media` | player, keys, markup; registers `fileViews` (image, video, audio) and `anchors` (media) |
| `cut/` | plugin `cut` | `fileViews` (`*.nbcut.json`), `anchors` (cut) |
| `page/` | plugin `page` | `fileViews` (html), `anchors` (page) |
| `diagram/` | plugin `diagram` | `diagram:` tab (ids from its own `sha1.ts`) |
| `vcs/` | plugin `vcs` | Changes panel and tab, Git log, branch pill |
| `projects/` | plugin `projects` | rail, switcher, starter; window-per-port stays confined to `projects/api.ts` |
| `remote/` | plugin `remote` | Remote tab and indicator |
| `settings/` | plugin `settings` | the Settings tab, hosting `settings` sections |
| `usage/` | plugin `usage` | the Usage tab |
| `update/` (new) | plugin `update` | `shell/UpdateNotice.tsx` |

Measured today with the rule below (product files only, distinct imports): 229 plugin→plugin, 398 plugin→core
bypassing the SDK, 74 core→plugin (shell 31, store 22, tabs 17, refs 3, anchors 1); 701 in total.

## The import rule

- **Tool.** A Vitest test, `scripts/boundaries.test.ts`, in the `node` project (so it runs in CI's `npx vitest run
  --project node --project web` and in `npm test`), with no dependency: a regular expression over each file's whole
  text finds `import … from '…'`, `import type … from '…'`, `export … from '…'`, side-effect `import '…'` and
  `import('…')`, tolerant of newlines inside the braces; comments are stripped first so a commented import does not
  count. It resolves `@/` and relative specifiers. Type-only imports count: they couple too. Step 1's fixture cases
  (multi-line, type-only, re-export, dynamic, a specifier inside a string or a comment) prove it; only if a case cannot
  pass does it switch to oxc (`parseSync` from `rolldown/utils`, already installed with Vite).
- **Why not dependency-cruiser.** The repository is on TypeScript 7 (`typescript@7.0.2` ships only `tsc.js`, no
  compiler API). dependency-cruiser parses TypeScript through the `typescript` API or `@swc/core`; it would need a new
  native dependency plus its own config language for a folder rule. There is no
  ESLint in the repository to hang a rule on. Revisit if TypeScript's API returns and the rules grow beyond folders.
- **Rules.** (1) A plugin file imports only `@/sdk`, `@/sdk/ui`, its own folder, `@nota-bene/shared*`, packages.
  (2) A core file never imports a plugin folder. (3) `@/testing` only from `*.test.ts(x)`. (4) Test files are exempt from
  1–2 (an integration test composes plugins through the harness). (5) No `localStorage` outside `web/src/sdk/` and
  `net/auth.ts`; no comparison of `protocol` with a number or a protocol constant (`<`, `<=`, `>`, `>=`, also
  `(x.protocol ?? 0) >=` and `>= *_PROTOCOL` / Dart `*Protocol`) in `web/src` or `mobile/app/lib`; no new
  `useSyncExternalStore` outside `web/src/sdk/` (text scans).
- **Baseline.** `scripts/boundaries.baseline.json`: a sorted list of `"<file> -> <imported module>"` (and
  `"<file> -> localStorage"`, `"<file> -> protocol gate"`). The test fails on an entry not in the baseline (a new
  violation) and on a baseline entry no longer present (stale: the shrink must be committed). `UPDATE_BOUNDARIES=1`
  rewrites it, as `UPDATE_FIXTURES=1` does for parity fixtures. The test prints the counts per rule so every PR shows
  the shrink.

## Capabilities in `shared`

- `shared/src/features.ts`: `FEATURES = { activity: 1, modeAck: 2, fireLabel: 3, mediaAnchors: 4, agentEvents: 5,
  models: 6, subagentAnchors: 7, taskControl: 8, camera: 9, commands: 10, shellRun: 11, providerModes: 12, pageAnchors:
  13, voice: 14, projectIcon: 15, voiceComments: 16, attachmentAnchors: 17, voiceDetect: 18, commentOps: 19, remote:
  20, accessKeys: 21, restartPending: 22, cutAnchors: 23, polygons: 24, wholePicture: 25, imagesAlone: 26, compactOrder:
  27, remoteHosts: 28, remoteProjects: 29 } as const` (names indicative; a protocol that added several gated things gets
  several names with the same number, e.g. `heldSends: 27` beside `compactOrder: 27`), each entry with the doc comment that today sits in the
  `protocol.ts` history block (moved, not duplicated). `type Feature = keyof typeof FEATURES`;
  `has(protocol: number | null | undefined, f: Feature): boolean`. Re-exported from `@nota-bene/shared`.
- `PROTOCOL` stays a literal; a test asserts it equals the largest entry, so a bump is "add an entry, raise the number".
- The schema gets `"x-features"` beside `"x-protocol"`; the Dart generator emits `enum Feature { activity(1), …; final
  int protocol; }` and `bool hasFeature(num? protocol, Feature f)` into `protocol.g.dart`. The existing `Capabilities`
  type (the provider's capabilities in `hello`) keeps its name; hence `Feature`, not `Capability`.
- Every gate in both apps uses a name. The boundary check counts 22 web and 5 phone product files that compare a
  protocol with a number or a constant: numeric gates (`protocol >= 14`, `protocol < 16`, `< 2`, `< 1`), gates against
  the 14 web constants (`OPS_PROTOCOL`, `IMAGES_ALONE_PROTOCOL`, `PAGE_PROTOCOL`, `TASKS_PROTOCOL`, `SHELL_PROTOCOL`,
  `COMPACT_ORDER_PROTOCOL`, `DETECT_PROTOCOL`, `CUT_PROTOCOL`, `ATTACHMENT_MARKUP_PROTOCOL`, `AGENT_PROTOCOL`,
  `MASK_PROTOCOL`, `REMOTE_PROTOCOL`, `ACCESS_KEY_PROTOCOL`, `COMPUTERS_PROTOCOL`, all in use) and the 4 phone ones
  (`opsProtocol`, `imagesAloneProtocol`, `wholePictureProtocol`, `detectProtocol`), and the `SINCE` table in
  `comments/labels.ts` (becomes a `Feature` per label). Each constant is replaced by its `FEATURES` name and deleted.
- `docs/agent-reference.md` and `architecture.md` §3.3 "Versioning" say: a protocol change adds a `FEATURES` entry; a
  client checks `has(protocol, name)`.

## The host stream's `windows` message

- `shared/src/host.ts`, re-exported from `@nota-bene/shared`: `HostWindow = { id?: string; port: number; provider:
  AgentProvider; root: string; title?; session?; model?; busy?; supervised?; pending?; last?: LastMessage | null;
  replies?: number; icon?: string | null }`, `LastMessage = { role: 'user' | 'assistant'; text: string; at?: number }`,
  `HostStreamMessage = { t: 'windows'; windows: HostWindow[] }`, and `HOST_WINDOW_INFO = ['title', 'session', …,
  'icon'] as const satisfies readonly (keyof HostWindow)[]` (today `INFO_FIELDS` in `server/src/remote/device.ts:18`).
- `id` is optional in the schema: a generated Dart `fromJson` with a required field would throw on every host before
  this release. The channel derives the key in one place, `HostWindow.key => id ?? 'port:$port'` (an extension in
  `nb_channel`); nothing else in the app reads `id` or `port` for identity.
- `AgentProvider` (`'claude' | 'codex' | 'omp'`, today `server/src/agent/provider.ts:3`) moves to `shared/src/agent.ts`;
  `provider.ts` re-exports it, so the server's imports do not change and shared needs no second union.
- The server's own `HostWindow` (`server/src/remote/discover.ts:13`, with `bearer` and `nonce`, used by `device.ts`
  and `connector.test.ts`) is renamed `ProvedWindow`, so the name means one thing.
- The id: `windowKey(provider, root) = provider + ':' + sha1(root).slice(0, 16)` in a new `server/src/windows.ts`. The
  launcher already imports `server/src/*` modules (`bin/nota-bene.mjs:44-48`), so its per-folder lock
  (`bin/nota-bene.mjs:462`, the same hash) uses that helper too. The id survives restarts and port changes and needs no
  persisted state. It is opaque to clients; issue 383 may replace its derivation without a client change.
- **Collisions.** One window per folder per provider is the launcher's rule, not an invariant: `Windows` keys by port
  (`discover.ts`), a launch with `NOTA_BENE_LOCKED=1` or an inner launch skips the lock (`bin/nota-bene.mjs:735,809`),
  and a dev server and a launcher window can register the same root. Rule: among windows with the same key the lowest
  port keeps the bare id and the others get `<id>:<port>`, computed per list in `device.ts`, so every phone sees the
  same ids.
- `device.ts` `#hostStream` builds `HostStreamMessage`; `hostLink.ts:165,232-234` drops its `HostWindowInfo` cast for
  the shared type (a light shape check stays at the parse boundary); `projects.ts` `remoteRows` reads typed rows.
- `gen:protocol` adds `HostStreamMessage` to `ROOTS` (it reaches `HostWindow`); `mobile/channel` takes `nb_protocol`
  as a real dependency (today dev only) and its hand-written `HostWindow` and `LastMessage`
  (`channel.dart:50-110`, `iconSupported: j.containsKey('icon')`) give way to the generated ones; `withIcon` and `key`
  are extensions.
- **No protocol bump.** `PROTOCOL` covers browser↔window; the host stream is the channel's (CHANNEL.md "version 1"),
  whose rule is that a peer ignores fields it does not know. `id` is an additive, optional field. A phone that meets a host
  without it (any host before this release) keys the window as `port:<n>`, as today. CHANGELOG gets no entry: nothing
  changes for the user.
- The phone keys windows by `(hostId, window.id)`: `notify/visible.dart` `ChatPlace`, `home.dart` `lastChat` (read once
  in the old `"host port root"` form and rewritten), `hosts/host_link.dart:76-87`, `chat/window_tab.dart` `_box` and
  lookups by port. Port is used only to open `ws`/`http` streams. `iconSupported` becomes one flag per host
  (`Channel.iconsSupported`: a list carried `icon`), so a desktop from before project pictures offers no Set icon.
- `server/src/remote/CHANNEL.md`: the host stream section lists the real fields (`id`, `icon` were missing), states
  that a phone ignores fields it does not know and treats every field but `port`, `provider`, `root` as optional, and
  gains a "Reconnects" section (the phone reopens a `ws` stream after 4904 once the window is listed again; the host stream
  is the online state; backoff is the link's).

## The phone mirror

Same names, native implementations. Where a name maps to nothing useful in Flutter, the doc says so instead of
inventing one.

| Web | Phone |
|---|---|
| `AgentConnection` | `WindowConnection` (`chat/window_connection.dart`): the mux stream, open/close, reconnect, passive and takeover, `send`, `has(Feature)`; split out of `WindowTab` |
| window state | `WindowState` (`chat/window_state.dart`, `ChangeNotifier`): feed, models/mode/effort, held sends, compaction and restart pending, stats; `apply(ServerEvent)` |
| `WindowTab` | stays as the per-window composition (screens use it): owns one `WindowConnection`, one `WindowState` and the window's feature controllers (`Comments`, voice outbox, `MediaCache`), no logic of its own |
| `repository` | `Repository` classes over `WindowHttp` with generated types: `FilesRepository` (`files/remote.dart`: `/tree`, `/complete`, `/file`), `GitRepository` (`files/git.dart`), `IconRepository` (`hosts/project_icon.dart`). No shared poll object: the host stream pushes the window list, and the one data poll left (`/dictation` in `dictation/whisper_sheet.dart`) does not pay for one |
| `storage` | `AppStores`: the record of vault-backed stores built in `main.dart` `_load` (hosts, seen, notified, notify choice, voice lang, voice outboxes, comment queues, project icons), replacing `CommentQueues.instance`, `VoiceStore.instance`, `ProjectIcons.instance` and the resets in `test/support/rig.dart:58-60` |
| `Sdk` | `Sdk` (`lib/sdk.dart`): `{ AppStores stores; Links links; Identity id; Background background }`, passed down where `_load`'s record is today |
| capabilities | generated `Feature` / `hasFeature`; `WindowConnection.has(f)` |
| registries | none. Events and anchors are generated sealed classes and the feed items hand-written sealed classes (`chat/feed.dart`); an exhaustive `switch` is the registry and the compiler checks completeness. Screens are pushed routes. A Dart registry would add indirection and lose that check |
| i18n | ARB stays; the two crash-prone lookups go: `'mode_${m.toJson()}'` (`window_tab.dart:52-58`) becomes a generated exhaustive map, `m['en']!` (`strings.g.dart:40-43`) a typed accessor; the generator's hand-coded Russian plural rule uses `Intl.plural` |

UI↔model leaks are cut where they are: `ago` moves from `hosts/hosts_screen.dart` to `ui/time.dart`; the voice
directory from `voice/player.dart` to the voice store; `resolveLocale` from `main.dart` to `l10n/locale.dart`. A small
`test/imports_test.dart` keeps them cut: nothing in `lib/` imports `main.dart`, and model and store files (`store/`,
`chat/feed.dart`, `chat/session_state.dart`, `chat/window_*.dart`, `comments/comments.dart`, `comments/queue.dart`,
`voice/outbox.dart`, `notify/`) import no `*_screen.dart`, `*_sheet.dart` or `voice/player.dart`.

## The feed golden fixture

- `web/src/store/feedParity.test.ts` drives `reduce()` (`store/feed.ts`) with fixed `ServerEvent` sequences (a replay,
  streamed chunks, tool call/update/result including Agent calls, permission and answer, plan, shell run, compaction and
  `earlier`, held sends, voice text, an unknown kind) and writes the result as
  `mobile/app/test/fixtures/feed/<case>.json`: `{ events, items }`, where `items` is a projection of fields both models
  hold (kind, id, text, final, tool name/arg/result/isError, permission answer, `phase`). `phase` is computed by a
  function in the test file from the item's `toolKind` and name, not added to `store/feed.ts`: the web has no phase,
  so it is a fixture expectation for the phone's table only. It checks the file equals its
  output; `UPDATE_FIXTURES=1` rewrites it, as the media and anchor parity tests do.
- `mobile/app/test/feed_test.dart` replays each case through `Feed.apply` and compares the same projection, replacing
  "applies without throwing" (`feed_test.dart:23`).
- The phone's second tool→phase table (`chat/session_state.dart:14-38`) is covered by the fixture's `phase`; it keys
  on the normalized `toolKind` (`shared/src/agent.ts`) first and the tool name second.

## vcs and other HTTP answers through the generator

`ROOTS` gains `VcsDiff`, `VcsPatch`, `VcsLog`, `VcsCommitDetail`, `GitSwitchAnswer` (already re-exported from
`protocol.ts`, so the generator reaches them with no new source path) and `TreeEntry`; answers the phone parses by hand
without a shared type (`/complete`, the project icon's `/info.icon`) get one in `shared/src/protocol.ts`.
`mobile/app/lib/files/git.dart:7-40` and the hand parses in `files/remote.dart` and `hosts/project_icon.dart` use the
generated classes. Each new root gets a fixture in `shared/fixtures/protocol.json`.

## Testing harness (`web/src/testing/`)

- `testStore({ plugins?: Plugin[] = PLUGINS; events?: ServerEvent[]; hello?: Partial<HelloEvent>; state?: ConnState })
  → { store, conn: FakeConnection }`: wraps `makeStore` with a fake connect (today copied into 101 test files).
- `FakeConnection { sent: ClientMessage[]; emit(ev); setState(s); }` (13 hand-made fakes today).
- `stubRoutes({ [route: string]: Json | ((req: Request) => Response | Promise<Response>) }) → { calls; restore() }`:
  one fetch stub keyed by path (57 files stub fetch by hand); an unmatched route answers 404 and is recorded.
- `renderWith(ui, opts) → RenderResult & { store; conn }`: `testStore` plus `Provider`, `TooltipProvider`, the registry.
- `events.hello(p)`, `events.session(p)`, `events.user(p)`, `events.agent(e)`: typed builders.
- `cut/testCut.tsx` is rebuilt on top of it. Tests move to the harness when a step touches them; no bulk rewrite.

## `docs/architecture.md`

§4.1 "Organised by feature" becomes "Core, SDK and plugins": the folder table above, the import rule and the baseline.
§4.2 "Store" describes `combineSlices` with injected plugin slices and `PluginState`; the 16-slice list is grouped by
owner. A new §4.5 "SDK and registries" holds the registry table and the data/storage rules (resources, prefs, `track`,
flags). §3.3 "Versioning" points at `FEATURES`. §2.3 names `HostWindow.id` and the phone's `Sdk`, `WindowConnection`,
`WindowState`. §7 "Testing" names `web/src/testing/` and the feed fixture. AGENTS.md's project map adds one line:
`web/src/sdk/` is the only import of a feature folder (the rule's test and baseline in `scripts/`).

## Risks

- `combineSlices` injection and module augmentation change how `RootState` is inferred; a mistake surfaces as type
  errors across 91 files. Mitigation: the store step changes no plugin code and is proved by `tsc -b` plus the full
  web suite before any import moves.
- Moving components behind registries can reorder the DOM (slots, tab panes); e2e selectors and focus order depend on
  it. Mitigation: `order` values reproduce today's order; the e2e suite runs on the registry steps.
- The window id changes persisted phone keys; a botched migration loses a draft voice outbox or comment queue.
  Mitigation: the queues stay keyed by `hostId|session` (session, not window); only the window lookup changes; a test
  covers the old `lastChat` form.

## Calls made

1. **Import rule = a dependency-free Vitest test** (a newline-tolerant regex over whole files), not dependency-cruiser:
   TypeScript 7 has no compiler API and the repository has no ESLint. oxc via `rolldown/utils` only if a step-1
   fixture case cannot pass.
2. **Type-only imports count** as violations; **test files are exempt** from plugin→plugin and core→plugin, and
   `@/testing` is test-only.
3. **Plugins import `@/sdk` and `@/sdk/ui` only**, not other core folders directly; the 398 plugin→core imports are in
   the baseline and shrink by codemod as the SDK re-exports grow.
4. **No folder moves into a `core/` directory**: core is a list of existing folders; new core code goes in
   `web/src/sdk/`. Exceptions: `tree/` merges into `files/`, `shell/UpdateNotice.tsx` becomes `update/`, four shell
   files move to their plugins.
5. **Composition root = root-level files** (`main.tsx`, `App.tsx`, new `plugins.ts`), no `app/` folder.
6. **Plugin state via RTK 2 `combineSlices` + `inject` + module augmentation** of `PluginState` and `TabKinds`.
7. **`MediaController` stays core** (tab-level pause/PiP service), exposed as `useMedia`.
8. **One extra registry, `sendParts`**, and a `Plugin.pause` predicate, both needed to break the composer↔comments
   cycle and `shell/pagePause.ts`'s imports.
9. **Capability table named `FEATURES` / `Feature`, function `has`**: `Capabilities` is taken by the provider's
   capabilities in `hello`. Several names may share a number; `PROTOCOL` stays a literal checked against the table.
10. **Window id = `provider:sha1(root)[0..16]`** from one helper in `server/src/windows.ts` shared with the launcher's
    lock; derived, not persisted, opaque to clients, optional in the schema. Duplicates (unlocked launches, a dev
    server): the lowest port keeps the bare id, the others get `<id>:<port>`.
11. **No protocol or channel version bump** for `id`: optional and additive under CHANNEL.md's ignore-unknown rule;
    the channel's `key` falls back to `port:<n>` in one place. No CHANGELOG entries in the epic unless a step changes behavior.
12. **Web agent id is `'self'`** until issue 383; `serverEvent` carries it in `meta` now, the `conn` slice keeps one
    state.
13. **`track` is an in-memory ring of 200 events** with `track.recent()`; nothing persisted or sent.
14. **Flags are `storage.local('nb.flag.<name>')` over a typed `FLAGS` table**, empty today; no UI.
15. **Storage keeps every current key** unchanged, so no migration of saved UI state.
16. **No Dart registries**: sealed generated types and exhaustive switches already are the registry. Dart gets `Sdk`,
    `AppStores`, `WindowConnection`, `WindowState`, `Repository` classes and `Feature`.
17. **No Dart folder lint**, only the small import test of call 25: a full rule there would cost more than the
    remaining risk.
18. **Feed fixture lives in `mobile/app/test/fixtures/feed/`**, written and checked by a web test, as the other
    parity fixtures are.
19. **Test migration is opportunistic**: the harness lands early; tests move when a step touches them.
20. **Route builders live in the web SDK, not `shared`**: the server's route table and the phone build paths their own
    way; the answer types are what must match, and they go through the generator.
21. **`AgentProvider` moves to `shared/src/agent.ts`** (re-exported by `server/src/agent/provider.ts`); the server's
    proved window type is renamed `ProvedWindow`.
22. **Repository events come from `AgentConnection.onEvent`**, called after the store applied the event. The
    connection is the single owner of connection state; the store mirrors it with one `connState` dispatch.
23. **Root change**: core dispatches `enterRoot({ root, first })`; each owner restores its own saved state in its own
    listener; order is core first, then `PLUGINS` order.
24. **One state rule** (slice / `useResource` / `storage` / component state); no new `useSyncExternalStore`
    singletons, counted by the boundary check.
25. **A Dart import test** (`test/imports_test.dart`) for the two leak classes the review found, instead of a lint.
