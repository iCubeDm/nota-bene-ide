# Project switcher and starter (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One browser tab reaches every running Nota Bene window of every provider: a project switcher in the header lists them with their agent state and recent folders, switches the same tab to another window already logged in, and opens or creates a folder in a new window.

**Architecture:** Phase 1 runs over today's one-process-per-window model. The current window's server does the cross-window work:
- it reads every provider's registry and token, as the remote connector already does (`server/src/remote/discover.ts`);
- it mints the target window's login URL, as the launcher's `loginTarget` does;
- it starts the launcher detached for a new folder.

The page polls one route and navigates with `location.assign`.

**Tech Stack:** Node (TypeScript run directly), React + Redux Toolkit, Radix dropdown/dialog wrappers in `web/src/components/ui`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-15-one-tab-projects-design.md` (phase 1; switcher and starter UI sections).

## Global Constraints

- Node >=23.6 for the checkout. The server's TypeScript runs directly; no build step for `server/`.
- **Never** put a login value (`#t=…`), a token, a key or a control token in a log, an audit record, an error message, an argv or a URL query.
  - The login URL travels only in a JSON response body to the page.
  - The page uses it only in `location.assign`.
- Every new user-visible string goes through `web/src/i18n`, with a real translation in all of `LANGS`: `en`, `ru`, `zh-CN`, `es`, `pt-BR`, `de`. `ru.ts` is the key source.
- A control with a shortcut names it in its tooltip with `withKey` (`web/src/shell/keymap.ts`).
- Tests use only ports 4790–4795, a temporary `NOTA_BENE_HOME`, and neutral fixture paths. Never touch the live windows under `~/.nota-bene`.
- A failed or refused request answers with a short plain-text reason (`no such window`, `window not answering`, `exists`, `bad request`), as the existing `/system/*` routes do.
- Preserve today's behavior:
  - `/system/windows` and the Settings → Windows tab stay as they are.
  - In-place `switch {id, dir}` stays as it is.

## Rulings made while planning (from the spec's "Left to the builder")

- **The hand-off is minted locally, not through `/control/`.** The current server proves the target listener with the target provider's token (`proveListener({dial, token})`) and returns `http://127.0.0.1:<port>/#t=<loginCredential(token, port, nonce)>`. This is exactly what `loginTarget` in `bin/nota-bene.mjs` does, and what the connector already trusts. A new control action would add a relay hop and gain nothing.
- **The state shown is what `/info` already carries.**
  - `working` = `busy`;
  - `waiting` = `pending` (pending wins over busy);
  - `idle` otherwise;
  - `restarting` and `silent` from the registry, as in `listWindows`.

  The spec's "failed" state has no field in `/info` today. It is left out of phase 1 rather than added to the wire.
- **"Recent" is a new `recent.json` in the base state dir.** It holds `[{root, provider, at}]`, newest first, at most 30 entries.
  - The launcher writes it where it already calls `rememberAgent`.
  - Folders known only from `agent-choice.json` are appended after it with `at: 0`, so existing users see their folders at once.
  - An in-place folder switch does not record (it does not pass the launcher).
- **The starter is a dialog in phase 1.** Every tab has a project now, so "no project open" first happens in phase 2.
- **The folder picker** starts at the home folder and accepts any absolute path the user types. Hidden folders (a name starting with `.`) appear only with "Show hidden". No folder is ever written by the picker.
- **The default provider** for Open/New is the one in the newest `recent.json` entry if it is installed, else `defaultChoice` from `server/src/agent/choice.ts`.

## Review Focus

- A registry entry whose port now answers with another root, or with another provider's proof: no login is minted for it (`409 window not answering`), and nothing is sent to an unproven listener.
- A folder name with a separator, `..`, NUL, a leading/trailing space or over 255 bytes on create: refused with `400 bad request`, and nothing is created.
- A folder that already has a window of the chosen provider: Open gets the launcher's `already-open URL` and navigates there; no second window is started.
- The launcher fails or hangs (bad folder, port race, build error): the route answers within 30 s with a short reason, and the page shows it in the starter. The route never echoes stdout beyond the first line, and never logs it.
- The switcher is opened while one window is in a restart gap and another never answers: both are listed, with their own state and no Enter action, and the list still renders the live ones.

---

### Task 1: Recent projects

**Files:**
- Create: `server/src/recent.ts`
- Create: `server/src/recent.test.ts`
- Modify: `bin/nota-bene.mjs:1100` (next to `rememberAgent`)

**Interfaces:**
- Produces:
  - `type RecentEntry = { root: string; provider: AgentProvider; at: number }`
  - `recordRecent(base: string, root: string, provider: AgentProvider, now?: number): void`. Best effort; never throws. It moves an existing `(root, provider)` entry to the front and caps the list at `RECENT_MAX = 30`.
  - `readRecent(base: string): RecentEntry[]`. Newest first, then the `agent-choice.json` folders absent from it, with `at: 0`. Bad or missing files read as empty.

- [ ] **Step 1: Write the failing tests** in `server/src/recent.test.ts`, on a `fs.mkdtempSync` base:
  - `records newest first and moves a reopened folder to the front`: record `/p/a` claude at 1, `/p/b` codex at 2, `/p/a` claude at 3; `readRecent` equals `[{root:'/p/a',provider:'claude',at:3},{root:'/p/b',provider:'codex',at:2}]`.
  - `keeps one entry per folder and provider`: `/p/a` claude and `/p/a` codex are two entries.
  - `caps at RECENT_MAX`: 35 records give 30 entries, and the oldest 5 are gone.
  - `seeds from agent-choice.json`: write `{"/p/c":"omp"}` to `agent-choice.json` and record `/p/a`. The result ends with `{root:'/p/c',provider:'omp',at:0}`. A folder present in both appears once.
  - `unreadable files read as empty`: `recent.json` = `{not json` gives `[]`, and an entry with an unknown provider is dropped.
- [ ] **Step 2: Run** `npx vitest run server/src/recent.test.ts`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Implement `server/src/recent.ts`.**
  - Write the file like `rememberAgent` does: mode 600, tmp then `renameRetry`, inside try/catch.
  - Read `agent-choice.json` through `lastAgent`'s file. Export a `readChoices(base)` from `choice.ts` rather than parsing the file twice.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Wire the launcher.** In `bin/nota-bene.mjs`, after `rememberAgent(stateBaseDir(), o.dir, o.agent ?? 'claude')`, add `recordRecent(stateBaseDir(), o.dir, o.agent ?? 'claude')`, imported from `../server/src/recent.ts`.
  - Run `npx vitest run bin/` (or `bin/nota-bene.test.ts`). Expected: PASS, with no change to existing launcher tests.
- [ ] **Step 6: Commit.** `git add server/src/recent.ts server/src/recent.test.ts server/src/agent/choice.ts bin/nota-bene.mjs`, then `git commit -m "gh-384: remember recently opened folders"`

### Task 2: Every provider's windows, and the login hand-off

**Files:**
- Create: `server/src/projects.ts`
- Create: `server/src/projects.test.ts`
- Modify: `server/src/remote/discover.ts` (export the token reader)

**Interfaces:**
- Consumes: `readRecent` (Task 1); `readWindows(base)`, `pidAlive` (`windows.ts`); `proveListener`, `loginCredential`, `helperCredential` (`auth.ts`); `providerStateDir`, `AgentProvider` (`agent/provider.ts`).
- Produces:
  - `export function providerToken(dir: string): string | null` in `discover.ts`. This is today's private `tokenOf`, renamed and exported; the `Windows` class uses it.
  - `type ProjectState = 'working' | 'waiting' | 'idle' | 'restarting' | 'silent'`
  - `type RunningRow = { provider: AgentProvider; port: number; root: string; title: string | null; session: string | null; state: ProjectState; current: boolean; clients: number }`. `root` is in wire form (`wirePath`).
  - `type ProjectsList = { running: RunningRow[]; recent: (RecentEntry & { running: boolean })[] }`
  - `listProjects(own: { port: number; provider: AgentProvider }, probe?: (port: number, token: string) => Promise<WindowInfo | null>): Promise<ProjectsList>`.
    - Probes every provider, with that provider's token.
    - Sorts running rows by project folder name, then provider order claude, codex, omp.
    - `recent` excludes nothing, and marks `running` for a live `(root, provider)`.
    - A provider dir without a token is skipped. A `SecretError` for one provider skips that provider, reported via the caller's `warn`; it is not fatal.
  - `enterUrl(o: { provider: AgentProvider; port: number; root: string }): Promise<{ url: string } | { error: 'no such window' | 'window not answering' }>`.
    - Checks the registry entry: it must exist, its pid must be alive, and its root must equal `o.root` (stored or wire form).
    - Proves the listener with that provider's token.
    - Checks `/info.root` with the helper bearer.
    - Returns `http://127.0.0.1:${port}/#t=${loginCredential(token, port, nonce)}`.

- [ ] **Step 1: Write the failing tests** in `server/src/projects.test.ts`. Boot real servers as `system.test.ts` does: `startServer` with auth on, temporary `NOTA_BENE_HOME`, `registerWindow`. For a second provider, set `NOTA_BENE_AGENT=codex` around its `startServer` and `registerWindow`.
  - `lists the windows of every provider with their state`: a claude window and a codex window are both in `running`, with the right `provider`, and `current` is true only for `own.port`. A busy fake backend turn gives `working`. A server whose `/info.pending` is set gives `waiting`.
  - `a restarting entry and a silent one are listed without a session`: a dead pid with a live `launcherPid` gives `restarting`. Use `process.pid` as the launcher and a dead pid as the server.
  - `recent marks the running folders`: the record for the running claude root has `running: true`.
  - `enterUrl mints a login that the target accepts`: `POST /auth` on the target with the fragment's value succeeds (as `auth.test.ts` does). The response is `{ url }` and matches `^http://127\.0\.0\.1:\d+/#t=[0-9a-f]{64}$`.
  - `enterUrl refuses a port whose root changed`: a registry entry with another root gives `{ error: 'window not answering' }` or `no such window`, and the target saw no `/info` request with a bearer. Assert with a counting probe.
  - `enterUrl refuses another provider's listener`: the entry is filed under codex, but the port is a claude server. The proof fails, so the result is `{ error: 'window not answering' }`.
- [ ] **Step 2: Run** `npx vitest run server/src/projects.test.ts`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Implement `server/src/projects.ts` and the `discover.ts` export.**
  - The state mapping is in the planning rulings above.
  - Probe in parallel, with a 700 ms timeout per window as `probeWindow` does.
- [ ] **Step 4: Run** `npx vitest run server/src/projects.test.ts server/src/remote/discover.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "gh-384: list every provider's windows and mint a login for one"`

### Task 3: Folder picker, agents, open and create routes

**Files:**
- Create: `server/src/projectRoutes.ts` (the routes, wired like `systemRoutes`)
- Create: `server/src/projectRoutes.test.ts`
- Modify: `server/src/server.ts:361` (spread `projectRoutes({...})` next to `systemRoutes`)

**Interfaces:**
- Consumes: `listProjects`, `enterUrl` (Task 2); `readRecent` (Task 1); `detectAgents`, `defaultChoice` (`agent/choice.ts`); `readJson` (`system.ts`); `reportError` (`errors.ts`); `HIDDEN` (`platform.ts`).
- Produces the routes. All of them are key tier (the `extra` default) and POST unless noted:
  - `GET /system/projects` returns a `ProjectsList`.
  - `/system/projects/enter {provider, port, root}` returns `200 {url}`, `404 no such window` or `409 window not answering`.
  - `GET /system/agents` returns `{ agents: AgentProvider[], default: AgentProvider }`. These are the installed, not-too-old agents; the default is per the planning ruling. The `detectAgents` result is cached for the process.
  - `/system/folders {path?: string, hidden?: boolean}` returns `{ path, parent: string | null, home, dirs: { name: string; git: boolean }[] }`.
    - The default path is `os.homedir()`.
    - Dirs are sorted case-insensitively and capped at 500.
    - Symlinked dirs are listed by their link name.
    - `400 bad request` for a relative path; `404 not a folder` for a missing one or a file.
  - `/system/projects/open {dir, provider, new?: boolean}` returns `200 {url}` or `502 <first line of the launcher's error>`.
  - `/system/projects/create {parent, name, git: boolean, provider}`.
    - Refuses with `400 bad request` a `name` that is not a valid folder name: empty, `.`, `..`, contains `/`, `\` or NUL, has a leading or trailing space, or is over 255 UTF-8 bytes.
    - Refuses with `409 exists` a name that is already there.
    - Otherwise it runs `mkdir`, then `git init`, quiet, with `HIDDEN`, when `git` is set. Then it opens the folder as `/open` does.
  - `projectRoutes(o: { hub: EventHub; port: () => number; provider: AgentProvider; repoDir: string; launch?: Launch })`
  - `type Launch = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; firstLine: string }>`. Tests stub it.
    - The default runs `process.execPath [repoDir/bin/nota-bene.mjs, dir, '--agent', p, ('--new'), '--detach', '--no-open']`.
    - It has a 30 s timeout and reads only stdout's first line.
  - `launchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv` drops the launch-state variables: `NOTA_BENE_SUPERVISED`, `NOTA_BENE_LAUNCHER_PID`, `NOTA_BENE_NONCE`, `NOTA_BENE_AGENT`, `NOTA_BENE_INNER`, `NOTA_BENE_LOCKED`, `NOTA_BENE_AUTOPORT`, `NOTA_BENE_HANDOVER`, `NOTA_BENE_HANDOVER_NONCE`, `NOTA_BENE_UPDATED_FROM`. It keeps everything else, `NOTA_BENE_HOME` and `NOTA_BENE_PORT_RANGE` included.
  - The open route parses `^(opened|already-open) (http://127\.0\.0\.1:\d+/#t=[0-9a-f]{64})$` and answers `{url}` with the second group. Any other line is a failure. The line is never passed to `reportError` or the audit log; only the exit code is reported.

- [ ] **Step 1: Write the failing tests** in `server/src/projectRoutes.test.ts`. Mount the routes on a `startServer` with `insecureNoAuth` as `system.test.ts` boots it, and stub `launch`.
  - `folders lists subfolders, hides dot folders unless asked, and marks git repos`: a temp tree with `a/`, `B/.git/`, `.hid/` and the file `f.txt`. The result is `dirs` = `[{name:'a',git:false},{name:'B',git:true}]`; with `hidden: true` it also has `.hid`. `parent` is the tree's parent folder.
  - `folders refuses a relative path and a file`: `400` and `404`.
  - `open passes the agent and the folder to the launcher and returns its URL`:
    - the stub gets args containing `dir`, `--agent codex`, `--detach` and `--no-open`, and the env has no `NOTA_BENE_NONCE` (set one in `process.env` for the test);
    - the stub returns `{code:0, firstLine:'opened http://127.0.0.1:4793/#t=' + 'a'.repeat(64)}`, and the response is `{url}` with that URL.
  - `open with already-open returns that window's URL`.
  - `open reports a launcher failure without its output`: the stub returns `{code:1, firstLine:'nota-bene: cannot use /x'}`. The response is `502` with the body `nota-bene: cannot use /x`, and `hub` received no event whose text contains `#t=`.
  - `create refuses bad names` for each of `''`, `'.'`, `'..'`, `'a/b'`, `'a\\b'`, `' a'`, `'a '`, `'a\0b'` and `'x'.repeat(256)`: `400`, and nothing appeared under the parent.
  - `create makes the folder, runs git init when asked, and opens it`: the folder exists, `.git` exists only with `git: true`, and the stub was called with the new folder.
  - `create refuses an existing name with 409 exists`.
  - `agents lists the installed agents and a default`: stub `detectAgents` via an option, and pass `probe` the same way `choice.test.ts` does.
- [ ] **Step 2: Run** `npx vitest run server/src/projectRoutes.test.ts`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Implement `server/src/projectRoutes.ts`; wire it in `server.ts`.**
  - The provider is `parseProvider(process.env.NOTA_BENE_AGENT)`.
  - `repoDir` is the one `server.ts` already computes.
- [ ] **Step 4: Run** `npx vitest run server/src/projectRoutes.test.ts server/src/system.test.ts server/src/security.test.ts`. Expected: PASS. `security.test.ts` holds the key-tier guards, and new routes must need the key.
- [ ] **Step 5: Run** `npx tsc -b`. Expected: no errors.
- [ ] **Step 6: Commit.** `git commit -m "gh-384: routes to list, enter, browse, open and create projects"`

### Task 4: The switcher in the header

**Files:**
- Create: `web/src/projects/api.ts` (fetch helpers and the polling hook)
- Create: `web/src/projects/ProjectSwitcher.tsx`
- Create: `web/src/projects/ProjectSwitcher.test.tsx`
- Modify: `web/src/shell/Header.tsx:44` (the `<b id="proj">` becomes the switcher's trigger)
- Modify: `web/src/shell/keymap.ts` (binding `hk_projects`)
- Modify: `web/src/i18n/{ru,en,zh-CN,es,pt-BR,de}.ts`

**Interfaces:**
- Consumes: the Task 3 routes and their response types. Mirror the types in `web/src/projects/api.ts`; the web does not import from `server/`.
- Produces:
  - `useProjects(active: boolean): { data: ProjectsList | null; error: string | null; reload(): void }`. It polls `GET /system/projects` every 3 s while `active` (the menu is open) and every 10 s otherwise, and only while `document.visibilityState === 'visible'`.
  - `enterProject(row: RunningRow): Promise<void>`. It posts `/system/projects/enter`, then calls `location.assign(url)`. On failure it shows a toast with the reason, through `toast` (`shell/toast.ts`).
  - `projectsMenu`: an open/close handle like `recentModal`, for Alt+P.
  - `openStarter(mode: 'open' | 'new')`, from Task 5. Until Task 5 lands, the two menu items call a no-op that Task 5 replaces.

- [ ] **Step 1: Write the failing tests** in `web/src/projects/ProjectSwitcher.test.tsx`. Stub `fetch` for `/system/projects` with two claude rows (current `notes`, `waiting` on `site`), one codex row (`working` on `site`) and two recent entries (one running, one not).
  - `the trigger shows the project and the waiting count`: the trigger button's name includes `notes`, and a badge reads `1`, with the `projWaitingTip` tooltip.
  - `the menu groups running windows by folder with provider and state`:
    - `site` is listed once, with `Claude · waits for you` and `Codex · working`;
    - the current window is marked and has no action;
    - the "Recent" section lists only the folder that is not running.
  - `search filters running and recent by folder name and path`: typing `sit` leaves only `site`.
  - `choosing a window posts enter and navigates`: `fetch` receives `/system/projects/enter` with `{provider:'codex', port, root}`, and `location.assign` is called with the returned URL. Stub `window.location.assign` with `vi.spyOn` on a replaced `location`.
  - `a failed enter shows its reason and stays`: a `409 window not answering` gives a toast containing `projEnterFailed`'s text, and no navigation.
  - `restarting and silent rows are shown without an action`.
  - `Alt+P opens the menu with the search focused`. This goes through `BINDINGS`, as `keymap.test.tsx` does it.
  - `every new string exists in every language`: covered by `i18n.test.ts`. Run it in Step 4; no new test.
- [ ] **Step 2: Run** `npx vitest run web/src/projects/ProjectSwitcher.test.tsx`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Implement.**
  - The trigger keeps `id="proj"` on the project name. The e2e tests read it.
  - The trigger's tooltip is `withKey(t('projSwitchTip'), 'hk_projects')`.
  - The menu is a `DropdownMenu` with these parts:
    - the search input, focused on open;
    - "Running": one row per folder, each provider a sub-row with its state dot;
    - "Recent": up to 10 entries;
    - a separator, then "Open folder…" and "New project…".
  - State dot colours reuse the existing tokens: working `text-accent`, waiting `text-warn`, idle `text-muted-foreground`.
  - Strings, as `ru` / `en`. Give a real translation of each into `zh-CN`, `es`, `pt-BR` and `de`:
    - `projSwitchTip`: «Проекты: переключиться, открыть, создать» / "Projects: switch, open, create"
    - `projSearch`: «Найти проект» / "Find a project"
    - `projRunning`: «Запущены» / "Running"
    - `projRecent`: «Недавние» / "Recent"
    - `projOpenFolder`: «Открыть папку…» / "Open folder…"
    - `projNew`: «Новый проект…» / "New project…"
    - `projThis`: «это окно» / "this window"
    - `projWorking`: «работает» / "working"
    - `projWaiting`: «ждёт тебя» / "waits for you"
    - `projIdle`: «свободен» / "idle"
    - `projRestarting`: «перезапускается» / "restarting"
    - `projSilent`: «не отвечает» / "not answering"
    - `projWaitingTip`: `(n) => …` «Ждут тебя: n» / "Waiting for you: n"
    - `projEnterFailed`: `(why) => …` «Не удалось перейти: why» / "Could not switch: why"
    - `projNone`: «Ничего не найдено» / "Nothing found"
    - `hk_projects`: «проекты: переключить, открыть, создать» / "projects: switch, open, create"
  - The binding: `{ id: 'hk_projects', codes: ['KeyP'], mods: { alt: true }, inFields: true, run: () => projectsMenu.toggle() }`. In a field too, as `hk_recent` is: Option+P types π on a Mac, and the binding consumes it.
- [ ] **Step 4: Run** `npx vitest run web/src/projects web/src/shell web/src/i18n`. Expected: PASS. The `Header.test.tsx` and `keymap.test.tsx` help listings may need the new binding in their expected lists; update them in this step.
- [ ] **Step 5: Run** `npm run build -w web`. Expected: the build succeeds.
- [ ] **Step 6: Commit.** `git commit -m "gh-384: project switcher in the header"`

### Task 5: The starter dialog

**Files:**
- Create: `web/src/projects/Starter.tsx`
- Create: `web/src/projects/Starter.test.tsx`
- Modify: `web/src/projects/ProjectSwitcher.tsx` (the two menu items open it)
- Modify: `web/src/App.tsx` (mount `<Starter />` once, next to the other modals)
- Modify: `web/src/i18n/{ru,en,zh-CN,es,pt-BR,de}.ts`

**Interfaces:**
- Consumes: `GET /system/agents`, `/system/folders`, `/system/projects/open` and `/system/projects/create` (Task 3).
- Produces: `openStarter(mode: 'open' | 'new'): void`, which `ProjectSwitcher` calls.

- [ ] **Step 1: Write the failing tests** in `web/src/projects/Starter.test.tsx`, with `fetch` stubbed per route:
  - `open: browses from home, enters a folder, goes up, and opens the chosen one with the chosen agent`:
    - it lists the home folder's `dirs`;
    - a click on `a` requests `/system/folders {path: home/a}`;
    - "Up" requests the parent;
    - the agent select defaults to `/system/agents`'s `default`;
    - "Open" posts `/system/projects/open {dir, provider}`;
    - `location.assign` gets the URL.
  - `open: a typed absolute path is browsed on Enter`; a relative one shows `startPathAbs` and sends nothing.
  - `open: show hidden re-requests with hidden: true`.
  - `new: creates under the browsed folder with git init on by default`: posts `/system/projects/create {parent, name, git: true, provider}` and navigates.
  - `new: a bad name is refused before sending`: for `a/b` it shows `startNameBad`, and the Create button is disabled.
  - `a server refusal is shown in the dialog`:
    - `409 exists` gives `startExists`;
    - a `502` body is shown inside `startFailed`;
    - the dialog stays open, and the buttons are enabled again.
  - `while the launcher runs the buttons are disabled and a wait line is shown` (`startOpening`).
- [ ] **Step 2: Run** `npx vitest run web/src/projects/Starter.test.tsx`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Implement** with `Dialog` from `components/ui/dialog.tsx`.
  - The client-side name check mirrors the server's rule in Task 3.
  - The `git` checkbox exists only in `new` mode.
  - Strings, as `ru` / `en`. Give a real translation of each into `zh-CN`, `es`, `pt-BR` and `de`:
    - `startOpenTitle`: «Открыть папку» / "Open folder"
    - `startNewTitle`: «Новый проект» / "New project"
    - `startUp`: «Вверх» / "Up"
    - `startHome`: «Домой» / "Home"
    - `startHidden`: «Скрытые папки» / "Show hidden"
    - `startPath`: «Путь» / "Path"
    - `startPathAbs`: «Нужен полный путь» / "Enter a full path"
    - `startAgent`: «Агент» / "Agent"
    - `startOpen`: «Открыть» / "Open"
    - `startName`: «Имя папки» / "Folder name"
    - `startGit`: «Сделать git-репозиторий» / "Make it a git repository"
    - `startCreate`: «Создать и открыть» / "Create and open"
    - `startNameBad`: «Недопустимое имя папки» / "Not a valid folder name"
    - `startExists`: «Такая папка уже есть» / "That folder already exists"
    - `startFailed`: `(why) => …` «Не удалось открыть: why» / "Could not open: why"
    - `startOpening`: «Запускаю окно…» / "Starting the window…"
    - `startEmpty`: «Здесь нет папок» / "No folders here"
  - The parent folder of "New project" is the folder being browsed. It is named in the dialog as «Будет создана в: path» / "Created in: path" (`startIn: (p) => …`).
- [ ] **Step 4: Run** `npx vitest run web/src/projects web/src/i18n`. Expected: PASS.
- [ ] **Step 5: Run** `npm run build -w web && npx tsc -b`. Expected: both succeed.
- [ ] **Step 6: Commit.** `git commit -m "gh-384: starter to open or create a project"`

### Task 6: Docs, full checks, manual smoke

**Files:**
- Modify: `docs/guide.md` (a "Projects" section on the switcher, Alt+P, the starter, and what "waits for you" means)
- Modify: `docs/architecture.md` (one paragraph: cross-provider listing and login hand-off in phase 1; point at the spec)

- [ ] **Step 1: Write the docs sections.** Keep them neutral: no personal paths.
- [ ] **Step 2: Run** `npm test > /tmp/nb-sw-test.log 2>&1; echo exit=$?`, then read the tail. Expected: `exit=0`. Serialize with any other checkout's full suite.
- [ ] **Step 3: Run** `npx tsc -b && npm run build -w web`. Expected: both succeed.
- [ ] **Step 4: Manual smoke** on the test ports only:
  1. Use `NOTA_BENE_HOME=$(mktemp -d)` and `NOTA_BENE_PORT_RANGE=4791-4795`, and start two windows with `node bin/nota-bene.mjs <tmp project A> --agent claude --port 4791 --detach --no-open` and the same for project B on 4792.
  2. Open 4791's printed URL with `open "$url"`. Never echo it.
  3. In the switcher, check that B is listed. Choose it: the same tab lands on 4792, logged in.
  4. Use "New project…" to create C under a temp parent; a third window starts and the tab moves there.
  5. Stop all three windows from Settings → Windows, then trash the temp dirs.
- [ ] **Step 5: Commit.** `git commit -m "gh-384: document the project switcher"`
