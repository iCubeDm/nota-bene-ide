# One tab for all projects

## Intent

Every project open in Nota Bene should be reachable from one browser tab, and no process should be lost. Today each
folder is a separate window process on its own port with its own tab. A window started without a tab (a detached
launch, a tab closed by accident) is visible only on the phone and in Settings, Windows. Full sync between the phone
and the web is the next direction, which makes this sharper: the web should show what the phone shows. Later the same
app moves into a Tauri desktop shell.

Decided with the user:

- One server per machine holds many projects (approach C below). Each project has at most one agent per provider
  (Claude, Codex, omp), as today's "one window per folder per provider".
- The first `/nb` or `nota-bene` call starts the server, detached from the caller; later calls attach to it. The
  server runs until the user stops it explicitly, from the UI or with a console command. No OS service (launchd,
  systemd, Windows service): the same on macOS, Windows and Linux.
- One tab switches projects through a project switcher in the header (mockup option B: a menu with search, running
  projects with their agents' state, recent projects, "Open folder…", "New project…").
- A starter (open / create a project) comes first.

## Goals

- One tab shows every running project and the state of each agent (working, waiting for the user, idle, failed), and
  switches between them in place.
- A project can be opened or created from the UI; nothing needs a terminal.
- Nothing runs unseen: every running agent is in the switcher of any tab and in the phone's list.
- The phone and the web see the same set of projects and agents.
- Agents of different vendors can work on one project in parallel (Claude on one task, Codex on another), as today's
  per-provider windows allow.

## Non-goals

- A desktop app (Tauri) now. The design should not block it.
- An OS-level background service or start at login.
- Several agents of one provider in one folder (that needs worktrees; later).
- Cloning a repository from the starter (later).
- Changing the per-session features (comments, voice, files, marks, shell, usage): they move as they are.

## Anti-goals

- An agent that stops because a tab was closed.
- A process that runs while no tab and no list shows it.
- A regression of any existing feature, provider or the phone.

## Approaches

- **A. A list of windows in every tab.** Every tab lists all window processes; a click opens or focuses that window's
  tab. Cheap, but there are still many tabs. Rejected by the user: one tab is the requirement.
- **B. One tab over separate processes.** The tab navigates between window processes on different ports. One tab, the
  same architecture; auth per port needs a login hand-off on every switch, and the phone keeps many hosts' worth of
  ports. Kept as phase 1 only (below).
- **C. One server, many projects.** One process, one port, one token, one socket endpoint; each project and agent a
  unit inside it. The cleanest base for phone sync and for a desktop shell. Chosen.

Switcher look: A (a project rail on the left), B (a header switcher) and C (a projects home board) were mocked; the
user chose B.

## Design

### Terms

- **Server**: the one Nota Bene process of the machine.
- **Project**: a folder (`root`) open in the server.
- **Agent**: one provider's agent in one project: today's window minus the process. Its id is stable for its
  `(provider, root)`, e.g. `<provider>-<first 10 hex of sha1(root)>`.

### Phases

Each phase is one or more pull requests that leave `main` working.

1. **Switcher and starter over today's windows.** The header gets the project switcher. It lists every live window of
   every provider (the registry, as `/system/windows` already reads it), with its agent state, and the recent
   projects (`sessions.json`). Choosing a window navigates the same tab to that window's URL with a fresh login
   credential minted by the target window through the existing control relay. "Open folder…" and "New project…"
   start a detached window for the folder and navigate to it. This removes "lost windows" at once and gives the UI
   and its strings a first version.
2. **One server.** Projects and agents move into one process (details below); the launcher and `/nb` attach to it;
   "Stop server" and `nota-bene stop`. The switcher stops navigating and switches in place. The remote connector and
   the phone move to agent ids in the same phase, since several agents now share one port.
3. **Polish.** Agent-level actions in the switcher (stop an agent, close a project, add a second provider to a
   project), keyboard switching, the phone's project grouping.

### Server structure (phase 2)

Today `startServer(cwd, port, backend)` builds one `SessionManager`, `EventHub`, `CommentStore`, `PromptStore`,
`MarkFiles`, file routes and one owner socket. In the new structure:

- **Process level, once**: HTTP server and port, the access token and cookie, the control token, the audit log, prefs,
  the updater, the Whisper host client, the remote keeper, one backend object per provider (its account/login state is
  per provider already).
- **Agent level, per `(provider, root)`**: what `startServer` builds today below the HTTP server: session manager, hub,
  comment and prompt stores, marks, the agent-scoped HTTP routes, the owner socket and its one-tab rule.
- **State directories**: the provider's state dir is passed explicitly to each agent's stores instead of being read
  from `process.env.NOTA_BENE_AGENT`. Paths on disk stay as they are, so sessions, comments and prompts written by
  today's windows are read unchanged.
- **Routes**: agent-scoped HTTP routes move under `/a/<agentId>/…` (files, sessions, icon, subagent, task output,
  restart and stop of that agent). Process-level routes stay where they are (`/hello`, login, `/system/*`). The web's
  `apiFetch` gets the current agent's base path.
- **Sockets**: one socket per agent, `/a/<agentId>/ws`, carrying today's protocol unchanged, so the feed, comments and
  the reconnect replay work as they do. A tab holds the socket of the agent on screen; switching closes it and opens
  the next one (the replay rebuilds the feed). A separate overview socket `/overview` streams the list of projects and
  agents with their state to every tab, which feeds the switcher and its "N waiting" count, and lets the server tell
  a tab to switch (see the launcher).
- **One-tab rule**: kept per agent as today (`occupied`, takeover). Two tabs may show two different agents.
- **Shared singletons to fix**: the Whisper host client's single `reportTo` becomes a list; the in-app update waits
  until no agent is busy and no tab is open across all agents; audit records carry the agent id.

### Lifecycle and launcher (phase 2)

- **Registry**: one server entry `~/.nota-bene/server.json` `{port, pid, startedAt, version, nonce, agents: [{id,
  provider, root}]}` under a server lock. The per-folder locks become an in-process map.
- **`nota-bene [dir]` and `/nb`**: if a server runs, ask it (control token, `POST /system/open {root, provider, mode:
  resume|new|fork, resume?}`) to open the agent and report its URL; if a tab of the server is connected, the server
  tells that tab to switch to the agent over `/overview` and no browser tab is opened; otherwise open the browser. If
  no server runs, start one detached and do the same. The `/nb` skill's background-task launch goes away: the
  server outlives the Claude Code session that started it.
- **Stop**: "Stop server" in the switcher menu and `nota-bene stop`; both stop every agent. "Close project" stops a
  project's agents and removes it from the running list.
- **Restart server** (exit 75) restarts the process and reopens every agent in `server.json`, each resuming its
  session, as `--continue` does today for one. **↻ Agent** restarts one agent.
- **Update handover** (exit 77) keeps its rule (no tab, nothing busy), now across all agents.
- **Existing windows**: during the switch to the new version an old-style window may still run. The switcher lists it
  (as in phase 1) and it is not adopted; it ends when the user stops it or the next update.

### Remote connector and phone (phase 2)

- The connector discovers the one server and lists its agents; `HostWindow` gets the agent id, and streams open by
  `{kind, agent, path}` instead of the port. The phone identifies a chat by host and agent id instead of port and
  root.
- The connector protocol and the phone change in the same phase; an older phone app says "update the app" instead of
  failing silently.

### Starter and switcher UI

- **Switcher** (header, left): the current project's name with its state dot; the menu has a search field (Alt+P),
  "Running" (each project with its agents: provider badge and state), "Recent", "Open folder…", "New project…", and
  in phase 2 "Stop server". Next to it, a count of agents waiting for the user.
- **Starter**: shown with no project open and from "Open folder…" / "New project…". "Open folder" browses folders from
  the home folder in our own picker (the browser has no native folder dialog; a Tauri shell can swap in the OS one).
  "New project" creates a folder under a chosen parent, optionally runs `git init`, and opens it. Both ask for the
  provider (default: the last used).
- Every new string in all UI languages.

### Decided after the review

- **One server for everything**, also while developing Nota Bene inside it: a checkout and an installed package do not
  get separate servers. "Restart server" first shows which agents are mid-turn and would be interrupted, and lets the
  user wait or go ahead; with nothing busy it restarts at once. A launcher of another version attaches to the running
  server; moving to a newer version is the update handover, as today.
- **Accounts**: for now every agent runs in the server's environment (the one it started with). Users with several
  subscriptions (two Claude accounts, GPT, outside vendors) will come, so nothing may tie an agent to the server's
  environment for good: the agent is keyed by `(provider, root)` now, and its start options are built in one place
  that a later account profile (config dir, keys, binary) can feed. Choosing an account per agent is a later change.

### Calls made while writing (not the user's; correct if wrong)

- **Process-level state** comes from the base state dir (today Claude's): one token, cookie, control token, audit log
  and updater; global prefs (language, theme, scale, sounds) as today. Per-root prefs (mode, model, idle compaction)
  stay per provider, read from that provider's dir. Tabs of the other providers log in once more after the move.
- **After a stop or a reboot** the server starts empty, with the previous projects under "Recent". After a crash or a
  restart (exit 75) it reopens every agent it had. No eviction of idle agents in this change.
- **The phone** sees and uses agents in phase 2; opening folders, creating projects and stopping the server stay
  web-only (the connector does not forward the new `/system/open`, picker and stop routes).
- **Old-style windows**: the connector lists both the server's agents and old windows while any old window runs. An
  old window that updates (exit 77) hands its folder to the server: the new launcher opens the agent there (starting
  the server if needed) and the old process ends.

## Left to the builder

- The exact agent id format and the `/a/<id>` prefix shape.
- How the overview stream is framed and throttled.
- The folder picker's details (hidden folders, a typed path).
- How the phase 1 hand-off mints the login credential, within the existing control relay and its checks.
- The split of phases into pull requests.

## Risks

- Phase 2 touches auth, routing, the launcher and the phone together; it needs characterization tests of today's
  window behavior first.
- One backend object serving several sessions of one provider may hide per-session assumptions (e.g. Codex's one RPC
  per session is fine; the Claude SDK and omp need a check).
- A crash now takes every project down at once; the launcher's crash-restart must reopen all agents.
