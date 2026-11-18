# Project switcher and starter (phase 1) Implementation Plan

**Goal:** One browser tab reaches every running Nota Bene window of every provider: a project switcher in the header lists them with their agent state and recent folders, switches the same tab to another window already logged in, and opens or creates a folder in a new window. (The menu was later reshaped as a chat list: see `2026-11-15-project-chat-list.md`.)

**Approach:** Phase 1 runs over today's one-process-per-window model. The current window's server does the cross-window work: it reads every provider's registry and token (as `server/src/remote/discover.ts` does), mints the target window's login URL (as the launcher's `loginTarget` does), and starts the launcher detached for a new folder. The page polls one route and navigates with `location.assign`.

**Spec:** `docs/superpowers/specs/2026-11-15-one-tab-projects-design.md` (phase 1; switcher and starter UI). Commits `gh-384: ...`.

## Constraints

- Node >=23.6 checkout; server TypeScript runs directly.
- Never put a login value (`#t=...`), token, key or control token in a log, audit record, error message, argv or URL query. The login URL travels only in a JSON response body, and the page uses it only in `location.assign`.
- All strings through `web/src/i18n` with real translations in all `LANGS` (`ru.ts` is the key source). A shortcut control names it with `withKey`.
- Tests: ports 4790-4795, temporary `NOTA_BENE_HOME`, neutral paths; never touch live windows.
- Failed or refused requests answer a short plain-text reason (`no such window`, `window not answering`, `exists`, `bad request`). `/system/windows`, Settings Windows tab and in-place `switch {id, dir}` stay as they are.

## Decisions

- Hand-off is minted locally, not through `/control/`: the server proves the target listener with the target provider's token (`proveListener`) and returns `http://127.0.0.1:<port>/#t=<loginCredential(token, port, nonce)>`, exactly as `loginTarget` in `bin/nota-bene.mjs` and the connector do. A control action would add a relay hop and gain nothing.
- State shown is what `/info` carries: working = `busy`; waiting = `pending` (wins over busy); idle otherwise; `restarting` and `silent` from the registry as in `listWindows`. The spec's "failed" state has no `/info` field and is left out of phase 1 rather than added to the wire.
- "Recent" is a new `recent.json` in the base state dir: `[{root, provider, at}]`, newest first, at most 30. The launcher writes it beside `rememberAgent`; folders known only from `agent-choice.json` are appended with `at: 0`; an in-place folder switch does not record.
- The starter is a dialog in phase 1 (every tab has a project; "no project open" first happens in phase 2). The picker starts at home, accepts any typed absolute path, shows hidden folders only with "Show hidden", and never writes a folder.
- Default provider for Open/New: the newest `recent.json` entry's if installed, else `defaultChoice` from `server/src/agent/choice.ts`.

## Contracts

### Server

- `server/src/recent.ts`: `RecentEntry {root, provider, at}`; `recordRecent(base, root, provider, now?)` (best effort, never throws; moves an existing `(root, provider)` entry to the front; `RECENT_MAX = 30`; file mode 600, tmp then `renameRetry`); `readRecent(base)` (newest first, then `agent-choice.json` folders absent from it with `at: 0`; bad or missing files read as empty, unknown providers dropped). `choice.ts` exports `readChoices(base)` rather than parsing twice. Launcher: `recordRecent(stateBaseDir(), o.dir, o.agent ?? 'claude')` after `rememberAgent`.
- `server/src/projects.ts`: `providerToken(dir)` exported from `discover.ts` (the former private `tokenOf`). `ProjectState = 'working'|'waiting'|'idle'|'restarting'|'silent'`; `RunningRow {provider, port, root (wire form), title, session, state, current, clients}`; `ProjectsList {running, recent: (RecentEntry & {running})[]}`. `listProjects(own, probe?)` probes every provider in parallel with its own token (700 ms timeout as `probeWindow`), sorts by folder name then provider order claude, codex, omp, marks `running` for a live `(root, provider)`; a provider dir without a token is skipped; a `SecretError` skips that provider with a warning. `enterUrl({provider, port, root})` requires a registry entry with a live pid and matching root (stored or wire form), proves the listener, checks `/info.root` with the helper bearer, and returns `{url}` or `{error: 'no such window' | 'window not answering'}`; a port now answering with another root or another provider's proof gets no login and no bearer is sent to an unproven listener.
- `server/src/projectRoutes.ts` (wired in `server.ts` beside `systemRoutes`; all key tier): `GET /system/projects` returns `ProjectsList`; `POST /system/projects/enter {provider, port, root}` gives `200 {url}`, `404 no such window` or `409 window not answering`; `GET /system/agents` returns `{agents, default}` (installed, not too old; `detectAgents` cached per process); `POST /system/folders {path?, hidden?}` returns `{path, parent, home, dirs: {name, git}[]}` (default home, case-insensitive sort, cap 500, symlinks by link name, `400` relative path, `404 not a folder`); `POST /system/projects/open {dir, provider, new?}` returns `200 {url}` or `502 <first line of the launcher's error>`; `POST /system/projects/create {parent, name, git, provider}` refuses with `400 bad request` an empty name, `.`, `..`, any `/`, `\` or NUL, leading or trailing space, or over 255 UTF-8 bytes, `409 exists` for an existing name, else `mkdir`, quiet `git init` when asked, then opens as `/open` does.
- Launcher: `Launch(args, env) => {code, firstLine}`, stubbed in tests; default runs `process.execPath [repoDir/bin/nota-bene.mjs, dir, '--agent', p, ('--new'), '--detach', '--no-open']` with a 30 s timeout, reading only stdout's first line. `launchEnv(env)` drops `NOTA_BENE_SUPERVISED`, `_LAUNCHER_PID`, `_NONCE`, `_AGENT`, `_INNER`, `_LOCKED`, `_AUTOPORT`, `_HANDOVER`, `_HANDOVER_NONCE`, `_UPDATED_FROM`, and keeps the rest (`NOTA_BENE_HOME`, `NOTA_BENE_PORT_RANGE`). The open route accepts only a line matching `^(opened|already-open) (http://127\.0\.0\.1:\d+/#t=[0-9a-f]{64})$`; any other line fails, and the line never goes to `reportError` or the audit (only the exit code does). An already-open folder navigates to the existing window, no second one starts.

### Web

- `web/src/projects/api.ts`: types mirrored (web does not import `server/`); `useProjects(active)` polls `GET /system/projects` every 3 s while the menu is open, every 10 s otherwise, only while the document is visible; `enterProject(row)` posts enter then `location.assign(url)`, a failure toasts the reason; `projectsMenu` handle for Alt+P; `openStarter(mode: 'open'|'new')`.
- `ProjectSwitcher.tsx` in `Header.tsx` (the trigger keeps `id="proj"`, e2e reads it): trigger shows the project and a waiting-count badge (`projWaitingTip`); tooltip `withKey(t('projSwitchTip'), 'hk_projects')`. `DropdownMenu`: focused search (filters by folder name and path), "Running" (one row per folder, each provider a sub-row with its state dot: working `text-accent`, waiting `text-warn`, idle `text-muted-foreground`), "Recent" (up to 10), separator, "Open folder..." and "New project...". The current window is marked with no action; restarting and silent rows show no action but the live ones still render. Binding `hk_projects` = Alt+P, `inFields: true` (Option+P types a pi on a Mac and the binding consumes it).
- `Starter.tsx` (`Dialog` from `components/ui/dialog.tsx`, mounted once in `App.tsx`): Open mode browses from home (click a folder to enter, Up, Home, Show hidden, typed absolute path browsed on Enter; a relative path shows `startPathAbs` and sends nothing), agent select defaulting to `/system/agents`'s default, Open posts `/system/projects/open`. New mode creates under the browsed folder ("Created in: path") with git on by default; the client-side name check mirrors the server's rule and disables Create. Refusals stay in the dialog (`409` shows `startExists`, `502` body inside `startFailed`, buttons re-enabled); while the launcher runs buttons are disabled with `startOpening`.
- Strings: `projSwitchTip`, `projSearch`, `projRunning`, `projRecent`, `projOpenFolder`, `projNew`, `projThis`, `projWorking`, `projWaiting`, `projIdle`, `projRestarting`, `projSilent`, `projWaitingTip(n)`, `projEnterFailed(why)`, `projNone`, `hk_projects`; `startOpenTitle`, `startNewTitle`, `startUp`, `startHome`, `startHidden`, `startPath`, `startPathAbs`, `startAgent`, `startOpen`, `startName`, `startGit`, `startCreate`, `startNameBad`, `startExists`, `startFailed(why)`, `startOpening`, `startEmpty`, `startIn(p)`. Header and keymap help-listing tests updated for the new binding.

## Review focus

- A registry entry whose port answers with another root or provider's proof: `409 window not answering`, nothing sent to an unproven listener.
- A folder name with a separator, `..`, NUL, a leading or trailing space or over 255 bytes: `400 bad request`, nothing created.
- Open on a folder that already has a window of that provider gets its `already-open URL`; no second window.
- The launcher failing or hanging: answered within 30 s with a short reason, stdout never echoed beyond the first line or logged.
- A window mid-restart and one that never answers are both listed with their own state.

## Docs and checks

`docs/guide.md` ("Projects": switcher, Alt+P, starter, what "waits for you" means), `docs/architecture.md` (one paragraph: cross-provider listing and login hand-off, pointing at the spec). Checks: `npx vitest run server/src/recent.test.ts server/src/projects.test.ts server/src/projectRoutes.test.ts server/src/system.test.ts server/src/security.test.ts web/src/projects web/src/shell web/src/i18n`, `npm test` (serialized, exit code), `npx tsc -b`, `npm run build -w web`. Manual smoke on test ports with a temp home and `NOTA_BENE_PORT_RANGE=4791-4795`: two windows on 4791/4792, the switcher lists B and moves the same tab there logged in, "New project..." creates C and moves the tab; stop all from Settings Windows, trash temp dirs; never echo the login URL.
