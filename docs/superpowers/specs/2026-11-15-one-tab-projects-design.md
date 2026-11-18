# One tab for all projects

## Intent

Every project open in Nota Bene should be reachable from one browser tab, and no process should be lost. Today each folder is a separate window process on its own port with its own tab; a window started without a tab (detached launch, tab closed by accident) is visible only on the phone and in Settings, Windows. Full phone/web sync is the next direction (the web should show what the phone shows); later the app moves into a Tauri desktop shell.

Decided with the user:
- One server per machine holds many projects (approach C). Each project has at most one agent per provider (Claude, Codex, omp), as today's one window per folder per provider.
- The first `/nb` or `nota-bene` call starts the server detached from the caller; later calls attach. It runs until the user stops it from the UI or with a console command. No OS service (launchd/systemd/Windows service): same on every OS.
- One tab switches projects through a header switcher (mockup B: a menu with search, running projects with agent state, recent projects, "Open folder…", "New project…").
- A starter (open/create a project) comes first.

## Goals

One tab shows every running project and each agent's state (working, waiting, idle, failed) and switches in place; a project can be opened or created from the UI with no terminal; nothing runs unseen (every running agent is in any tab's switcher and the phone's list); phone and web see the same projects and agents; agents of different vendors work on one project in parallel.

Non-goals: a Tauri app now (do not block it); an OS background service or start at login; several agents of one provider in one folder (needs worktrees; later); cloning from the starter (later); changing per-session features (comments, voice, files, marks, shell, usage), which move as they are.

Anti-goals: an agent stopping because a tab closed; a process running while no tab and no list shows it; a regression of any feature, provider or the phone.

## Approaches

- A. A list of windows in every tab, click opens/focuses that window's tab. Cheap but still many tabs; rejected by the user (one tab is the requirement).
- B. One tab over separate processes navigating between ports. Same architecture; auth per port needs a login hand-off on every switch and the phone keeps many ports. Kept as phase 1 only.
- **C. One server, many projects (chosen).** One process, port, token and socket endpoint; project and agent are units inside. Cleanest base for phone sync and a desktop shell.

Switcher look: A (left rail), B (header switcher), C (projects home board) were mocked; the user chose B.

## Design

Terms: Server = the one process; Project = a folder (`root`) open in it; Agent = one provider's agent in one project (today's window minus the process), id stable per `(provider, root)`, e.g. `<provider>-<first 10 hex of sha1(root)>`.

### Phases (each leaves `main` working)

1. Switcher and starter over today's windows: the header switcher lists every live window of every provider (registry, as `/system/windows` reads it) with agent state, plus recent projects (`sessions.json`). Choosing a window navigates the same tab to its URL with a fresh login credential minted by the target window through the existing control relay. "Open folder…"/"New project…" start a detached window and navigate to it. Removes lost windows at once and gives the first UI strings.
2. One server: projects and agents move into one process; launcher and `/nb` attach; "Stop server" and `nota-bene stop`; the switcher switches in place; the remote connector and phone move to agent ids in the same phase (several agents share one port).
3. Polish: agent-level actions (stop an agent, close a project, add a second provider), keyboard switching, phone project grouping.

### Server structure (phase 2)

Today `startServer(cwd, port, backend)` builds one `SessionManager`, `EventHub`, `CommentStore`, `PromptStore`, `MarkFiles`, file routes and one owner socket. New split:
- Process level, once: HTTP server/port, access token and cookie, control token, audit log, prefs, updater, Whisper host client, remote keeper, one backend object per provider.
- Agent level, per `(provider, root)`: session manager, hub, comment/prompt stores, marks, agent-scoped routes, owner socket and one-tab rule.
- State dirs: the provider's state dir is passed explicitly to each agent's stores instead of read from `process.env.NOTA_BENE_AGENT`; paths on disk stay, so existing sessions, comments, prompts read unchanged.
- Routes: agent-scoped routes move under `/a/<agentId>/…` (files, sessions, icon, subagent, task output, restart/stop of that agent); process-level stay (`/hello`, login, `/system/*`); web `apiFetch` gets the current agent's base path.
- Sockets: one per agent, `/a/<agentId>/ws`, today's protocol unchanged; a tab holds the socket of the agent on screen, switching closes and opens the next (replay rebuilds the feed). A separate `/overview` socket streams projects/agents with state to every tab (feeds the switcher, "N waiting" count, and lets the server tell a tab to switch).
- One-tab rule kept per agent (`occupied`, takeover); two tabs may show different agents.
- Singletons to fix: Whisper host client's single `reportTo` becomes a list; in-app update waits until no agent is busy and no tab open across all agents; audit records carry the agent id.

### Lifecycle and launcher (phase 2)

- Registry: one `~/.nota-bene/server.json` `{port, pid, startedAt, version, nonce, agents: [{id, provider, root}]}` under a server lock; per-folder locks become an in-process map.
- `nota-bene [dir]` and `/nb`: if a server runs, ask it (control token, `POST /system/open {root, provider, mode: resume|new|fork, resume?}`) to open the agent and report its URL; if a server tab is connected it tells that tab to switch over `/overview` and no browser tab opens; else open the browser. No server: start one detached and do the same. The `/nb` background-task launch goes away (the server outlives the Claude Code session).
- Stop: "Stop server" in the switcher menu and `nota-bene stop` stop every agent; "Close project" stops a project's agents and removes it from running.
- Restart server (exit 75) reopens every agent in `server.json`, each resuming its session; ↻ Agent restarts one. Update handover (exit 77) keeps its rule (no tab, nothing busy) across all agents.
- Existing old-style windows during the switch: listed by the switcher (as phase 1), not adopted; they end when stopped or on the next update.

### Remote connector and phone (phase 2)

The connector discovers the one server and lists its agents; `HostWindow` gets the agent id; streams open by `{kind, agent, path}` not port; the phone identifies a chat by host and agent id. Connector protocol and phone change in the same phase; an older phone app says "update the app" instead of failing silently.

### Starter and switcher UI

- Switcher (header, left): current project name with state dot; menu has search (Alt+P), "Running" (projects with agents: provider badge and state), "Recent", "Open folder…", "New project…", and in phase 2 "Stop server"; beside it a count of agents waiting for the user.
- Starter: shown with no project open and from "Open folder…"/"New project…". Open browses folders from home in our own picker (browser has no native dialog; Tauri can swap in the OS one). New creates a folder under a chosen parent, optionally `git init`, and opens it. Both ask for the provider (default last used). All strings in every UI language.

### Decided after review

- One server for everything, also while developing Nota Bene inside it (a checkout and an installed package share one). "Restart server" first shows which agents are mid-turn and would be interrupted and lets the user wait or go ahead; nothing busy restarts at once. A launcher of another version attaches to the running server; moving to newer is the update handover.
- Accounts: every agent runs in the server's environment for now. Users with several subscriptions will come, so nothing may tie an agent to the server's environment for good: agents are keyed by `(provider, root)` and start options are built in one place that a later account profile (config dir, keys, binary) can feed. Per-agent account choice is a later change.

### Calls made while writing (not the user's)

- Process-level state comes from the base state dir (today Claude's): one token, cookie, control token, audit log, updater; global prefs (language, theme, scale, sounds) as today; per-root prefs (mode, model, idle compaction) stay per provider. Tabs of other providers log in once more after the move.
- After a stop or reboot the server starts empty with previous projects under "Recent"; after a crash or exit 75 it reopens every agent it had. No eviction of idle agents now.
- The phone sees and uses agents in phase 2; opening folders, creating projects and stopping the server stay web-only (the connector does not forward `/system/open`, picker and stop).
- Old-style windows: the connector lists both while any old window runs; an old window that updates (exit 77) hands its folder to the server (new launcher opens the agent there, starting the server if needed) and the old process ends.

## Left to the builder

Agent id format and `/a/<id>` prefix shape; overview stream framing and throttling; folder picker details (hidden folders, typed path); how phase 1 mints the login credential within the existing control relay and its checks; the split into PRs.

## Risks

Phase 2 touches auth, routing, launcher and phone together and needs characterization tests of today's window behavior first; one backend object serving several sessions of one provider may hide per-session assumptions (Codex's one RPC per session is fine; Claude SDK and omp need a check); a crash now takes every project down at once, so the launcher's crash-restart must reopen all agents.
