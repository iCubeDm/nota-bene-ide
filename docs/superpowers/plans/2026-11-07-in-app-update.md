# In-app update Implementation Plan

**Goal:** An installed Nota Bene updates from the window with one click, or by itself when the user chose so, and every open window restarts on the new version in a pause, continuing its session (#99).

**Approach:** One shared check per machine (`<state root>/update-check.json`, once a minute). Releases are installed into `<state root>/runtime/<version>/` by a window's server, under a machine lock; `runtime/current` names the one in use. The launcher becomes two parts: an outer part (started by the plugin or terminal) that makes the launch nonce and runs the newest launcher as an inner part, and the inner part (today's `supervise`). A server in a pause exits with the new code 77 (HANDOVER) when `current` differs from its version; the inner launcher returns 77 to the outer part, which starts the launcher of `current` on the same port with the same nonce, so the open tab reconnects. A new version that does not come up rolls `current` back.

**Spec:** `docs/superpowers/specs/2026-11-07-in-app-update-design.md`

## Decisions and constraints

- Noticing a release: the spec said about 10 minutes; tightened to npm asked once a minute per machine (about 2 KB per request, `GET registry.npmjs.org/nota-bene-ide/latest`), so within a minute or two; also on return to a window's tab.
- **Update automatically** is off by default, per machine (all agents), stored in the state folder root, not a provider's prefs.
- Check off (Settings or `NOTA_BENE_NO_UPDATE_CHECK`): nothing asked, nothing installed.
- Installs the newest release the machine has seen on npm, never a version the page names, only newer than the running one.
- A window restarts only in a pause: no turn running, empty composer, no question or approval waiting.
- One full package for every agent; `runtime/` keeps `current`, the one before, and any version a live window runs.
- A source checkout never checks, installs or hands over. Only plain `x.y.z` versions are compared.
- Rollback: new version did not answer `/info` within 20 s, or its launcher exited within its first 60 s.
- Tests: no network; launcher tests on ports 4791-4795; temporary `NOTA_BENE_HOME`. Strings in all six languages.

## Review focus

1. Two simultaneous installs: exactly one npm runs, the other sees "installing".
2. The lock holder dies mid-install: a later install takes over the stale lock.
3. `runtime/current` names a missing or broken folder: every launcher runs its own version, nothing crashes.
4. A rolled-back release is not auto-installed again, while **Update** still offers it.
5. A version a live window runs is never pruned.

## Design

**Shared check** (`server/src/update.ts`): `CHECK_EVERY_MS = 60_000`; `updateCheck(o?: {fetch?, now?, off?, file?})` returns `(current) => Promise<string|null>`; `latestKnown(o?)` reads the cached `latest` without fetching. File `{ "latest": string|null, "at": number }`, atomic write, mode 600. A broken file counts as stale; a failed fetch writes `at` keeping the previous `latest` (an offline machine does not retry every focus); an in-process `running` promise prevents concurrent asks.

**Runtime store** (`server/src/runtime.ts`, new; `windows.ts` registry entries gain `version?`):
- `runtimeDir()`, `launcherOf(v)` = `<runtimeDir>/<v>/node_modules/nota-bene-ide/bin/nota-bene.mjs`.
- `readCurrent()`: version in `<runtimeDir>/current` if `x.y.z` and its launcher exists, else null. `writeCurrent(v, expect?)`: atomic; with `expect`, compare-and-set (for rollback); records `previous`.
- `UpdateState = { auto; previous?; failed?: {version, at, reason}; rolledBack?: {version, at} }` in `<runtimeDir>/state.json` (mode 600); `readUpdateState`, `patchUpdateState`.
- `installing()` from lock `<runtimeDir>/update.lock` (`{version, pid}`; dead pid is stale).
- `installRelease(version, o?)` returns `'installed' | 'running' | {failed}`: `'running'` on a live lock; else take the lock (exclusive create, stale replaced), `npm install --prefix <runtimeDir>/<v> nota-bene-ide@<v> --no-audit --no-fund` (output to `update.log`), verify `node launcherOf(v) --version` prints `v`, `writeCurrent`, clear `failed`, prune, release. Any failure: `current` untouched, `failed` recorded, half-installed folder removed. npm: the one beside `process.execPath`, else on `PATH`, else `{failed: 'npm not found'}`.
- `pruneRuntime()` keeps `current`, `previous` and every `version` of a live registry entry (both provider registries).

**Launcher** (`bin/nota-bene.mjs`; `server/src/main.ts` exports `HANDOVER = 77`):
- `handoverTarget({own, current, published})` returns `current` when published, both `x.y.z` and `isNewer(current, own)`; else null.
- Env: outer sets `NOTA_BENE_INNER=1` (never redirect; return 77 to parent), `NOTA_BENE_HANDOVER_NONCE` (validated with `isNonce`), `NOTA_BENE_UPDATED_FROM`. `serverEnv` sets `NOTA_BENE_HANDOVER=1` on every server it starts (permission to exit 77) and passes `NOTA_BENE_UPDATED_FROM`.
- Outer loop (window launches only; not `--find/--last/--url/--front/--version/--help`; for `--detach` runs in the detached child): make nonce; if no target run today's launch in-process; else spawn `node launcherOf(t) <dir> --agent <agent> --port <port> --no-open` with inherited stdio and passed signals. On 77 read the registry entry for port and folder, keep it, loop with `NOTA_BENE_UPDATED_FROM` set. Other exit codes end the outer part.
- Rollback: after a handover to `t`, the inner exits with a code other than 0/130/143/77 within 60 s, or `/info` fails within 20 s (inner stopped) -> `writeCurrent(previous, t)`, record `rolledBack`, reason in `update.log`, loop again on the previous version, same port and nonce.
- `supervise` returns 77 on server exit 77, keeping the registry entry (as for 75); registers `packageVersion()`. The outer part is a separate small `outer(o, argv)`. Test-only hook `NOTA_BENE_TEST_PUBLISHED=1` (beside `NOTA_BENE_TEST_CRASH`).

**Window updater** (`server/src/updater.ts`, new; routes in `system.ts`, wiring in `server.ts`):
- `UpdatePhase = 'none'|'available'|'installing'|'ready'|'failed'|'rolled-back'`; `UpdateStatus = { current, latest, phase, canUpdate, auto, busy, log, failed?, rolledBack?, updatedFrom? }`. `canUpdate` = published install and `NOTA_BENE_HANDOVER=1`. `ready` = `readCurrent()` newer than own version, or this window runs the `rolledBack` release and `current` names another (windows on a rolled-back release go back in their pause).
- `updater({version, canUpdate, busy, tabs, exit, newer, install?, everyMs?})` gives `status`, `install`, `restart` (`'ok'|'busy'|'not-ready'`), `setAuto`, `stop`. Ticks every `CHECK_EVERY_MS` (30 s while ready): auto on, newer `latest`, no install running and `latest !== rolledBack` -> install; while ready with `tabs() === 0` and `!busy()` -> `exit(77)`. Nothing runs when `canUpdate` is false or the check is off. `busy` is session activity not idle, or switching.
- Routes (key tier): `GET /system/update`; `POST /system/update/install` (409 when `!canUpdate`); `POST /system/update/restart` (200 / 409 `busy` / 409 `not-ready`); `POST /system/update/auto {on}` (204, else 400).

**UI** (`UpdateNotice.tsx`, `SettingsView.tsx`, six i18n files):
- `available` + `canUpdate`: `↑ 1.7.0`; popover keeps changes and **Later**, adds **Update** and checkbox **Update automatically**. Without `canUpdate`: today's popover.
- `installing`: `Updating to ${v}…`, polled every 2 s.
- `ready`: `${v} is ready` with **Restart**, disabled while busy (title "After the agent finishes"); polled every 10 s; when composer is empty, nothing waiting and not busy, the page POSTs restart itself.
- `failed`: `Update failed` plus `Log: ${path}` and **Update** again. `rolled-back`: `Update to ${v} was rolled back` with the log.
- `updatedFrom` set: once per window and version (localStorage `nb.updated.<port>.<version>`) `Updated to ${v}` with the changes between.
- Settings, Defaults: switch **Update automatically** (hint: installs new releases and restarts each window when idle, for every agent on this computer), disabled while the check is off. The page also polls every minute besides load and focus.

## Tests

Check: two checkers on one file ask npm once a minute, ask again after a minute, broken file stale, off asks nothing. Runtime (fake npm script): install and point current, second install answers running, stale lock taken over, failed npm keeps current and records why, disagreeing version fails, current naming a missing folder reads null, expect-guarded write, prune keeps current/previous/live. Launcher: `handoverTarget` table (rc versions and unpublished give null); a server exit 77 starts the current launcher (stub) on the same port with same nonce and `NOTA_BENE_UPDATED_FROM`; a version that exits at once is rolled back and the checkout's server answers `/info` on the same port; a checkout never hands over. Updater (fake timers): auto off installs nothing, auto on installs once, rolled-back not auto-installed, idle ready window exits 77 (not with a tab or busy), restart answers busy. UI and settings as listed above.

## Docs and finish

`README.md`: a standing **Updating** section replaces "Updating to 1.6.0"; from 1.6.0 or older update once by hand: terminal `npm i -g nota-bene-ide@latest`; Claude plugin `claude plugin marketplace update nota-bene` then `claude plugin update nota-bene@nota-bene`, restart Claude Code; Codex plugin `codex plugin marketplace upgrade` then `codex plugin add nota-bene@nota-bene`; then close old windows (a `/nb` window is a background task, stop it in `/tasks`; terminal with Ctrl+C). `docs/guide.md` "Updates" (check, Update, auto, pause restart, rollback with log path, checkout never updates); `docs/agent-reference.md` (exit 77, outer/inner launcher, env vars, `runtime/` files); `docs/architecture.md` (state on disk). Final: `npx tsc -b`, `npm test`, `npm run build -w web`, `npm run e2e` sequentially; manual smoke on 4790 packing the branch and handing over from a lower version; PR `gh-99: in-app update`, `Closes #99`.
