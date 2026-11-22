# One server, step 2c-2: attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nota-bene [dir]`, the starter and `/nb` open a folder as an agent of the running server (through `POST /control/open`)
instead of starting a window per folder; the server's extra agents survive its restart, crash and update; `/nb` no longer
runs the window as a Claude Code background task.

**Architecture:** The launcher looks for a live server that answers `/control/open` (every provider's registry, each entry
proved with its provider's token, as `server/src/projects.ts` does) before it starts one; a server-wide launch lock makes
two cold launches end with one server. The server keeps its extra agents in `<registry>/<port>.agents.json`, owned by it,
and reopens them when a relaunch of the same launch (same launcher pid or nonce) starts. `/nb` runs the launcher with
`--detach` in the foreground through `open.mjs` without `--plan`, which prints one `NB:` line without the login.

**Tech Stack:** Node ≥23.6 TypeScript run directly, the launcher `bin/nota-bene.mjs` (ESM importing server .ts), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-one-server-and-agent-bus-design.md` (M4 attach, restart; M3 auth).

## Global Constraints

- Tests and smoke only on ports 4790–4795 or port 0, with a temporary `NOTA_BENE_HOME` and `CLAUDE_JOURNAL_VAULT`.
- A login value (`#t=…`) never goes into a log, an error, stdout of `/nb`, or the transcript.
- A single window (no attach) behaves as today; `--port N` keeps starting a server on that port (no attach).
- Neutral fixtures (public repo). Every new UI string in all 6 languages (this step adds none).

## Rulings (decided here, against the spec)

- **Tokens stay per provider.** The spec's "one token in the base dir" (M3) is not needed for attach: a server keeps the
  token of the provider it started as, and the launcher logs in with that one. Moving tokens would sign out every Codex and
  omp tab and break the switcher's and connector's proofs of old windows mid-transition. Revisit in 2d if the phone needs it.
- **Registry stays `windows/<port>.json`.** It already is the server registry (connector, `--find`, switcher read it);
  `server.json` would be a second one. The agents list lives beside it as `<port>.agents.json`.
- **No in-progress map for `/control/open`** (final review): an open completes within one macrotask (no I/O is awaited
  in `startAgent`), so two asks cannot interleave; revisit if an agent's start ever awaits I/O.
- **Deferred minors** (final review): kept agents reopen before main installs its launcher watch (a backend start that
  hangs delays it); an attach during a server's restart gap or stop starts a second server; `<port>.agents.json` is not
  removed on a clean stop (only pid reuse on the same port would reopen old agents).
- **A tab is not switched in place yet**: attach opens the agent's URL `/a/<id>/` (the switcher's `/overview` is 2c-3).

## Review Focus

- A launch while only older windows run (no `/control/open`, 404): it starts a server as today.
- Two cold launches of different folders at once: one server, the second attaches.
- A server restart (75), crash and update (77) with an extra agent: the agent comes back under its id, resuming its folder's last session.
- A fresh launch after a stop: the old `<port>.agents.json` is ignored (different launcher pid and nonce) and replaced.
- `/nb` in a folder already served by an agent of the server: `already open`, no second agent, no login in the output.

---

### Task 1: The server reopens its extra agents

**Files:** Modify `server/src/windows.ts`, `server/src/server.ts`, `server/src/main.ts`. Test: `server/src/agents.test.ts`, `server/src/windows.test.ts`.

**Interfaces:**
- Produces (windows.ts): `type KeptAgent = { id: string; provider: AgentProvider; root: string }`;
  `writeKeptAgents(port: number, k: { launcherPid?: number; nonce: string; agents: KeptAgent[] }, base?: string): void` (atomic);
  `readKeptAgents(port: number, base?: string): { launcherPid?: number; nonce: string; agents: KeptAgent[] } | null` (bad file → null).
- Produces (server.ts): `ServerOptions.keep?: { launcherPid?: number }`: when set, after listen the server reads its port's
  file and, if `launcherPid` or `nonce` matches its own, reopens each agent (`launchTarget({dir: root, native})`, keeping its
  id; one that fails to open is reported and dropped); it rewrites the file after every open and every folder switch of an
  extra agent. `openAgent` takes an optional `id`.
- main.ts passes `keep: { launcherPid }` when supervised; `--fake` gets a `backends` factory over the same script.

- [ ] Tests: `windows.test.ts` "kept agents round-trip; a broken file reads null". `agents.test.ts`: "a relaunch with the same
  nonce reopens an extra agent under its id"; "a relaunch with the same launcher pid and a new nonce reopens it (crash)";
  "a fresh launch ignores the file and rewrites it". Run, watch them fail, implement, pass.
- [ ] Commit `gh-383: a server reopens its extra agents after a relaunch`.

### Task 2: The launcher attaches to a running server

**Files:** Create `server/src/attach.ts`, test `server/src/attach.test.ts`. Modify `bin/nota-bene.mjs`, `server/src/projectRoutes.ts`; test `bin/nota-bene.test.ts`, `server/src/projectRoutes.test.ts`.

**Interfaces:**
- `attachAgent(o: { root: string; provider: AgentProvider; mode: 'resume' | 'new'; session?: string; fork?: boolean }, fetchFn?: typeof fetch): Promise<{ port: number; agent: string; opened: boolean; url: string } | null>`:
  every provider's registry, live entries by port; each proved with its provider's token; `POST /control/open` with that
  provider's control token; 404/501/network error → next; 400 → throws `Error(body)`; `url` =
  `http://127.0.0.1:<port>/a/<agent>/#t=<loginCredential(token, port, nonce)>`. Never logs.
- Launcher: the launch lock is server-wide (`<base>/locks/server`); after the "old window serves this folder" check, unless
  `--port` was given, `attachAgent`; a hit: `--detach` prints `opened URL` / `already-open URL`; otherwise opens the browser
  through `writeOpenPage(url)` when `open`, prints `nota-bene: open at <url without the fragment>`, exits 0.
- projectRoutes `OPENED` takes an optional `a/<id>/` path.

- [ ] Tests: attach.test.ts with a real `startServer` on port 0 registered in a temp registry: "attaches to a server that
  opens agents", "skips an older server (404)", "a second call for the folder is not opened again", "no server → null".
  nota-bene.test.ts: "a second folder attaches to the running server" (two `--detach` launches, fake agent, one registry
  entry, the second line has `/a/<id>/`). projectRoutes.test.ts: an `opened` line with `/a/<id>/` is accepted.
- [ ] Commit `gh-383: the launcher opens a folder in the running server`.

### Task 3: `/nb` attaches, without a background task

**Files:** Modify `plugin/skills/nb/open.mjs`, `plugin/skills/nb/SKILL.md`; tests where open.mjs is tested (`bin/*.test.ts`).

- `--plan` prints `NB-RUN: <open.mjs without --plan>` only (plus `NB-NOTE:` on a first install); that run installs
  when needed (package), runs the launcher with `--detach`, and prints one `NB:` line:
  `NB: opened <url without #t=> for DIR<note>.` or `NB: already open at <url> …`, or the error. `--run` and `--wait` go.
- SKILL.md: run NB-RUN in the foreground (timeout 600000), relay the `NB:` line; the window no longer stops with the session.
- [ ] Tests updated to the new lines; one asserting no `#t=` in any output. Commit `gh-383: /nb opens the folder in the running server`.

### Task 4: Docs

- `docs/guide.md` (launch, `/nb`), `docs/agent-reference.md` (attach, kept agents, launch lock), design doc's PR chart
  (2c-2 attach, 2c-3 `/overview` + Stop server + switch in place, 2c-4 old windows' handover + app icon). Parse-check Mermaid.
- [ ] Commit `gh-383: docs for attach`.
