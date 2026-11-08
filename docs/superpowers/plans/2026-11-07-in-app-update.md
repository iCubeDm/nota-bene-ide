# In-app update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installed Nota Bene updates from the window with one click, or by itself when the user chose so, and every open window restarts on the new version in a pause, continuing its session (#99).

**Architecture:** One shared check per machine (`<state root>/update-check.json`, once a minute). Releases are installed into `<state root>/runtime/<version>/` by the server of a window, under a machine lock, and `runtime/current` names the one in use (`server/src/runtime.ts`). The launcher becomes two parts: an outer part (the process the plugin or the terminal started) that makes the launch nonce and runs the newest launcher as an inner part, and the inner part (today's `supervise`). A server in a pause exits with the new code 77 (HANDOVER) when `current` differs from its version; the inner launcher returns 77 to the outer part, which starts the launcher of `current` on the same port with the same nonce, so the open tab reconnects. A new version that does not come up rolls `current` back.

**Tech Stack:** Node ≥22 (package) / ≥23.6 (checkout), TypeScript run directly, Vitest (node + launcher projects), React, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-07-in-app-update-design.md`

## Global Constraints

- "A newer release is noticed within about 10 minutes, and at once when the user comes back to a window's tab." The author tightened this after the spec: npm is asked once a minute (about 2 KB per request), so a release is noticed within a minute or two.
- npm is asked at most once a minute per machine; the request stays `GET registry.npmjs.org/nota-bene-ide/latest`.
- **Update automatically** is off by default; it is per machine (all agents), stored in the state folder's root, not in a provider's prefs.
- With the update check off (Settings or `NOTA_BENE_NO_UPDATE_CHECK`), nothing is asked and nothing is installed.
- What gets installed is the newest release the machine has seen on npm, never a version the page names, only newer than the running one.
- A window restarts only in a pause: no turn running, nothing in the composer, no question or approval waiting.
- One full package for every agent; `runtime/` keeps `current`, the one before it, and any version a live window runs.
- A source checkout never checks, installs or hands over. Only plain `x.y.z` versions are compared.
- Rollback: the new version did not answer `/info` within 20 s, or its launcher exited within its first 60 s.
- Every new or changed UI string in all six languages of `LANGS` (`web/src/i18n/*.ts`).
- Tests: no network, launcher tests on ports 4791–4795 only, temporary `NOTA_BENE_HOME`; never ports 4777–4789 or `~/.nota-bene`.
- Public repo: neutral fixtures. Work in a worktree on branch `gh-99-in-app-update`; the PR closes #99, squash only.

## Review Focus

1. Two windows (or two machines' worth of clicks) start an install at once: exactly one npm runs, the other sees "installing" (Task 2, lock test).
2. The window that holds the install lock dies mid-install (its Claude Code session closed): a later install takes over the stale lock instead of waiting forever (Task 2).
3. `runtime/current` names a version whose folder is gone or broken: every launcher runs its own version, nothing crashes (Task 3, `handoverTarget`).
4. A release that was rolled back is not installed again by the automatic update, while **Update** still offers it (Task 4).
5. A version a live window still runs is never pruned, even when it is neither `current` nor the previous one (Task 2).

## File Structure

- `server/src/update.ts` — the shared check (file cache, 1 min); existing `changelog` unchanged.
- `server/src/runtime.ts` (new) — paths of `runtime/`, `current`, the machine update state, the lock, `installRelease`, `pruneRuntime`.
- `server/src/updater.ts` (new) — a window's part: status, install, automatic install, the pause restart.
- `server/src/system.ts`, `server/src/server.ts`, `server/src/main.ts` — routes and the 77 exit.
- `server/src/windows.ts` — the registry entry records the window's version.
- `bin/nota-bene.mjs` — outer/inner launcher, handover, rollback.
- `web/src/shell/UpdateNotice.tsx`, `web/src/settings/SettingsView.tsx`, `web/src/i18n/*.ts` — the notice's states and the setting.
- `README.md`, `docs/guide.md`, `docs/agent-reference.md`, `docs/architecture.md` — docs.

---

### Task 1: The shared check

**Files:**
- Modify: `server/src/update.ts` (`CHECK_EVERY_MS`, `updateCheck`)
- Test: `server/src/update.test.ts`

**Interfaces:**
- Produces: `CHECK_EVERY_MS = 60_000`; `updateCheck(o?: { fetch?; now?; off?; file?: string }): (current: string) => Promise<string | null>` (same signature as today plus `file`, default `path.join(stateBaseDir(), 'update-check.json')`); `latestKnown(o?: { file?: string }): string | null` (the cached `latest`, no fetch). File shape: `{ "latest": string | null, "at": number }`, written atomically (tmp + rename, mode 600).

- [ ] **Step 1: Write the failing tests** (extend `update.test.ts`, temp dir per test)
  - `it('two checkers on one file ask npm once a minute')`: two `updateCheck({file, fetch, now})` instances, both called at t=0 and t=50 s → `fetch` called once; both return `'1.7.0'` for current `'1.6.0'`.
  - `it('asks again after a minute')`: t=0, t=60 s → two fetches.
  - `it('a broken file counts as stale')`: file holds `not json` → one fetch, file rewritten.
  - `it('off asks nothing and reads nothing')`: `off: () => true` → no fetch, returns null.
  - `it('latestKnown reads the file without asking')`.
- [ ] **Step 2: Run** `npx vitest run server/src/update.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the in-process `running` promise so one window does not ask twice concurrently; a failed fetch writes `at` with the previous `latest` kept, so an offline machine does not retry every focus.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `gh-99: one update check per machine, once a minute`

### Task 2: The runtime store and the install

**Files:**
- Create: `server/src/runtime.ts`, test `server/src/runtime.test.ts`
- Modify: `server/src/windows.ts` (`registerWindow(port, root, pid, launcherPid?, version?)`; entries gain `version?: string`)

**Interfaces:**
- Produces:
  - `runtimeDir(): string` = `path.join(stateBaseDir(), 'runtime')`
  - `launcherOf(v: string): string` = `<runtimeDir>/<v>/node_modules/nota-bene-ide/bin/nota-bene.mjs`
  - `readCurrent(): string | null` — the version in `<runtimeDir>/current` when it is `x.y.z` and `launcherOf(v)` exists, else null
  - `writeCurrent(v: string, expect?: string | null): boolean` — atomic; with `expect`, only when the file still says `expect` (compare-and-set for the rollback)
  - `type UpdateState = { auto: boolean; previous?: string; failed?: { version: string; at: number; reason: string }; rolledBack?: { version: string; at: number } }`; `readUpdateState(): UpdateState` (missing file → `{ auto: false }`); `patchUpdateState(f: (s: UpdateState) => UpdateState): void` — file `<runtimeDir>/state.json`, mode 600
  - `installing(): { version: string; pid: number } | null` — from the lock file `<runtimeDir>/update.lock` (`{version, pid}`; a dead pid is stale and reads as null)
  - `installRelease(version: string, o?: { npm?: string; node?: string; log?: string }): Promise<'installed' | 'running' | { failed: string }>` — `'running'` when a live lock exists; otherwise takes the lock (exclusive create; a stale one is replaced), runs `npm install --prefix <runtimeDir>/<v> nota-bene-ide@<v> --no-audit --no-fund` with output appended to `<runtimeDir>/update.log`, checks `node launcherOf(v) --version` prints `v`, `writeCurrent(v)`, clears `failed`, `pruneRuntime()`, releases the lock. Any failure: `current` untouched, `failed` recorded with the reason, the half-installed folder removed, lock released.
  - `pruneRuntime(): void` — keeps `current`, the previous `current` (`state.previous`, set by `writeCurrent` when it replaces a version), and every `version` of a live registry entry (both provider registries); removes the other `runtime/<x.y.z>/` folders.
  - Default npm: the `npm` beside `process.execPath`, else `npm` on `PATH`; none → `{ failed: 'npm not found' }`.

- [ ] **Step 1: Write the failing tests** (`NOTA_BENE_HOME` = temp dir; a fake npm = a small executable script, written by the test, that creates `<prefix>/node_modules/nota-bene-ide/package.json` and a `bin/nota-bene.mjs` printing the version, or exits 1 when `FAKE_NPM_FAIL=1`)
  - `it('installs, checks and points current at it')` → `'installed'`, `readCurrent() === '1.7.0'`, the log has the fake npm's output.
  - `it('a second install while one runs answers running')` — hold the lock with a live pid → `'running'`, fake npm not called.
  - `it('a stale lock is taken over')` — lock with a dead pid → `'installed'`.
  - `it('a failed npm keeps current and records why')` → `{failed}`, `readCurrent()` unchanged, `readUpdateState().failed.version === '1.7.0'`, no `runtime/1.7.0`.
  - `it('a version check that disagrees fails the install')` — the fake bin prints `1.6.9`.
  - `it('current names a missing folder: readCurrent is null')`.
  - `it('writeCurrent with expect refuses when another wrote meanwhile')`.
  - `it('prune keeps current, previous and versions live windows run')` — four installed versions, one live registry entry on the oldest (the test's own pid as `pid`), → that one, `current` and `previous` stay.
- [ ] **Step 2: Run** `npx vitest run server/src/runtime.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `runtime.ts` and the `version` field in `windows.ts` (written by the launcher in Task 3; absent entries are fine).
- [ ] **Step 4: Run** the same command and `npx vitest run server/src/windows.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `gh-99: the runtime store and the install`

### Task 3: The launcher hands over and rolls back

**Files:**
- Modify: `bin/nota-bene.mjs` (`main`, `launch`, `supervise`, `serverEnv`), `server/src/main.ts` (`export const HANDOVER = 77`)
- Test: `bin/nota-bene.test.ts` (launcher project, ports 4791–4795)

**Interfaces:**
- Consumes: `readCurrent`, `writeCurrent`, `launcherOf`, `patchUpdateState` (Task 2).
- Produces:
  - `HANDOVER = 77` in both files. Exit 77 from a server means "a newer version is current, hand over"; the inner launcher returns 77 to the outer part.
  - `export function handoverTarget(o: { own: string; current: string | null; published: boolean }): string | null` — `current` when `published`, both are `x.y.z` and `isNewer(current, own)`; else null (run yourself).
  - Env set by the outer part on an inner launcher: `NOTA_BENE_INNER=1` (never redirect; return 77 to the parent), `NOTA_BENE_HANDOVER_NONCE=<nonce>` (use it, validated with `isNonce`), `NOTA_BENE_UPDATED_FROM=<version>` (passed through to the server). `serverEnv` sets `NOTA_BENE_HANDOVER=1` on every server the launcher starts (the server's permission to exit 77) and passes `NOTA_BENE_UPDATED_FROM`.
  - The outer part's loop, for a window launch only (not `--find`/`--last`/`--url`/`--front`/`--version`/`--help`; for `--detach` it runs in the detached child): make the nonce; `t = handoverTarget(...)`; `t` null → run today's launch in-process with that nonce; else spawn `node launcherOf(t) <dir> --agent <agent> --port <port> --no-open` (first start: the user's own args instead, with `--no-open` dropped) with stdio inherited and signals passed on. On 77: read the window's registry entry (by launcher pid, or by port in-process) for port and folder, keep the entry, loop with `NOTA_BENE_UPDATED_FROM` = the version that just exited. Any other exit code ends the outer part with that code.
  - Rollback, in the outer part, after a handover to `t`: the inner launcher exited with a code other than 0/130/143/77 within 60 s, or `/info` on the port did not answer within 20 s (then the inner one is stopped) → `writeCurrent(previousVersion, t)`, `patchUpdateState` with `rolledBack: { version: t, at }`, `failed` reason in `update.log`, and the loop runs again (now on the previous version, same port and nonce).
  - `supervise`: a server exit 77 keeps the registry entry (as 75 does) and returns 77; `registerWindow` gets `packageVersion()` as `version`.

- [ ] **Step 1: Write the failing tests**
  - `describe('handoverTarget')`: `('1.6.0','1.7.0',true) → '1.7.0'`; `('1.7.0','1.6.0',true) → null`; `('1.7.0','1.7.0',true) → null`; `('1.6.0','1.7.0',false) → null`; `('1.6.0', null, true) → null`; `('1.6.0','1.7.0-rc.1',true) → null`.
  - `it('a server exit 77 starts the current launcher on the same port with the same nonce')`: temp `NOTA_BENE_HOME`; a fake runtime `1.99.0` whose `bin/nota-bene.mjs` is a stub that writes its argv and env to a file and exits 0; `current` = `1.99.0`; run the checkout launcher with a test hook that makes it treat itself as published (add `NOTA_BENE_TEST_PUBLISHED=1`, TEST-ONLY, beside the existing `NOTA_BENE_TEST_CRASH`), server exit forced to 77 (`NOTA_BENE_TEST_CRASH=77`) → the stub ran with `--port <same>`, `--no-open`, `NOTA_BENE_INNER=1`, `NOTA_BENE_HANDOVER_NONCE` equal to the nonce the first server got, `NOTA_BENE_UPDATED_FROM` = the checkout's version; launcher exit 0.
  - `it('a new version that exits at once is rolled back')`: the stub exits 1 at once → `runtime/current` back to what it was before (write the previous one first), `state.json` has `rolledBack.version === '1.99.0'`, and the window comes up again on the checkout's own server on the same port (`/info` answers).
  - `it('a checkout never hands over')`: no `NOTA_BENE_TEST_PUBLISHED`, `current` = `1.99.0` → the stub never runs.
- [ ] **Step 2: Run** `npx vitest run --project launcher bin/nota-bene.test.ts -t "handover|rolled back|never hands over|handoverTarget"` — Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the outer part a separate small function (`outer(o, argv)`), so `supervise` stays what it is plus the 77 branch.
- [ ] **Step 4: Run** the same command, then the whole launcher project once: `npx vitest run --project launcher` — Expected: PASS.
- [ ] **Step 5: Commit** `gh-99: the launcher hands a window over to the current version, and rolls back`

### Task 4: A window's updater and its routes

**Files:**
- Create: `server/src/updater.ts`, test `server/src/updater.test.ts`
- Modify: `server/src/system.ts` (`/system/update`, new `/system/update/install`, `/system/update/restart`, `/system/update/auto`), `server/src/server.ts` (wire it: `busy` from the session manager, `tabs` = `hub.clients()`, `exit` = `exitWith`), `server/src/system.test.ts`

**Interfaces:**
- Consumes: Task 1 `updateCheck`, `latestKnown`; Task 2 `readCurrent`, `installing`, `installRelease`, `readUpdateState`, `patchUpdateState`; Task 3 `HANDOVER`.
- Produces:
  - `type UpdatePhase = 'none' | 'available' | 'installing' | 'ready' | 'failed' | 'rolled-back'`
  - `type UpdateStatus = { current: string; latest: string | null; phase: UpdatePhase; canUpdate: boolean; auto: boolean; busy: boolean; log: string; failed?: string; rolledBack?: string; updatedFrom?: string }` — `canUpdate` = published install and `NOTA_BENE_HANDOVER=1`; `ready` = `readCurrent()` is newer than `current`, or this window runs the release in `rolledBack` and `readCurrent()` names another one (so windows already on a rolled-back release go back in their pause); `log` = the path of `update.log`; `updatedFrom` = `NOTA_BENE_UPDATED_FROM`.
  - `updater(o: { version: string; canUpdate: boolean; busy: () => boolean; tabs: () => number; exit: (code: number) => void; newer: (current: string) => Promise<string | null>; install?: typeof installRelease; everyMs?: number }): { status(): Promise<UpdateStatus>; install(): Promise<UpdateStatus>; restart(): 'ok' | 'busy' | 'not-ready'; setAuto(on: boolean): void; stop(): void }`
  - It ticks every `everyMs` (default `CHECK_EVERY_MS`) and every 30 s while `ready`: with `auto` on, a newer `latest`, no install running and `latest !== rolledBack` → `install()`; while `ready`, `tabs() === 0` and `!busy()` → `exit(HANDOVER)`. `restart()` is `'busy'` while `busy()`, `'not-ready'` unless `ready`, else exits 77 after the reply. Nothing ticks, installs or exits when `canUpdate` is false or the check is off.
  - Routes (key tier, like every `/system` route): `GET /system/update` → `UpdateStatus`; `POST /system/update/install` → `UpdateStatus` (409 when `!canUpdate`); `POST /system/update/restart` → 200 / 409 `busy` / 409 `not-ready`; `POST /system/update/auto` `{on: boolean}` → 204 (400 otherwise).

- [ ] **Step 1: Write the failing tests** (`updater.test.ts`, fake timers, injected `install`/`newer`, temp `NOTA_BENE_HOME`)
  - `it('auto off: a newer release is available, nothing installs')`.
  - `it('auto on: the tick installs once')` — two ticks while installing → `install` called once.
  - `it('a rolled-back release is not installed automatically, but install() still installs it')`.
  - `it('a window on a rolled-back release is ready to go back')` — `current` 1.6.0, own 1.7.0, `rolledBack.version` 1.7.0 → `phase: 'ready'`; without `rolledBack` → `'none'`.
  - `it('ready with no tab and an idle agent hands over')` → `exit(77)`; with a tab connected → no exit; busy → no exit.
  - `it('restart answers busy while a turn runs')`.
  - `it('cannot update: no ticks, install refused')`.
  - `system.test.ts`: the four routes' status codes and bodies, with a stub updater.
- [ ] **Step 2: Run** `npx vitest run server/src/updater.test.ts server/src/system.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `busy` is the session's `activity() !== 'idle'` or switching (what `/restart-server` callers already use).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `gh-99: a window's updater: install, automatic install, restart in a pause`

### Task 5: The notice, the setting and the page's pause

**Files:**
- Modify: `web/src/shell/UpdateNotice.tsx`, `web/src/settings/SettingsView.tsx`, `web/src/i18n/{en,ru,de,es,pt-BR,zh-CN}.ts`
- Test: `web/src/shell/UpdateNotice.test.tsx` (create if absent), `web/src/settings/SettingsView.test.tsx`

**Interfaces:**
- Consumes: Task 4's routes and `UpdateStatus`.
- Produces: the notice's states and strings (English copy fixed here; real translations in the other five):
  - `available`, `canUpdate`: `↑ 1.7.0`; the popover keeps the changes and **Later**, adds **Update** (`updateNow: 'Update'`) and the checkbox **Update automatically** (`updateAuto: 'Update automatically'`, POST `/system/update/auto`).
  - `available`, `!canUpdate`: today's popover unchanged.
  - `installing`: `Updating to ${v}…` (`updateInstalling`); polled every 2 s.
  - `ready`: `${v} is ready` (`updateReady`) with **Restart** (`updateRestart`), disabled while `busy` (title `updateRestartBusy: 'After the agent finishes'`). Polled every 10 s; when the composer is empty, no question or approval is waiting in the feed and `busy` is false, the page POSTs `/system/update/restart` itself.
  - `failed`: `Update failed` (`updateFailed`) with `Log: ${path}` (`updateLog`); **Update** again.
  - `rolled-back`: `Update to ${v} was rolled back` (`updateRolledBack`) with the log line.
  - `updatedFrom` set: once per window and version (localStorage key `nb.updated.<port>.<version>`), `Updated to ${v}` (`updatedTo`) with the changes between `updatedFrom` and the version.
  - Settings → Defaults: a switch **Update automatically** (`settingsAutoUpdate`, hint `settingsAutoUpdateHint: 'Installs new releases and restarts each window when it is idle. For every agent on this computer.'`), disabled while the update check is off.
  - The page also asks every minute besides load and focus.

- [ ] **Step 1: Write the failing tests** (stub `apiFetch`)
  - `it('offers Update and the checkbox when the window can update')`; `it('keeps the old popover when it cannot')`.
  - `it('shows Updating… and polls while installing')`; `it('ready: restarts by itself when idle and the composer is empty')` — POST `/system/update/restart` sent; with text in the composer, not sent; `busy` → **Restart** disabled.
  - `it('failed and rolled back name the log')`.
  - `it('Updated to shows once per window and version')`.
  - `SettingsView.test.tsx`: the switch posts `/system/update/auto` and is disabled with the check off.
- [ ] **Step 2: Run** `npx vitest run web/src/shell/UpdateNotice.test.tsx web/src/settings/SettingsView.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement**, every new key in all six language files (`i18n.test.ts` checks the keys; check by hand that no string is hard-coded).
- [ ] **Step 4: Run** the same command, `npx vitest run web/src/i18n/i18n.test.ts`, `npm run build -w web` — Expected: PASS, build exit 0.
- [ ] **Step 5: Commit** `gh-99: the update notice's states and the automatic update setting`

### Task 6: Docs, the last manual update, full checks

**Files:**
- Modify: `README.md` (replace "Updating to 1.6.0" with a standing **Updating** section), `docs/guide.md` ("Update check" → "Updates"), `docs/agent-reference.md` (launcher exit codes: 77; the runtime folder), `docs/architecture.md` (state on disk: `update-check.json`, `runtime/`)

- [ ] **Step 1: README "Updating"**: from this version on, windows update themselves (**Update** in the header, or **Update automatically**). Once, from 1.6.0 or older, by hand, one copyable block per install kind:
  - terminal: `npm i -g nota-bene-ide@latest`
  - Claude plugin: `claude plugin marketplace update nota-bene` then `claude plugin update nota-bene@nota-bene`, restart Claude Code
  - Codex plugin: `codex plugin marketplace upgrade` then `codex plugin add nota-bene@nota-bene`
  - then close the old windows: a window started by `/nb` is a background task of that Claude Code session (stop it in `/tasks`), a terminal window with Ctrl+C.
- [ ] **Step 2: guide.md**: the check (once a minute, one per machine, on focus), **Update**, **Update automatically** (off by default, per machine), restart in a pause, failure and rollback with the log path, a source checkout never updates.
- [ ] **Step 3: agent-reference.md and architecture.md**: exit 77 (HANDOVER), the outer/inner launcher, `NOTA_BENE_INNER` / `NOTA_BENE_HANDOVER_NONCE` / `NOTA_BENE_UPDATED_FROM` / `NOTA_BENE_HANDOVER`, `runtime/` (`current`, `state.json`, `update.lock`, `update.log`), `update-check.json`.
- [ ] **Step 4: Full checks, one after another**: `npx tsc -b`, `npm test`, `npm run build -w web`, `npm run e2e` — Expected: every exit code 0.
- [ ] **Step 5: Manual smoke on 4790** with a temp `NOTA_BENE_HOME`: pack the branch (`node scripts/build-package.mjs`), install the archive as version `X` into a temp prefix, put a second archive with a higher version into `runtime/` as `current`, open a window from the first, and see it hand over (header shows **Updated to**), then stop it. Record what was seen in the PR.
- [ ] **Step 6: Commit and open the PR** `gh-99: in-app update`, body `Closes #99.` ending with the attribution line.
