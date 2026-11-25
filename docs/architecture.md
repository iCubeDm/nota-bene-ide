# Nota Bene architecture

How the parts fit. Operational rules and the security model: [agent reference](agent-reference.md). User-facing behavior: [guide](guide.md).

## 1. Overview

Nota Bene is a local web application. One **window** is one server process, one project folder, one port from 4777 to 4799 and one agent session (Claude Code, Codex or omp). The provider is fixed at launch; session discovery and persisted state are scoped to it. One browser tab works with the window (the owner); other tabs see "the window is already open" and can take it over.

All providers implement the same `AgentBackend` / `AgentSession` contract. The
server selects one at startup; the browser consumes normalized events and declared
capabilities. Claude SDK types, Codex RPC frames and ACP frames stay inside their adapters.
omp runs on a generic ACP adapter (`agent/acp/`): transport, mapper and session are
agent-neutral; `acp/omp.ts` is the profile with omp's binary, launch flags, approval-form
wording, hidden commands and error texts.

```mermaid
flowchart TB
  subgraph Browser["Browser (the window's owner tab)"]
    UI["React UI"] --> RS["Redux store"]
    RS <--> WSC["sdk/connections.ts over net/socket.ts"]
    UI -- fetch --> HTTPC["sdk/repository.ts: shared reads"]
  end
  subgraph Server["The window's Node server (server/src)"]
    HTTP["http.ts: Host/Origin filter, auth and router"]
    WSS["WebSocketServer /ws"]
    HUB["EventHub: history and broadcast"]
    ARC["HistoryArchive: history before compactions"]
    SM["SessionManager"]
    SH["ShellRunner: ! commands"]
    STORES["CommentStore · AttachmentStore · MarkFiles · prefs · state"]
    FR["fileRoutes · git · system"]
    AB["AgentBackend / AgentSession"]
    SDK["agent/claude: Claude Agent SDK"]
    CX["agent/codex: session, mapper, controls"]
    RPC["CodexRpc: JSON-RPC over stdio"]
    ACP["agent/acp: session, mapper, omp profile"]
    ARPC["AcpRpc: ACP JSON-RPC over stdio"]
  end
  CLI["Claude Code CLI (SDK-owned child)"]
  CODEX["codex app-server (adapter-owned child)"]
  OMP["omp --approval-mode M acp (adapter-owned child)"]
  L["bin/nota-bene.mjs: launcher and supervisor"]
  WSC <--> WSS
  HTTPC --> HTTP
  WSS --> SM
  SM --> HUB --> WSS
  SM --> ARC
  SM --> SH
  SM --> AB
  AB --> SDK --> CLI
  AB --> CX --> RPC --> CODEX
  AB --> ACP --> ARPC --> OMP
  HTTP --> FR
  HTTP --> STORES
  L -- "spawn, exit code 75 = restart" --> Server
```

**Packages** (npm workspaces):

| Package | Contents |
|---|---|
| `shared/` | The contract shared by web and server. `protocol.ts`: the protocol types (`ClientMessage`, `ServerEvent`, `Comment`, `Anchor`, `MediaShape`, `Capabilities`), the validator `parseClientMessage` and the `PROTOCOL` version. `features.ts`: `FEATURES`, what each protocol added by name, and `has`. `agent.ts`: the normalized `AgentEvent` and `AgentProvider`. `host.ts`: the host stream's window list (`HostWindow`, [2.3](#23-remote-relay)). `tasks.ts`: the pure task reducer `reduceTasks`. |
| `server/` | In a checkout, Node >= 23.6 runs the `.ts` files directly, with no build. The published package ships the server compiled to plain JS (Node >= 22). Dependencies: `@anthropic-ai/claude-agent-sdk` and `ws`, nothing else (no HTTP framework). |
| `web/` | React 19, Redux Toolkit 2, Radix UI, Tailwind 4, Vite 8. Markdown on `marked` + `dompurify` + `highlight.js` + `mermaid`. Fonts (Inter, Geist Mono) are bundled; the page makes no request to a font service. |
| `bin/nota-bene.mjs` | The launcher: port choice, folder lock, rebuild of a stale `web/dist`, supervision, and the helpers `--find`, `--last`, `--url`, `--front`. |
| `codex/` | Codex marketplace plugin (`plugin.json`) and CLI/Desktop skill (`skills/nb/`). `.agents/plugins/marketplace.json` selects this plugin for Codex. |
| `omp/skills/nb/` | The omp skill (`/skill:nb`): `open.mjs` opens a detached omp window, `new`, or a fork of the invoking omp session. |
| `plugin/skills/nb/` | The `/nb` skill for Claude Code (inside the plugin `plugin/`): `node open.mjs --plan / --wait / --run` (a Node script, so it runs on Windows too). |
| `e2e/` | Playwright on scripted fake agents, plus Codex and omp browser acceptance through fixture agents (`codex.config.ts`, `omp.config.ts`). |
| `relay/`, `mobile/` | The Go relay for remote access and the Flutter phone app ([2.3](#23-remote-relay)). |

## 2. Processes and lifecycle

```mermaid
sequenceDiagram
  participant CC as Invoking CLI or local Desktop
  participant L as Launcher
  participant S as Window server
  participant A as Provider runtime
  CC->>L: nota-bene dir --agent claude, codex or omp
  L->>L: provider state, folder lock, free port, checkout build if stale
  L->>S: spawn main.ts (NOTA_BENE_LAUNCHER_PID, NOTA_BENE_SUPERVISED=1, NOTA_BENE_NONCE)
  S->>S: windows/PORT.json, resume the last session
  alt Claude
    S->>A: SDK query() owns Claude CLI
  else Codex
    S->>A: spawn app-server, initialize, thread/start or resume or fork
  else omp
    S->>A: spawn omp acp, initialize, session/new or load
  end
  Note over S,L: exit 75 = immediate restart with --continue<br/>0, 130, 143 = stop, anything else = crash: restart after 1 s, give up at 5 in 60 s
  S-->>L: IPC channel closed = launcher gone = exit
```

- **Supervision runs both ways.** The launcher restarts the server. The server exits by itself if the launcher is gone (`watchLauncher`): it is spawned with an IPC channel and stops when the channel closes, which also carries the launcher's stop message (Windows has no SIGTERM). A foreground launcher in turn stops when the shell that started it is gone (`watchParent`), unless it is a `--detach` child. Launcher environment variables that were not inherited from the direct parent are dropped (`dropInheritedLauncherEnv`), so a test server started from inside a window does not think it is supervised.
- **The launcher's secrets.** A per-launch nonce, kept by exit 75 and replaced after a crash ([Access token](agent-reference.md#access-token)).
- **The window registry** `~/.nota-bene/windows/<port>.json` serves "one window per folder per provider". Codex and omp keep theirs under `providers/<provider>/`, with their own locks and tokens. A launch takes a per-folder lock (`locks/<hash>`), then gives way to a window already serving the folder, waiting up to 10 s for one that is in its restart gap.
- **The Whisper host.** Dictation and voice messages share one detached `host.js` process per state folder (`server/src/dictation/hostMain.ts`), which holds the one Whisper model, takes every window's jobs over a private unix socket (Windows: a named pipe) in one round-robin queue, and exits after 10 minutes idle. A window that cannot use it runs the model itself. Details: [Whisper host](agent-reference.md#whisper-host).
- **Control between servers.** A server (the project switcher's stop, the launcher) sends `POST 127.0.0.1:<port B>/control/<action>` with the token from `<stateDir>/control-token` (mode 600). `/control/*` rejects any request that has an `Origin` header, so only a server can reach it, never a page.

**Invoking-host lifetime.** Claude's `/nb` owns a background launcher tied to its
calling session. The Codex skill uses an owned background process in CLI, or
`--detach` from local Desktop. A detached supervisor survives the end of the
invoking turn; explicit Stop in the window ends it. A window already open for the
same project and provider is brought forward; a requested new/fork is not applied
to that existing conversation. Fork requires the invoking host's actual session id.

### 2.1 Package

`scripts/build-package.mjs` builds the npm package into `pkg/`. The server and the launcher are bundled by esbuild into JS at the same directory depth as the sources (so the relative `import.meta` paths to `web/dist` stay correct), `@nota-bene/shared` is inlined, the Whisper host is a third bundle (`server/src/host.js`, beside `main.js`), and `web/dist` is built fresh. The installed package has no `web/src` and no `.git`: the launcher never builds, `codeChanged` is always false, and the version comes from `package.json`. Claude's `/nb` skill finds the launcher in a checkout first, otherwise it installs the package `nota-bene-ide@<plugin version>` into the plugin's data folder on the first run.

### 2.2 Codex plugin distribution

The repository has separate marketplaces for the two hosts: Claude reads
`.claude-plugin/marketplace.json` and installs `plugin/`; Codex reads
`.agents/plugins/marketplace.json` and installs `codex/`. The latter contains a
portable `plugin.json`, `skills/nb/SKILL.md` and `open.mjs`. The skill runs the helper
through `npm exec --yes --omit=optional --package=nota-bene-ide@<version> -- node ...`,
so first use fetches the pinned runtime and later uses npm's cache. `--omit=optional`
skips the SDK's per-platform Claude binary (about 70 MB instead of 330 MB); the SDK's JS
stays and loads, and only a Claude session would need the binary. No global npm installation
or manual skill copy is required. The helper selects `--agent codex`, handles
CLI/Desktop lifetime and redacts browser login fragments from its output.

The npm archive holds the compiled application and the standalone Codex and omp skills;
the marketplace manifest comes from GitHub. A `v<version>` tag identifies the exact npm
source; plugin or docs changes may follow it on `main` without replacing the archive.
The marketplace is for local clients, not a listing in the public ChatGPT plugin directory.

### 2.3 Remote relay

`relay/` holds `nb-relay`, a separate Go program for remote control: a stateless WebSocket hub that pairs a host (the Nota Bene server on a computer) with its devices (phones) by host id and forwards opaque frames. It stores nothing except the TLS certificate cache, and its admission checks are only a noise filter; the real authentication and confidentiality are the end-to-end handshake between host and phone. The hub is the importable Go package `relay/hub`; `relay/cmd/nb-relay` wraps it with TLS and flags, and with `-members` admits only hosts whose hello is signed by an operator-issued Ed25519 access key, a set number of hosts per key, from a file it re-reads (`members.go`; `invite`, `revoke`, `limit` and `members` edit it). The wire contract is [relay/PROTOCOL.md](../relay/PROTOCOL.md); building, running and the container image are in [relay/README.md](../relay/README.md).

The host side is `nota-bene remote` (`server/src/remote/`), one process per user. It keeps one outgoing connection to the relay (`relayClient.ts`), finds the windows of all three providers in their registries and proves each with that provider's token before sending anything (`discover.ts`), and runs one end-to-end channel per phone connection (`device.ts`): Noise IK (`noise.ts`, on `node:crypto`, checked against the official vectors), then a stream mux with per-stream and per-connection credit (`mux.ts`) carrying the host's window list, WebSockets to a window's `/ws` and HTTP requests to its routes, with the window's helper bearer added on the host. Pairing, the device list and revoking are in `connector.ts`; `pair`, `devices` and `revoke` reach the running connector over a Unix socket (`control.ts`). Every window keeps one connector running while a relay is saved (`keeper.ts`, as the Whisper host is kept), serves the Remote tab's `/remote` routes (`routes.ts`) and sends the page its state as the `remote` event. The channel's contract, for the phone's implementation, is [server/src/remote/CHANNEL.md](../server/src/remote/CHANNEL.md). The same connector is also a device of other computers (issue 297): `hostLink.ts` is the device end of the channel (relay admission as a device, the Noise initiator, the mux), with its own `device.key`; `pairHost` pairs with another computer's code, and one `HostLink` per computer in `hosts.json` keeps the channel and that computer's `windows` list. A window keeps the connector running for these links even with no relay of its own. A window's `GET /system/projects` adds each online computer's windows as rows with `remote: {host, name}` (the connector's `computers` control op; `projects.ts` `remoteRows`), and `POST /system/remote/open` has the connector open a desktop proxy for one (`proxy.ts`): a loopback listener per open on a port the system picks, outside the windows' range, served as `localhost` while the windows stay on `127.0.0.1`, so the other computer's pages and this one's windows share no cookie and are different sites. It runs its own auth with the window's code (`auth.ts`: token, login, cookie, key, the `nb.<key>` subprotocol, the Origin) and strips it; requests go over the channel as `http` streams with the helper bearer added on the other computer, before the page logged in as `public` streams without it (the app shell only), and `/ws` as a `ws` stream. It answers `GET /system/remote/page` (`{host, name}`: the page hides what that computer's page cannot do, `web/src/core/net/local.ts`) and `/system/projects` itself (this computer's and other computers' rows bare: folder, agent, port, state, no title, session or last message, `projects.ts` `bareRow`), and refuses the rest of what a device may not reach (`device.ts` `goodPath`) with 403. The switch from such a page is a top-level navigation to its `/system/remote/enter`, which only a same-origin navigation passes (`Sec-Fetch-*`) and which answers with a 303 to the target's login: page code never reads the redirect or its fragment, so it never holds a credential for this computer's windows. A switch that cannot go comes back as a 303 to `/?enter=<code>`, which the page says in words; a navigation the window cannot answer (the computer offline, or an older one that refuses `public`) gets a short page in the person's UI language, kept in `proxy.ts` since the app never loaded. Requests carrying `Service-Worker` are refused, and a listener never takes a port an earlier one of the process had. A listener closes a minute after its last connection, and keeps the connector up while it lives. All of a computer's tabs share its one channel (64 streams, 512 KiB window).

The host stream's `windows` message is typed in `shared/src/host.ts` (`HostWindow`, `HostStreamMessage`, `HOST_WINDOW_INFO`) and generated for Dart. Each window carries `id = windowKey(provider, root)`: the provider, a colon and the first 16 hex digits of the root's sha1 (`server/src/windows.ts`, the hash of the launcher's per-folder lock). It survives restarts and port changes and is opaque to clients. Among listed windows with one key (an unlocked launch, a dev server) the lowest port keeps the bare id and the others get `<id>:<port>` (`device.ts`). The field is optional: a host before it is keyed `port:<n>` (`HostWindow.key` in `nb_channel`). The port only opens streams.

The phone side is in `mobile/`: `mobile/channel` (`nb_channel`, pure Dart) is the same channel from the other end (Noise IK on the `cryptography` package, checked against the same vectors and worked examples; the mux; relay admission), proved end to end against the real relay and connector by `cross_test.dart`, which drives `server/src/remote/crossHost.ts`. `mobile/app` (`nb_app`, Flutter, Android) uses the protocol types generated into `mobile/protocol`, including `Feature` and `hasFeature`. `main.dart` `_load` builds one `Sdk` (`lib/sdk.dart`: `AppStores`, the host `Links`, the phone's `Identity`, the `Background` check) and passes it down; `AppStores` holds the vault-backed stores, the voice outboxes, the comment queues and the project pictures, so no store is a singleton and a test builds its own in memory. The app keeps one link per paired host (`hosts/host_link.dart`) and keys a window by `(host id, window key)`. It is an ordinary tab of a window over that link: `WindowTab` (`chat/window_tab.dart`) composes an `AgentConnection` (`chat/agent_connection.dart`: the stream, reconnects, passive and takeover, `send`, `has(Feature)`, `http`), a `Repository` over it (`files/repository.dart`: the window's reads, one in flight per route) and a `WindowState` (`chat/window_state.dart`: the feed, a port of `web/src/core/store/feed.ts`, the models, mode and effort, held sends, a pending compaction or restart, stats; `apply(event)`) and its `Tasks` (`tasks/tasks.dart`: the port of `shared/src/tasks.ts`, which tells only when the tasks change), with the window's comments, voice outbox and media cache, and sends through `send` and `sendVoice`, the question passed in. The screens read the parts themselves; the feed alone listens while a reply streams. `LinkLife` (`hosts/link_life.dart`), made beside the links, decides when they run; the notifications only hold them. Build and test commands are in [mobile/README.md](../mobile/README.md).

### 2.4 Projects across windows

Until one server holds every project (design: [one tab for all projects](superpowers/specs/2026-11-15-one-tab-projects-design.md)), the header's project switcher works over today's windows. The current window's server reads every provider's registry and proves each listener with that provider's token, as the connector does (`server/src/projects.ts`). To move a tab, it derives the target's login value from that token, the port and the proved nonce, exactly as the launcher's `loginTarget` does. The value goes only into the JSON answer; the page navigates to it. To open a folder, the server opens it as one of its agents itself and answers that agent's URL (`server/src/projectRoutes.ts`); its own agents are listed, entered and closed in-process too, only other servers are asked over HTTP. The launcher and that route record each opened folder in `recent.json` in the base state folder (`server/src/recent.ts`). The web side is `web/src/plugins/projects/`.

The menu is a list of chats: the web folds the windows of one folder into one row (`rows.ts`) and shows one badge, `!` for a window that waits, else the replies not seen. A window keeps, per session, when the person last saw it (`seen-sessions.json` in its provider's state folder, `server/src/seen.ts`); its page posts `/seen` while it is visible and focused, and `/info` reports `unseen`, the final replies after that time (a time, not a count: a compaction drops replies from the history). Another window's sessions come through `POST /system/projects/sessions`, which proves the window as above and reads its `/sessions` with the helper bearer. Opening a session in another window rides on the login hand-off: the URL is `#t=<login>&s=<id>` (or `&s=new`), and that page switches once it is logged in (`web/src/plugins/projects/landing.ts`); no server-to-server switch is needed.

## 3. Server

### 3.1 Modules

| Module | Responsibility |
|---|---|
| `main.ts` | Argument parsing, choice of what to resume, exit code 98 when the port is taken, the launcher watchdog. |
| `server.ts` | The server: one listener, its login and home page, the process's exit, update and restart; it opens, keeps and closes its agents. |
| `agent.ts` | One agent, under `/a/<id>/`. Composition: the stores, `SessionManager`, the HTTP router and the WSS; the dispatcher of WebSocket messages and the link between comments and the session. One tab per window (owner socket, 700 ms reload grace, 30 s ping, `takeover` closes the old owner with 4001, `?passive=1`). Messages the agent's `capabilities` forbid are rejected as `server-error`. |
| `auth.ts` | The access token and every value derived from it ([Access token](agent-reference.md#access-token)). |
| `stateGuard.ts` | Knows the folders that hold secrets (the current state folder and the two default ones) and refuses to serve, list or search anything inside them. |
| `http.ts` | No framework. Order: Host allowlist, then `/control/` (token, no Origin) or Origin for non-GET, then the open routes (`/auth`, `/hello`), then auth for everything else, then the routes, `/info`, and last the static files of `web/dist` with an SPA fallback. |
| `hub.ts` | `EventHub`: the in-memory event history of the current session. A connecting socket gets `replay` (with `earlier`, the number of archived segments), then live events. `reset()` replaces the history (switch, `/clear`, restart). `cut()` moves everything before a compaction boundary into the archive; some events (sends not yet finished) stay in both the history and the archive. |
| `archive.ts` | `HistoryArchive`: `history/<sid>.jsonl`, one line per segment (the conversation before a compaction), fsync on write, a broken line is skipped. The route `/history?session=&before=`. |
| `subagent.ts` | `GET /subagent?session=&tool=`: the conversation of the subagent started by an Agent call, through `AgentBackend.subagent(...)`. The Claude backend maps the tool-use id to the agent id from `agent-<id>.meta.json` (not an SDK API; read only in `agent/claude/subagents.ts`); Codex reads native child threads. |
| `taskOutput.ts` | `GET /task-output?session=&task=`: the tail of a background shell or Monitor task's output (Claude: SDK `get_task_output`; Codex declares `taskOutput: false`). |
| `session.ts` | `SessionManager`, a facade: `pump()`, the wiring of the parts, and the public methods (`send`, `switchTo`, `restart`, `setMode`, `shellRun`, …). |
| `session/` | The manager's parts: `phase` (the phase `live / switching / closed`), `turns` (`TurnLedger`: accounting of sends), `permissions` (`PermissionBroker`), `title`, `agentSlot` (the agent and its generation `gen`), `identity` (id, root, model, fork), `mode`, `sendQueue`, `target` (check of a switch target), `archiveCut` (the cut at `compacted`), `history` (loading the feed), `idleWiring`, `images`, `options`, `types`, `commands` (`CommandKeeper`: the slash menu's list) and `shell` / `shellText` (`ShellRunner`: the `! cmd` runs, below). |
| `agent/types.ts` | The interfaces `AgentBackend` / `AgentSession`, the seam for replacing the agent. The agent produces `AgentEvent`; `capabilities` declare what it can do. |
| `agent/claude/` | The Claude backend: `sdk.ts` (`query()` with streaming input, `canUseTool` to `PermissionAsk`, the `claude_code` preset prompt plus `APPEND`, `--chrome` for the browser tools), `map.ts` (SDK frames to `AgentEvent`, the only place SDK keys enter the stream), `transcript.ts` (replay), `commands.ts` (the `/` menu: commands and skills, plus the built-ins in `BUILTIN_OK`, never one the CLI tags `terminal_slash_commands`). |
| `agent/provider.ts`, `agent/bin.ts` | Validates `claude` / `codex` / `omp` and derives provider state folders (Claude is the default); the one way to spawn an agent CLI. |
| `agent/codex/` | The Codex adapter over its owned `codex app-server` ([3.5](#35-codex-adapter-and-native-ownership)). A CLI older than `CODEX_MIN_VERSION` is refused before any native call. |
| `agent/acp/` | The generic ACP adapter (`rpc.ts`, `map.ts`, `session.ts`, `backend.ts`); `omp.ts` is the omp profile. |
| `agent/fake.ts` | A scriptable backend for e2e. |
| `tmpImage.ts` | `GET /tmpimage?path=`: an image the agent left in a system temp folder, key tier only ([Access token](agent-reference.md#access-token)). |
| `prompts.ts` | `PromptStore`: `prompts/<sessionId>.jsonl`, the prompts sent (`typed`, `shell`, `voice`). They cannot be rebuilt from the transcript (batches and `! cmd` are rewritten there), so the page POSTs each one the server has taken. |
| `comments.ts` | `CommentStore`: `comments/<sessionId>.v2.json` `{v: 2, rev, items, removed}`. `rev` grows with every change; `removed` keeps the last 500 deleted ids, so no add brings one back. `apply()` takes a client's ops all or none, `merge()` an older client's whole set. A session without an id lives in memory until `adopt()`. |
| `attachments.ts` | Content-addressed images (`sha256.ext`) up to 3.75 MiB, and voice recordings (`sha256.wav`, protocol 14). `POST /attach`, `GET /attach/<id>`, restoring from the trash. |
| `voice/`, `dictation/` | Voice messages: `POST /voice` stores a 16 kHz mono WAV, `GET /voice/<id>` serves it, `POST /voice/<id>/text` transcribes it through the Whisper host. A `send` with `voice` is transcribed in the send queue before the agent gets the text. `dictation/` holds the install, the host and its client. |
| `marks.ts` | The marks in the project folder: `<root>/.nota-bene/marks/<commentId>/{frame.jpg,layer.png,mask.png}` (`mask.png`: a drawing with polygons), with a self-ignoring `.nota-bene/.gitignore` (`projectDir`, which the video editor's reversed copies in `.nota-bene/reverse/` share). Magic-byte check, symlinks refused. |
| `fileRoutes.ts`, `files.ts`, `git.ts` | `/tree`, `/file` (Range, sandbox headers), `/complete`, `/sources`, `/git-status`. Sources: the current checkout, other worktrees (from disk) and branches (through git blobs). |
| `vcs.ts` | The read-only git views: `/vcs-diff`, `/vcs-file`, `/vcs-branches`, `/vcs-log`, `/vcs-commit`, `/vcs-commit-file`. Every call runs with `--no-optional-locks`, so polling never takes `index.lock` from an agent. A failed git is a 503, never an empty answer. |
| `system.ts` | Settings: about, prefs, storage and cleaning into the trash, windows, the control token. |
| `projects.ts`, `projectRoutes.ts`, `recent.ts`, `seen.ts` | The project switcher ([2.4](#24-projects-across-windows)). |
| `update.ts`, `runtime.ts`, `updater.ts` | The in-app update ([agent reference](agent-reference.md#in-app-update)). |
| `restartGate.ts`, `turnMarks.ts` | The deferred server restart and the cut-turn note. |
| `osFiles.ts`, `fileEdit.ts`, `gitSwitch.ts` | Reveal and Open on the desktop, saving an edited file, switching the checkout's branch. |
| `cut/` | The video editor's server side: export with ffmpeg, new edits, waveform peaks, reversed copies of clips for the preview. |
| `remote/` | The remote connector ([2.3](#23-remote-relay)). |
| `sessions.ts` | The route `/sessions`, titles, and each Claude session's working folder from the head of its transcript. |
| `range.ts`, `errors.ts`, `codeStamp.ts` | HTTP Range parsing; `reportError` / `guard` (a failure becomes a `server-error` event); "the server's own sources changed since start" for `/info`. |
| `audit.ts` | `AuditLog`: `<NOTA_BENE_HOME>/audit/YYYY-MM-DD.jsonl`, one `appendFileSync` per line so windows sharing a day file never cut into each other's lines. It taps the hub and the owner's client messages, and keeps only names, ids, counts and numbers, never text. A failed write turns the log off for the run, never the window. |
| `prefs.ts`, `state.ts`, `windows.ts` | JSON state files (written through tmp + rename). `state.ts` also owns the state folder (created 700) and refuses one owned by another user. |
| `stats.ts`, `idle.ts` | Context, limits and cost through `AgentSession` (Codex cost is unknown). Idle compaction. |

`usage/` is independent of the session: `parse.ts` turns transcript lines of Claude and Codex into normalized records, `importer.ts` reads new bytes incrementally under a lock, `store.ts` keeps `<NOTA_BENE_HOME>/usage/`, `report.ts` builds the `UsageReport`, `routes.ts` serves it. The only link to a live session is `onStats`, through which main.ts records Claude's limit readings, which no transcript keeps.

### 3.2 How SessionManager works

`createSessionManager` is the facade in `session.ts`: it owns `pump()` and ties together the parts in `session/`. Each part owns its own state; the strictness is where the server itself makes the transition.

- **Window phase (`Phase`).** `live → switching → live` and the irreversible `closed`. Closing in the middle of a switch makes the phase `closed` at once, but `switching` holds until `endSwitch()`; no new agent starts.
- **Accounting of sends (`TurnLedger`).** Each send goes `queued → running → answered | cancelled | failed`. The flags of `/clear` and `/compact` (`commandDue`, reset, compaction inside a turn) live here too. It is strict where the server takes the step and tolerant where the CLI does (a turn-end for an unknown or already closed id is ignored).
- **Agent and generation (`AgentSlot`).** The generation `gen` grows at every teardown (switch, close). Everything the old agent may send later (messages, permission requests, answers to mode and title, a deferred send) carries its own `g` and is dropped when `g !== gen`. This is the main defence against events of an old session leaking into a new one.
- **`SendQueue`** replaced `chain`: sends go to the agent one at a time, so the interrupt of a `force` send arrives after the earlier sends and before it, and a send from a past generation is dropped quietly.
- **`PermissionBroker`**: a request goes `open → answered | aborted`; an answer to an unknown or closed request is ignored (a second socket, a click after withdrawal).
- **`pump()`** reads `a.messages`, a stream of `AgentEvent` (Claude SDK frames are translated by `agent/claude/map.ts`; Codex notifications/items by `agent/codex/map.ts`):
  - it reconciles `waiting` with `turn-end` by `answers` and with `cancelled`;
  - main-thread output (text, or a tool call that is not a subagent's) while no send waits is a turn the agent started itself, for example woken by a background task's notification: it emits `turn-start` (stored, so a reload shows it) and counts as busy until the next `turn-end`, a crash or a reset;
  - when the agent dies, its tasks still running end as `stopped` (nobody else would say so, and a running task holds an update back);
  - it intercepts `reset` (`/clear`);
  - it watches `init` (session id, model, mode, the entry in `sessions.json`) and `compacted`;
  - everything except `init` and `rate-limit` and `commands` (which are handled separately) goes to the hub as `{kind:'agent', e}` (protocol 5).
- **Cut at compaction (`archiveCut`).** After the `compacted` event, in the same synchronous step where the generation was checked, `hub.cut()` writes the conversation before the boundary to the archive. The replay keeps what follows it, plus sends not yet finished (including the `/compact` itself). A write error is reported and cuts nothing. A conversation with no id of its own (a new session before `init`, a fork before its new id, a session after `/clear`) has no cut, and **a fork never offers its parent's archive**: `SessionIdentity.ownId` is `null` for it, `earlier` in the replay is 0, and `/history` answers 409.
- **`switchTo`**: check the target (`target`), then teardown (`gen++`, close the agent, wait for the loop to end for at most 5 s), then new state, then `load()` (`hub.reset` + transcript replay + `resumed`), then mode/idle/stats, then the `onSwitch` listeners, then `ensureAgent()`. A new session may only be opened in the current root or in a folder that already has sessions: a local client must not be able to re-root `/file` to `/` or `~`.
- **`restart`** is `switchTo(sessionId, root, restart=true)`. It is an escape hatch: it is allowed while the agent is busy (the interrupt takes at most 2 s).
- **Slash commands (`CommandKeeper`).** The list is asked from the agent once it is up, replaced whenever the agent pushes `commands_changed`, sent to every new socket (never stored) and emptied by a switch. A `/compact` or `/clear` typed in the composer is tracked like the buttons.
- **Shell commands (`ShellRunner`).** A one-line draft starting with `!` becomes `shell-run {id, cmd}`. The server runs it in the project folder in its own process group, independent of the agent, one at a time, as a feed block (`shell-start`, live `shell-out`, `shell-end`). Finished runs are queued and put in front of the next `send` by `takeFor()` in Claude Code's own form; they cause no turn. Rules: [agent reference](agent-reference.md#session-rules).

### 3.3 Protocol

Two channels with a clear split:

| Channel | What goes through it | Why |
|---|---|---|
| **WebSocket `/ws`** | Live session state: `agent` (`AgentEvent`), `user`, `permission*` (including structured interactions), `session`, `mode`, `stats`, `comments`, `idle-compact`, `commands`, `shell-start` / `shell-out` / `shell-end` / `shell-refused`, `hello{capabilities}`, `replay{earlier}`, `send-refused`, `server-error`; window ownership: `occupied`, `taken-over`, from the client `takeover`, closing with code 4001 | Needs push and ordering of events. There is one receiver, the owner tab. |
| **HTTP** | Files, tree, search, attachments, media markup, temp images (`/tmpimage`), the session list, `/history` (the archive before compactions), `/subagent` (a subagent's conversation), `/task-output` (the tail of a shell task's output), Settings, `/agent-account`, `/info`, `/restart-server` | Request and response, cacheable, Range for video. |

Protocol rules:

- `parseClientMessage` validates incoming messages strictly and **rebuilds them only from known fields** (`toComment`, `toAnchor`), so stray keys reach neither the store nor the broadcast.
- **Transient events** are not kept in the history (`store:false`): `comments`, `stats`, `mode`, `idle-compact`, `commands` and `shell-out` (the output of a `! cmd` run; its `shell-start` and `shell-end` are stored). A connecting socket gets them as separate frames after the replay, and `hello{protocol}` comes last.
- **Subagents.** A message anchor can name a subagent (`{kind:'message', id, agent?}`, `agent` the Agent call's tool-use id); such comments go to the main session.
- **Versioning.** All windows serve one shared `web/dist`, so a reloaded page can be newer than its server. The server announces `PROTOCOL` in `hello` (`shared/src/protocol.ts`). A protocol change adds a named entry to `FEATURES` (`shared/src/features.ts`, generated for Dart as `Feature`) and raises `PROTOCOL` to it. The rule: a client sends a new message type or field only to a server that announced it, `has(protocol, name)` (Dart `hasFeature`), never a comparison with a number, and otherwise hides the feature (absent, not disabled). The reverse skew (page newer than server) is covered by the reducers' `default` branches, which return the state for an unknown `kind` or `t`. Roll out by restarting the server first, then reloading the page. Each entry says what its protocol added; CHANGELOG has the user-visible side.
- **Generated types.** `shared/schema/protocol.schema.json` and the Dart types in `mobile/protocol/` are generated from these types (`npm run gen:protocol`; CI fails on stale output). A protocol change adds a fixture for each new variant to `shared/fixtures/protocol.json`.

### 3.4 Stores (server)

The state folder's layout is the guide's [State on disk](guide.md#state-on-disk). The only write into a project is `<root>/.nota-bene/marks/<commentId>/` (`marks.ts`).

The native provider owns the source conversation. For Claude this is its
transcript under `~/.claude/projects/...`; the SDK replays only since the last
compaction, so NB preserves earlier segments in `history/<sid>.jsonl`. For Codex,
`backend.history()` reads full chronological pages through `thread/turns/list`,
using the same item/id mapping as live events. `restoreCodexReplay()` reconciles
older native turns with the durable archive before returning only the latest
segment. If writing the archive fails, history stays visible rather than being
cut away. Both providers expose earlier segments through `replay.earlier` and
`/history`; forked sessions never inherit a parent's archive.

`NOTA_BENE_HOME` is the base directory, not always the effective state directory:
Claude uses the base unchanged; Codex and omp use `<base>/providers/<provider>`. Tokens,
windows, locks, sessions, preferences, comments, attachments and archives are isolated
by provider. Each agent's configuration and authentication stay its own; NB does not
read their credential files.

### 3.5 Codex adapter and native ownership

`codexBackend()` creates a `CodexSession` and owned `CodexRpc` for each active
conversation. It also creates a lazy metadata app-server for account/session/history
queries; this is a separate child, not a shared client attached to another host's
running conversation. Backend shutdown closes both active sessions and metadata.

- **Transport.** `CodexRpc` starts the installed `codex app-server` without a shell,
  completes `initialize` / `initialized`, and correlates newline-delimited JSON
  requests with bounded frames, timeouts and cancellation. Native requests can be
  withdrawn through `serverRequest/resolved`. Closing rejects pending work, aborts
  open requests and retires the owned process group (TERM, then KILL; on Windows
  the process tree, hard, with `taskkill /T /F`).
- **Threads and sends.** New/resume/fork use native thread methods. Normal input
  starts a turn or steers the active turn. A force-send interrupts and waits for
  completion before starting its replacement; an interrupt acknowledgement alone
  is not completion. `/compact` uses `thread/compact/start`; `/clear` cleans native
  terminals, unsubscribes the old thread and opens a new thread id. The shared
  generation/turn ledger still guards switching and late events.
- **Approval and questions.** `answerNative()` maps command/file approval decisions,
  additional permission scopes, user-input questions and MCP elicitation to the
  shared `Interaction` model. The browser returns choice ids and field values;
  native decision objects stay server-side. Withdrawn requests are cancelled.
  Native MCP device verification requires a host authenticator and is rejected
  explicitly by this browser integration.
- **Policy.** `codex-configured` inherits native settings; read-only, workspace and
  full-access profiles apply explicit approval/sandbox policies to subsequent
  turns. Models, effort choices, skills and file suggestions come from native APIs.
- **Tasks and history.** Native collaboration calls carry child thread ids;
  subagent tabs read those child threads through the same history mapper.
  Background terminals are discovered through native list APIs; child turns and
  terminal processes can be stopped. Force-background and terminal output-tail
  retrieval are unavailable, so their capability flags are false. The shared
  server's own `! cmd` runner remains available independently.
- **Usage.** Native token notifications supply context, and account rate-limit
  windows retain their actual durations. Cost is `null`; prompt suggestions are
  disabled. A ChatGPT login uses the installed runtime's account without an extra
  API key. `/agent-account` reads status or starts native login; retry restarts the
  agent session after authentication.

The session picker lists only the current provider. NB does not provide cross-provider
resume/conversion or concurrent ownership of one conversation by multiple clients.
Carry a CLI/Desktop conversation into a separate branch with fork.

## 4. Web client

### 4.1 Core, SDK and plugins

`web/src` is one bundle in three parts. The **core** owns the connection, data, storage, capabilities, the frame and
the registries. The **SDK** (`web/src/core/sdk/index.ts`, and `web/src/core/sdk/ui.ts` for UI primitives) is the only core module
a plugin imports, by the alias `@/sdk` (`@/sdk/ui`). The core's folders are `web/src/core/<name>/`, the **plugins**
the feature folders `web/src/plugins/<name>/`, each with a `plugin.ts` exporting its `definePlugin(...)`;
everything else in a plugin folder is private to it. `web/src/plugins.ts` lists them in order (`PLUGINS`). The
root-level files (`main.tsx`, `App.tsx`, `plugins.ts`, the CSS, `test-setup.ts`) are the composition root and may
import anything. The table names each folder under its part.
`web/src/core/testing/` is the test harness ([7](#7-testing)).

| Folder | Role | Contents |
|---|---|---|
| `sdk/` | core | The facade (`index.ts`, `ui.ts`) and the core's own modules: `connections.ts`, `routes.ts`, `repository.ts`, `storage.ts`, `plugin.ts`, `registry.ts`, `settings.ts` (the Settings tab's host) ([4.5](#45-sdk-and-registries)). The facade re-exports what plugins use, not every core name. |
| `store/` | core | `store.ts` (store assembly: the core slices `feed` and `conn`, slice injection, middleware, the chat thunks), `feed.ts` (the pure reducer of the feed from `AgentEvent`, plus `prependHistory`), `chunks.ts`, `persist.ts` (the core's listeners), `send.ts` (`chat.send` over `sendParts`), `controls.ts` (the `controls` slice: mode, model, commands, the hello's protocol, a switch or restart, held sends), `message.ts` (the images of the message being written), `stats.ts`, `tasks.ts` and `subagents.ts` (server data several plugins read), `mediaController.ts` (pause and PiP between tabs), `seekStep.ts`, `sessions.ts`. |
| `net/` | core | `socket.ts`: the WebSocket with automatic reconnection after 1 s; `open` means "connected" (the replay arrived), not the opening of the socket; after 4001 there is no reconnection, only `reconnect()` on a click. It does not enter Redux. `auth.ts`: the login (the page takes `#t=` out of the address bar, posts it to `/auth`, keeps the key) and `apiFetch`, behind `AgentConnection.fetch`. `local.ts`: whether this page is another computer's window. |
| `tabs/` | core | The tab host over the `tabs` registry (`Panes`, `TabStrip`, `TabsMenu`), the `tabs` slice (`TabKinds`, ids, open actions, saved form, `enterRoot`), the `jump` slice (`jump.ts`: jump to a comment's source). |
| `shell/` | core | The frame: `Header`, `Footer`, `ToolStrip` and `Slots` (the frame's own parts among the plugins' slots), the keymap (`keymap.ts`), toasts, theme, UI scale, sounds, favicon, `OneTab` ("the window is already open" / "open in another tab"), `LoginRequired`, `Stopped`, `PanelResizer`, `pagePause.ts` (the AND of every `Plugin.pause`). |
| `anchors/` | core | Anchors as text offsets plus `quote/prefix/suffix` of 32 characters each, re-anchoring when the text changes (`resolve.ts`), the batch text of each anchor kind (`quote.ts`, the agent's contract the phone mirrors), labels, a rendered page's frame (`frame.ts`: text root, rects, selection), a conversation's items (`items.ts`) and scrolling. |
| `refs/` | core | Paths in agent text (`src/a.ts:42`) and where files are: kinds and URLs (`kinds.ts`), sources (branches and worktrees), temp images, a media tab's start time. |
| `i18n/` | core | Six languages (`LANGS` in `index.ts`), no library. The choice is saved on the server (`prefs.json`) so all windows share it. |
| `components/`, `lib/`, `theme/` | core | UI primitives (Radix wrappers in `components/ui/`, icons, `ConfirmDialog`, `SettingsRow`, `Markdown` in `components/markdown/`, whose fenced blocks and media players come from the `codeBlocks` registry and the `media` service); small pure helpers (paths, formatting, `sha1`); theme tests. |
| `feed/` | plugin | Rendering of the feed: `Feed` over the `feed`, `tools` and `userParts` registries, its own kinds (`items.tsx`), ToolLine, PermissionCard, PlanCard, DoneLine; `EarlierButton` "Show before compaction" and `history.ts` (`GET /history`). |
| `composer/` | plugin | The input field, `@` mentions (`/complete`), the `/` menu (`SlashPicker`, `slashRank.ts`), the `!` shell mode (`shellMode.ts`, its feed block `ShellBlock`), the draft's send part (`send.ts`), rollback of a refused send (`refused.ts`), the prompt history (`history.ts`: the `promptHistory` slice and its middleware, `PromptHistory.tsx`: the Alt+H list), keys and recall (`useComposerKeys.ts`, `usePromptRecall.ts`). |
| `comments/` | plugin | Selection to popup to card, the panel, `HighlightLayer`, the comments' send part and batch assembly (`send.ts`, `compose.ts`), emoji. |
| `attachments/`, `voice/` | plugin | Composer images and their card; recording and playing voice, the voice part of a user message, the dictation settings. |
| `controls/` | plugin | Mode, session switcher, compact/clear, restart and stop, idle compaction, model and effort, the chat tab, the connection note. |
| `files/` | plugin | The tree (`tree` slice in `treeSlice.ts`), the file tab (`FileView.tsx` over the `fileViews` registry; the text is its own), editing, recent files. Subfolders: `files/tree`, `files/view` (`TextBody`, `FileEditor`, `useFileLoad`). |
| `page/`, `cut/`, `media/` | plugin | File views: rendered HTML pages (`HtmlBody.tsx`; `prep.ts` strips what could run, the page goes into an `<iframe sandbox="allow-same-origin" srcdoc>`, no scripts); the video editor (an edit is a `*.nbcut.json` file, types and `validateCut` in `shared/src/cut.ts`; `cut/export/` is the export); the player, its keys and `markup/` (geometry in 0..1, rendering to `frame.jpg` + `layer.png`, and `mask.png` for polygons). Each also shows its kind of comment anchor. |
| `tasks/` | plugin | Tasks: the core `tasks` slice (`reduceTasks` from `shared`: running tasks and the last 20 finished, nested by `parent`; agents launched by one model response share a `group` and get an umbrella row; a workflow's agents are `inner` tasks under it), `TasksDrawer.tsx` (the bottom drawer, an overlay that does not resize the feed), `TaskButtons.tsx`, `ShellView.tsx` (the `shell:<taskId>` tab over `/task-output`), `TasksIndicator.tsx`. Watchers (`ambient`) show in the drawer but are not counted by the indicator, the pulse or the favicon. |
| `subagent/` | plugin | The `agent:<toolUseId>` tab: a subagent's conversation, read-only, through the same `reduce()` kept apart from `feed`; polled while the agent works and the tab is visible. The card of an Agent call in the feed. |
| `diagram/`, `settings/`, `usage/`, `remote/`, `update/` | plugin | The diagram tab and Markdown's ```mermaid and ```svg blocks; the Settings tab, which hosts the `settings` sections; the Usage tab; the Remote tab; the update notice. |
| `stats/`, `projects/`, `vcs/` | plugin | Footer meters and the context nudge; the project rail and switcher; Changes (panel and tab), the Git log, the branch pill. |

**The import rule.** A plugin file imports only `@/sdk`, `@/sdk/ui`, its own folder, `@nota-bene/shared*` and npm
packages. A core file never imports a plugin folder. `@/core/testing` is imported only by test files and the listed test
setups (`plugins/cut/testCut.tsx`); test files are exempt from the two folder rules. Text rules: no `localStorage` outside
`sdk/` and `net/auth.ts`; no `visibilityState` and no new `useSyncExternalStore` outside `sdk/`; no comparison of a
protocol with a number or a protocol constant in `web/src` or `mobile/app/lib`. Type-only imports count. **The state
rule** (issue 563): a plugin's slice is read only inside that plugin; the core's slices are anyone's, directly or through
the SDK's selectors, and another plugin's state comes through its service.

**The check.** `scripts/boundaries.test.ts` (in the `node` Vitest project, no dependency) scans every file with a
newline-tolerant pattern after stripping comments and strings, and resolves `@/`, `@/sdk` and relative specifiers. A
file's role is its directory (`core/<name>/`, `plugins/<name>/`, `core/testing/`, the root); any other folder fails it. A slice belongs to the folder of its `createSlice({ name })`, and a read is `s.<name>` or `s['<name>']`
(also `st`, `state`, `was`, `getState()`), or `{ <name> }` destructured from the state (a selector's parameter, one typed
`RootState`, `= getState()`); a nested destructuring is not seen. The tree breaks no rule (issue 545 emptied the baseline it started with), so any violation
fails, named by its rule (`plugin→plugin: <file> -> <module>`, `<file> -> localStorage`, ...). A second test,
`sdkReach`, follows the SDK barrels' runtime imports through the core and fails on any plugin module it reaches: a plugin
evaluated inside the SDK's own evaluation would see `@/sdk` half-built.

### 4.2 Store

The reducer is RTK 2 `combineSlices` over the core slices (`feed`, `conn`, `tabs`, `jump`, `controls`, `message`, `stats`, `tasks`, `subagents`)
`.withLazyLoadedSlices<PluginState>()`, and `makeStore({ url, plugins, connect?, pip? })` injects each plugin's slices
once, before the store exists, under their own names (a name taken twice throws). `PluginState` is an empty interface
in `sdk/plugin.ts` that each plugin's `plugin.ts` extends by declaration merging (`declare module '@/sdk' { interface
PluginState extends WithSlice<typeof slice> {} }`), so `RootState` is fully typed without the store importing a
plugin. `TabKinds` is augmentable the same way. The plugin slices by owner: `comments`; `composer`, `promptHistory`
(composer); `tree`, `files` (files); `remote`; `tasksUi` (tasks); `markup` (media); `feedUi` (feed); `vcs`; `projects`.

```mermaid
flowchart TB
  C["AgentConnection (sdk/connections.ts)"] -->|"serverEvent(ev): the only entry of server data"| MW
  C -->|"connState(s): one dispatch per change"| MW
  subgraph MW["middleware, in order"]
    LM["listener middleware (prepended)"] --> TH["thunk, extra: connection, registry, sent"] --> TO["toast"] --> PM["plugins' middleware in PLUGINS order: refused, history (composer), compactTiming (feed)"] --> MD["media (last)"]
  end
  MW --> R["reducers: feed, conn, tabs, jump, controls and the injected plugin slices"]
  R --> LS["listeners: root change (enterRoot), tabs save, send, then each plugin's in PLUGINS order"]
  C -. "onEvent, after the store applied it" .-> REPO["repository: a resource's events read it again"]
  UI["components"] -->|"chat.send, chat.answer, pickMode..."| TH
  TH -->|"connection.send(ClientMessage)"| C
```

Principles:

- **One entry.** Server data arrives only as the action `serverEvent(ev)`. Several slices handle it through `extraReducers`. The feed reducer `reduce()` is a pure function,
  so replay is deterministic.
- **The connection owns its state.** The store mirrors it into the `conn` slice with one `connState` dispatch per
  change; components read the slice (`selectConn`), non-React code `conn.state()`.
- **Non-serialisable things stay out of state.** The connection lives in the closure of `makeStore` and reaches
  thunks through the thunk `extra` argument (`{ connection, registry, sent }`: `sent` holds what each unanswered send
  took, given back on a refusal). `MediaController` (which holds DOM elements) lives in a `WeakMap` and is fetched by
  the hook `useMedia`.
- **Side effects live in middleware and listeners, not in reducers**: toasts, tracking of PiP and pauses (`media`, last,
  so it sees every tab change once), rollback of the draft on `send-refused` (composer's `refused`).
- **Listener order is registration order.** One listener middleware; the core's listeners first: the root-change
  listener (`store/persist.ts`) sees a new `feed.session.root` and dispatches `enterRoot({ root, first, tabs })` with
  the core tabs' saved state in the action (one tab change for the media middleware), then the tabs' save, then the
  send listener. Then each plugin's in `PLUGINS` order, a plugin's own in its declared order. Each plugin restores its
  own saved state on `enterRoot` (`files`: tree dirs, recent files, sources, the ref cache). Saving listeners compare
  the state before and after an action, so a restore an earlier listener dispatched is seen by the later ones.
- **Pending state of a send** has no optimistic updates: a comment becomes `sent` only on the server's echo, and until
  then its id sits in `sendingIds`.

### 4.3 UI composition

`App.tsx` lays out the frame; every feature part in it is a plugin's `Slot`, rendered by `Slots` at its place by
ascending `order` among the frame's own parts:

```
App
├── Header: header.title · header.center · header.end · header.menu (⚙) · header.badge
├── panel.left (ProjectRail, LeftStrip, the tree, Changes) │ TabStrip + TabsMenu │ panel.right (comments, RightStrip)
│        Panes: chat (the chat slot: Feed, HighlightLayer) | each tab's TabView pane; the panes slot (TasksDrawer)
│        Footer: the footer slot (TasksIndicator, Composer)
└── overlay (the selection's comment, CommentCardPopover, Toasts, RecentFiles, the starter…), OneTab, LoginRequired, Stopped
```

- **Large components are split into compositions:** `FileTree` = `TreeHeader` + `TreeRow` + the hooks `useTreeEntries` / `useExpandAll`; `FileView` = the tab's header and load (`useFileLoad`) + a `fileViews` entry (`MediaBody`, `HtmlBody`, `CutBody`) or `TextBody`; `CommentCard` = `CardActions` + `useCommentSource`.
- **Panels are docked**: an open panel narrows the middle column instead of covering it.
- **All tab panes stay mounted**; inactive ones are just `hidden`. Anchors, `HighlightLayer` and autoscroll depend on the stable DOM of the chat.
- **Highlights** are drawn as `Range.getClientRects()` rectangles in a layer over the content; the text DOM is not touched.
- **Hotkeys** are one module, `shell/keymap.ts`, over the `commands` registry (the core's `CORE_COMMANDS` and the plugins'): one document listener, matching by `code`, Alt by default, aware of modal dialogs and text fields. A tooltip names a key through `withKey(commands, label, id)`.

### 4.4 Integration with the server

| Client | Server | Purpose |
|---|---|---|
| `sdk/connections.ts` → `net/socket.ts` | `/ws?tab=<id>` (`&passive=1` for a busy or taken-over tab) | All live session state. |
| `tasks/ShellView.tsx` | `GET /task-output?session&task` | A shell task's output. |
| `subagent/slice.ts` (`fetchSubagent`), `subagent/AgentView.tsx` | `GET /subagent?session&tool` | A subagent's conversation; comments on it go to the main session. |
| `feed/history.ts`, `feed/EarlierButton.tsx` | `GET /history?session&before` | An archived segment before a compaction. |
| `comments/slice.ts` (`flushComments`, add/edit/remove) | WS `comment-op`, `comments`, `comment-ack`, `comment-refused` | Comment sync by ops: a change is queued and shown at once (the server's set with the queue folded on top), sent in order once the socket is open and again after a reconnect, and leaves the queue on its ack. `gone` / `sent` refusals drop it with a toast; `failed` keeps it for the next open. Only the owner tab writes. The phone queues ops the same way and keeps the queue on disk. |
| `store/send.ts` (`chat.send`) over the `sendParts` of `composer/send.ts` and `comments/send.ts` | WS `send{commentIds, images}` | The batch: the draft plus all pending comments as one message. |
| `composer/shellMode.ts` | WS `shell-run{id, cmd}`, `shell-stop{id}` | A `! cmd` run; the block in the feed is driven by `shell-start` / `shell-out` / `shell-end`. |
| `lib/image.ts` | `POST /attach`, `GET /attach/<id>` | Image upload; only ids travel over the socket. |
| `voice/` | `POST /voice`, `GET /voice/<id>`, `POST /voice/<id>/text` | The recorder (16 kHz mono WAV, 10-minute cap), upload, player, the composer's record bar and comment clips. No recording without Whisper. |
| `media/markup/createMediaComment.ts` | `POST/DELETE /marks/<id>/<name>` | The frame and layer of media markup. |
| `files/FileTree.tsx` | `/tree?path&src` | Lazy loading of the tree, up to 8 requests in parallel. |
| `files/view/useTmpImage.ts` | `GET /tmpimage?path` | A temp image through the connection's `fetch` into a blob URL. |
| `files/FileView.tsx` | `/file` (HEAD, Range probe, GET) | Viewing; the ETag serves as the version for media anchors. |
| `composer/MentionPicker.tsx`, `files/RecentFiles.tsx` | `/complete?q` | The CLI's search (`file_suggestions`) and our own file index in parallel; the results are merged. |
| `refs/sources.ts`, `vcs/GitBranch.tsx` | `/sources`, `/git-status`, `/vcs-branches` | Branches and worktrees, the branch picker. |
| `vcs/` | `/vcs-*` | Changes (panel and tab, one file at a time) and the Git log. |
| `controls/AgentAccount.tsx` | `GET/POST /agent-account` | Codex account status and native sign-in URL; retry restarts the session. |
| `controls/SessionPicker.tsx` | `/sessions` | Sessions of the window's provider with their cwd; native Codex list or Claude SDK list. |
| `controls/RestartMenu.tsx`, `store/controls.ts` | `/info`, `POST /restart-server` | The "Restart the server" item (only under the launcher). |
| `settings/SettingsView.tsx` and the plugins' `settings` sections | `/system/*` | Storage, defaults, about. |
| `usage/UsageView.tsx` | `/usage`, `/usage/reset` | The token report; polls while the first import runs. |
| `net/auth.ts` | `POST /auth`, then the key header on every `apiFetch` (`AgentConnection.fetch`) | Login ([Access token](agent-reference.md#access-token)). |

### 4.5 SDK and registries

A plugin sees the core through `@/sdk` (the runtime API, re-exported by name so the surface is one file; export order is
evaluation order, leaf modules first) and `@/sdk/ui` (buttons, menus, dialogs, `ConfirmDialog`, `PanelResizer`,
`SettingsRow`, icons). A plugin is `definePlugin({ id, slices?, middleware?, listeners?, pause?, ...registries })`
(`sdk/plugin.ts`). `buildRegistry` (`sdk/registry.ts`) builds the registries once per store from its plugins and the
core's commands, frozen; a kind, id or order claimed twice throws there. Components read them with `useRegistry()`,
thunks through their `extra`, other code with `registry(store)`.

| Registry | Entry | What it does |
|---|---|---|
| `tabs` | `TabView { kind; label(tab, t, state); Icon?; Extra?; detail?(tab, t); edit?; render? }` | How a tab kind looks (strip, ▾ menu, one `tabLabel`) and its pane. Rendering only: the tab's data, id, open action and saved form are the core's (`TabKinds` in `tabs/slice.ts`), because several plugins open each kind. |
| `slots` | `Slot { slot; order; render }` | A part of the frame at `header.title`, `header.center`, `header.end`, `header.menu`, `header.badge`, `strip.left`, `strip.right`, `panel.left`, `panel.right`, `chat`, `panes`, `footer` or `overlay`, by ascending `order` among the frame's own parts. The composer's: `composer.status`, `composer.tools`, `composer.end`, and `composer.pickers`, which the comment popup shares (a picker reads its field with `useComposerField()`). |
| `commands` | `Command { id: KeyId; codes; mods; inFields; inModal?; anyMod?; helpOnly?; order; run({ store, e }) }` | A global hotkey. The id is the i18n key of its help line; `order` is the help's and the match order, so core and plugin keys interleave as before. The core's are `CORE_COMMANDS` (`shell/keymap.ts`); `keysFor(commands, id)` names a key. |
| `feed` | `FeedRenderer { kind; render({ item, held? }) }` | How the feed draws one kind of item; every kind but `tool`, whose runs are the feed's own. |
| `tools` | `ToolRenderer { match(item); render({ item, open, panelId, comments, busy, onToggle }) }` | The head of an action a plugin draws itself (the subagent's card); the feed keeps the fold and the commentable panel. First match wins. |
| `userParts` | `UserPart { id; order; render({ item }) }` | A part of a user message: voice 10, text 20, images 30, comments 40. |
| `fileViews` | `TextFileView { id; order; match(path, kind); label; tip; writes?; jump?(c); render({ ..., text, bar }) }` or `MediaFileView { media: true; holds?(s, tabId); render({ ..., media }) }` | How a file tab shows a file: `cut` 10, `page` 20, `media` 30, first match. The tab keeps the header, the one load, the ‹View \| Source› switch and the editor; a view gets the text or the loaded media. Text is the tab's own (every unmatched file, and a text view's ‹Source›). |
| `anchorViews` | `AnchorView { kind; Card?; reveal?(c); orphan?; place?(c, root); composite?(members) }` | How a comment on one anchor kind shows in the UI: its card, reveal, orphan check, outline, and a frame's combined picture (media). A kind without one shows the core's `anchorLine`. What the agent reads of a comment stays core (`anchors/quote.ts`): the batch is a contract the phone mirrors. |
| `sendParts` | `SendPart { id; order; count?(s); waiting?(s); take(s, d, { voice, registry }) }` | A part of a message: the draft (composer, 10), the comments (30). See below. |
| `settings` | `SettingsSection { id; order; title?; in?; render?({ active }); aside? }` | A section of the Settings tab, or with `in` a row of another section; the tab is the host (`SettingsContext`: one `post()`, one status line, one confirm). |
| `resources` | `Resource` | The server data a plugin reads, by id, so a test answers it by id (`stubResources`). |
| `comments` | `CommentsService { HighlightLayer; CommentPopup; flashRange; flashRects; selectComments; selectPendingCountByPath; selectMediaComments; openCommentCard; moveCutComment; removeComment }` | The comments as other plugins' views use them; one plugin (comments) provides it. A drawing's `PendingComment` carries its own `discard`. |
| `voice`, `attachments` | `VoiceService { useRecorder; RecordBar; WhisperPrompt; ClipRow; transcribe; send; onRefused }`, `AttachmentsService { useIntake; Attachments; ComposerAttachments }` | What the composer and the comment popup, two hosts of one `MessageInput` (`@/sdk/ui`), drive with their own state. |
| `files`, `vcs`, `projects`, `feedUi`, `tasks`, `cut`, `media`, `composer` | `FilesService` (the tree's source, open state and focus, the refresh sequences, `pickSource`, `diskChanged`, `setTreeOpen`, each open file view's load and version, `jumpToFileComment`), `VcsService { showCommit }`, `ProjectsService { openFolder }`, `FeedUiService { revealTool, Feed, selectFolds }` (a subagent's conversation drawn as the chat's), `TasksService { CallMenu }`, `CutService { liveCutState }`, `MediaService { ChatPlayer, AttachmentMarkup }`, `ComposerService { field }` | Another plugin's state and parts, with only what the others read. |

Every service is read with `useService(name)` in a view, `registry.<name>` in a thunk or a plugin's `listeners(start,
registry)`, and is provided by one plugin. Its interface lives in the provider's `plugin.ts`, which adds it to
`Services` by declaration merging, as a slice joins `PluginState`; the SDK declares only `MediaService`, which the core's
Markdown reads. A conversation's items are a core DOM contract (`anchors/items.ts`): a box marked `data-items`, each
item's root `data-item-id`, found with `itemsBox`, `itemRoots`, `itemRootOf`.
| `codeBlocks` | `CodeBlock { lang; className; draw(out, code, d); retheme?(root, d) }` | A fenced block Markdown hands to a plugin once final (diagram: `mermaid`, `svg`); a language is drawn by one plugin. |
| `treeActions` | `TreeAction { id; order; Menu?({ row, picked, src, busy, setBusy }); drag?(path, src, dt) }` | Another plugin's part of a Files tree row: its menu items above the row's own, what its drag carries (cut: Add to edit, New edit, the timeline drag). |

**A send** (`chat.send(text, { force?, parts?, voice? })`, `store/send.ts`) is two-phase. At the click every part is
taken in order (`take` marks its items, so a second click or a later change does not touch them); `take` may instead
return a result that ends the send (a `! cmd` runs, a held /clear, nothing to send). A `Taken` may be `ready` later (a
combined frame image): the send waits up to `COMPOSITE_MS` with Send off. Then, if the session and every part are
`unchanged`, the parts `compose` in order, each seeing the images before its own, and the message goes; each part's
`sent(id)` follows. Any other end, and a later `send-refused`, calls `released` (the core keeps send id → taken parts),
so a refusal gives back the draft and the comments without either plugin knowing the other. A recording is
`chat.send` with its `voice`.

**Connection** (`sdk/connections.ts`). `AgentConnection { base; state(); subscribe; hello(); send(m);
fetch(route, init?); url(route); takeOver(); stop(); onEvent(fn) }` over `net/socket.ts`, whose semantics are
unchanged. A page shows one agent, so `makeStore` makes one connection. `onEvent` delivers each event after the store applied it. `connection` is the page's, for a plugin and code outside React; a thunk takes its own from `extra`. A server capability is
checked one way: `useFeature(f)` in a component, `selectFeature(s, f)` elsewhere, both over the `controls` slice's
protocol (0 until a hello). A reducer of the `hello` itself reads its `protocol` with `has`.

**Data** (`sdk/routes.ts`, `sdk/repository.ts`). `routes` builds every server path (`Route`: path and query, no base),
for `conn.fetch(route)` or, as an img/video/iframe `src`, `conn.url(route)`. `defineResource({ id?, key, route, every?,
events?, parse?, timeout? })` declares a read; `useResource(res, args, { on?, every?, whileHidden?, refreshOn? })` gives
`{ data, failed, error, loading, status?, refresh() }`, and `repository` (`load`, `watch`, `peek`, `subscribe`,
`invalidate`) serves code outside React. Writes go through `send(route, body?, { method?, type?, keepalive?, signal?,
conn? })`: `body` as JSON, a Blob as it is, POST by default; it resolves to the answer whatever its status (the caller
reads a refusal) and rejects only when none came. Per connection there is one cache entry per key: its watchers share one
request in flight and one timer (the shortest period asked), a timeout or failure keeps the data and marks it failed,
and an answer with the same text keeps the same object. The poll pauses while the connection is down and while the page
is hidden (a watcher may ask `whileHidden`: the update notice while an update installs); showing the page reads what
the pause missed, a reconnect reads everything watched, and a resource's `events` read it again.

**Storage** (`sdk/storage.ts`). `storage.local(key, codec, fallback)` is a `Stored<T> { get;
set; remove; subscribe }` over this origin's localStorage under the keys the app always used (codecs `bool`, `string`,
`json(valid)`, `oneOf(values)`; a refused write is held in memory for the page). `storage.pref(name)` is a server
setting of every window (`SharedPrefs`: `lang`, `uiScale`, `theme`, `projectRail`, `sounds`; `POST /system/prefs`
through the current connection, chained, last wins), cached locally so a reload does not flash. A connection's `hello`
is adopted in one place (`adoptHello`: language, scale, theme). The dictation language is the server's dictation
setting, held in the `controls` slice. `useStored(item)` reads either in React.

**The state rule.** Each piece of state has one home:

| What | Where |
|---|---|
| Server data pushed over the socket, and UI state several components or a reload share | A slice (core or a plugin's), fed by `serverEvent` and actions. State another plugin reads is a core slice (`controls`). |
| Server data fetched over HTTP | `useResource` / `repository`: its cache is the one copy. |
| Anything that outlives the page (local or server prefs, saved UI state) | `storage.local` / `storage.pref`; a slice may mirror it through a listener, as `persist.ts` does. |
| State of one component instance | `useState` / `useReducer`. |

No `useSyncExternalStore` outside `sdk/`, and no module singleton but the boundary check's named allowlist
(`SINGLETONS`), each read with `useStored({ get, subscribe })`: what ticks with a media element (the edit and voice
players, the playing tab), `toast()` (called without a store), the live objects of open views (the open edits, the edit
targets), browser values (the day, a media query, a page frame's render count) and the sources (on-demand loads with a
5 s TTL, which the repository lacks). The dialogs' open flags, the git views' state and the temp folders are slices.

## 5. End-to-end scenarios

**Sending a batch of comments:**

```mermaid
sequenceDiagram
  participant U as UI
  participant S as Store
  participant SV as agent.ts
  participant CS as CommentStore
  participant SM as SessionManager
  participant A as Agent
  U->>S: chat.send()
  S->>S: take each send part (draft, comments: markSending), wait for a combined frame image
  S->>S: compose in order: the draft, composeBatch(pending, labels, where, images)
  S->>SV: WS send{id, text, commentIds, images}
  S->>S: each part's sent(id): draftSent, the draft cleared, activate the chat
  SV->>CS: markSent(ids) before the agent is called
  SV-->>S: comments (to the owner)
  SV->>SM: send()
  SM-->>S: user (echo into the feed)
  SM->>A: AgentSession.send (text + labeled images)
  A-->>SM: normalized AgentEvent stream
  SM-->>S: agent events → reduce() → feed
```

**Switching session or folder:**

1. The client sends `switch{id, dir}`.
2. `checkTarget` checks the target, then teardown with `gen++`.
3. `hub.reset(transcript)` redraws the owner's feed.
4. The server sends `session{root}`, and the root-change listener in `persist` sees the new root: `enterRoot` with that root's saved tabs, `rootGen++` (remounting `FileTree` and `FileView`); the files plugin restores its tree dirs and recent files on `enterRoot`, reloads the sources and resets the ref cache.
5. `onSwitch` delivers the new session's comments. A running `! cmd` is stopped quietly and the queue of runs for the agent is dropped.

**Compaction and "Show before compaction":**

1. The agent sends `compacted`; `pump()` passes it to the hub, then `archiveCut.cut()` (in the same synchronous step where the generation was checked).
2. `hub.cut()` writes everything before the boundary to `history/<sid>.jsonl` (segment `n`), leaving in the history what follows it and sends not yet finished. No live socket hears about the cut: their feed is already complete.
3. A reloaded page gets a short `replay` with `earlier = n`, and the feed shows the button "Show before compaction".
4. A click: `GET /history?session=<id>&before=earlier+1`, and `prependHistory` inserts the segment before the feed and `earlier` decreases; an empty 404 removes the button, and a 409 (the conversation is a different one now) shows an error.

**Taking over the window (takeover):**

1. A second tab connects while an owner exists: after 700 ms it gets `occupied` and shows the overlay "The window is already open in another tab".
2. "Work here" sends `takeover`. The server sends the old owner `taken-over`, detaches it and closes it with code 4001; the new tab attaches as in a normal connection and gets the `replay`.
3. The old tab shows "Open in another tab" with the same "Work here" button and does not reconnect by itself; its queued comment ops wait and go if it takes the window back.

**Reload of the owner within the grace period:**

1. The new page gets a new `?tab=<id>` while the old page's socket is not yet closed: the server holds the new socket as `pending`, with no overlay.
2. The old socket closes within 700 ms (`owner` is empty), so the newcomer becomes the owner and gets the `replay`. If it did not close, the newcomer gets `occupied`.
3. The same `tab` as the owner's means the same page reconnecting after a drop (the old socket is a zombie): it is closed at once, without waiting.
4. After a server restart both tabs reconnect passively (`&passive=1`): a passive socket cannot claim an empty window first. It gets `occupied` and carries on only on a click of "Work here".

## 6. Security (the local threat model)

The model and its rules are in the agent reference, [Access token](agent-reference.md#access-token): a local token,
values derived per launch and port, a cookie tier that opens only media loads, a key tier for everything else, helpers
that prove a listener before they send, and a state folder that is never served. What else holds:

- **Network.** The server listens only on `127.0.0.1` and accepts only `Host` values `127.0.0.1:port` or
  `localhost:port` (against DNS rebinding). Methods other than GET/HEAD need an allowlisted `Origin`, even with a Bearer.
- **Tool permissions.** The browser picks one of the choices the server advertised; native decision objects and
  requested permissions stay on the server.
- **`! cmd`** runs with the user's privileges in the project folder, from the owner socket only, without the token or the
  launcher's variables.
- **Paths.** `resolveInRoot` is the project sandbox; in `marks` only a UUID becomes a path, the file names are fixed and
  symlinks are refused.
- **Control between windows.** The control token and a ban on Origin; before any action the target's registry entry is
  checked to be the same window (`root`, `pid`, `startedAt`), otherwise 409.

## 7. Testing

- **Unit (vitest).** Worker environments explicitly reset the invoking NB provider and supervision/launcher flags; provider-specific tests select their provider. The server is tested through `startServer` on port 0 with a fake backend; the auth tests run with auth on. The web is tested through `makeStore` with `connect` and `pip` replaced, by the harness in `web/src/core/testing/` (test files only): `testStore({ hello?, events?, state? })` gives `{ store, conn }` on a `FakeConnection` (`sent`, `emit`, `setState`) with every plugin; `renderWith(ui, o)` renders inside its `Provider`; `stubRoutes` answers fetch by path (an unmatched one is a recorded 404), `stubResources` by a registered resource's id; `events.*` build typed server events. `cut/testCut.tsx` is built on it.
- **The import rule** is a unit test, `scripts/boundaries.test.ts`: the tree breaks no rule ([4.1](#41-core-sdk-and-plugins)).
- **Parity fixtures** pin what the phone mirrors to the web: `web/src/core/store/feedParity.test.ts` drives `reduce()` with fixed event sequences and writes each case as `mobile/app/test/fixtures/feed/<case>.json` (`{ events, items }`, a projection both models hold, with the phone's tool `phase`), which `mobile/app/test/feed_test.dart` replays through the phone's feed; the anchor and media parity fixtures work the same way. `UPDATE_FIXTURES=1` rewrites them.
- **E2E (Playwright, ports 4791 to 4795)** on `--fake` scripts, with the media fixtures generated by ffmpeg. The e2e servers are seeded with a known token and nonce.
- **Codex integration.** RPC fixtures exercise transport, mapping, history, cancellation, policy and child cleanup. `npm run e2e:codex` runs the native-adapter browser fixture separately; `native.test.ts` drives the installed app-server against a local Responses mock without paid model calls. Marketplace smoke tests use isolated `CODEX_HOME`, NB state and a temporary project; npm runtime checks use the published package. Serialize browser suites that share ports.
- **The `AgentBackend` seam** is the main reason almost everything can be tested without a real CLI.

## 8. Design trade-offs

- **The shared contract.** `shared/` is narrow, the boundary validates strictly, the server has no extra dependencies,
  and the `AgentBackend` seam lets almost everything be tested without a real CLI.
- **Generations (`gen`)** guard against races between sessions; the window phase is strict, while `idle / turn / asking`
  are derived from sends and permissions because turns overlap.
- **One tab per window, not a hard lock.** A forgotten tab must not block work, and a reload race must not show a false
  "already open"; so a second tab can take over. Comment ops (protocol 19) remove the last-writer-wins loss of the
  older whole-set sync (issue 259).
- **History is cut at each compaction.** The feed shows the conversation since the last compaction; "Show before
  compaction" loads the rest over HTTP, so nothing is lost silently.
- **One `web/dist` for all windows** gives one build and an update by reload, at the price of version skew between page
  and server: every new protocol message needs a version check on the client ([3.3](#33-protocol)).
- **The Claude SDK** is used through some non-public APIs (`q.request({subtype:'file_suggestions'})`,
  `usage_EXPERIMENTAL_...`), so it is updated by hand, with a run of `server/test/fixtures/real-frames.json`.
