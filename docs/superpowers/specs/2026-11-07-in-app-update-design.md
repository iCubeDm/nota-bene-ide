# In-app update: one click, or by itself, every window

## Intent

The first user to update 1.5.0 to 1.6.0 needed over half an hour and chat help. What went wrong: (1) no notice (the window asked npm before the release and not again for 6 h); (2) `npm i -g` changed nothing because `/nb` runs the plugin's own pinned copy; (3) the Claude plugin needs two commands to update; (4) after the plugin update `/nb` focused the old 1.5.0 window (a running window keeps its code); (5) removing it meant stopping a background task in the Claude Code session, found only by guessing `/tasks`.

Goal: a window shows `↑ 1.7.0`; one click (or nothing, with automatic updates) and every open window runs 1.7.0 in the same sessions. No commands, no tasks to stop, no windows to close.

## Goals, non-goals, anti-goals

Goals: a new release noticed within ~10 min and at once when the user returns to the tab; **Update** installs and restarts every open window of the machine continuing its session; **Automatic updates** (off by default) do it without the click; same for the Claude plugin, Codex plugin and global `npm i -g`; after an update the window says once what changed; after a failure it says so, names the log, and the old version keeps working.

Non-goals: updating a source checkout (never checks); updating Claude Code/Codex/omp themselves; downgrades or version choice; Windows; release channels.

Anti-goals: a turn cut off by an update; a lost composer draft; a window that does not return; the page (or anything but the user's click/setting) deciding what is installed; more npm requests because more windows are open.

## Constraints

macOS and Linux, Node >= 22. State folder (`~/.nota-bene`, `NOTA_BENE_HOME`) stays private (700); nothing new listens on a port. One package is ~330 MB installed (70 MB via the Codex plugin, which omits Agent SDK binaries). All strings in six languages. Windows of Claude, Codex and omp share the state root; their dirs are `providers/<agent>`. The existing check (`server/src/update.ts`, `/system/update`, `web/src/shell/UpdateNotice.tsx`, Settings switch, `NOTA_BENE_NO_UPDATE_CHECK`) stays the gate: with it off, nothing is asked or installed.

## Decisions

### Noticing a release (author)

npm is asked at most once per 10 min per machine, not per window: the answer is kept in a file in the state root and every window reads it; a page asks its server on load and tab focus; the server asks npm only when the file is older than 10 min. Request unchanged: `GET registry.npmjs.org/nota-bene-ide/latest`, no project/session/account data.

### One copy per machine (my call)

- Releases live in `<state root>/runtime/<version>/` (`npm install --prefix` of `nota-bene-ide@<version>`); `runtime/current` names the one in use.
- Every start path (Claude plugin `open.sh`, Codex plugin `open.mjs`, global `nota-bene`) runs the newer of its own version and `current`; updating no longer depends on the plugin, a plugin update still works.
- Existing per-version plugin installs and the Codex npm cache keep working; nothing migrates; the first in-app update creates `runtime/`.
- `runtime/` keeps `current` and the previous one (fallback); older ones are removed after success.
- One package for every agent (author): `runtime/` holds the full ~330 MB package for Claude, Codex and omp windows; a Codex user's first update downloads it once instead of 70 MB.
- The launcher chooses at start (not the plugin scripts): `open.sh`/`open.mjs` keep starting their pinned launcher, which runs a newer `current` instead. So `--find`, `--last`, `--front`, `--wait` keep one launcher and a 1.6.0 plugin script needs no change.
- Only plain `x.y.z` versions are compared; pre-releases and checkout `git describe` always run themselves.

### Update (author: one click, all windows)

- The notice gets **Update** and a checkbox **Update automatically**; **Later** stays.
- Click: that window's server installs into `runtime/<version>/` under a state-folder lock (one install per machine; a second click in any window joins it), then points `current` at it. Every header shows "Updating to 1.7.0…".
- Installed is always the newest release the machine has seen on npm, never a version the page names, only newer than running. npm integrity applies; the package is published with provenance.
- Then every open window restarts on the new version: its launcher hands over to the new launcher keeping the port, so the tab reconnects and the session continues (like exit 75 today). For `/nb` the Claude Code background task stays the same task.
- Handover (my call): the process the plugin/terminal started stays as a thin outer part that runs the newest launcher as a child, passes signals and exit codes, and re-runs it on a new exit code meaning "a newer version is current". The outer part changes rarely so old code there is harmless; registry entry, launch nonce and parent watch belong to the inner (current) launcher. Pre-feature launchers (<= 1.6.0) have no outer part.
- Install uses the npm beside the running Node, else `PATH`; with no npm it fails naming the cause.

### When a window restarts (author: wait for a pause)

- Only in a pause: no turn, empty composer, no question/approval waiting, no `!` command, no agent task (controller ruling R12).
- Until then the header shows **1.7.0 is ready · Restart**; a click restarts at once (page reconnects without reload, so the draft stays; drafts are not kept across a reload).
- After handover the open page still runs old code: it reloads itself in a pause with an empty composer, else **Updated to** offers **Reload** (R11).
- Same for both modes; with **Update** the clicked window usually restarts right away.
- The composer lives in the page, so the page reports whether it is empty (new client message; as built, the page itself asks for restart when idle). A window with no tab is in a pause when no turn, `!` command or task runs and nothing awaits an answer; turn/approval state comes from the session, same for every backend.

### Automatic updates (author: both modes; off by default)

- Settings → Defaults **Update automatically**, off by default; the notice checkbox sets the same setting. Per machine (all agents), stored in the state root, not provider prefs (my call).
- When on, a noticed release installs by itself; windows then restart in pauses. With the update check off, automatic is off.
- Each server looks at the shared answer every 10 min on its own (my call), so release notice/install also works with no tab open.

### After the update

- A restarted window shows once **Updated to 1.7.0** with the changelog sections between versions (as the notice reads them); a window opened later does not (my call).
- Failed install (npm, network, disk): `current` does not move; header says **Update failed** with the log path (`<state root>/runtime/update.log`); the next notice offers **Update** again.
- A new version that does not come up (no answer within 20 s, or exit within 60 s): `current` goes back for the machine and windows already on the new version go back in their next pause, so two versions never coexist long (my call). Header says rolled back with the log; the release is not auto-installed again but the button still offers it. Previous version = the one in `runtime/`, or after the first update the launcher's own.

### Installs that cannot update themselves (my call)

Source checkout: no check, no notice. Launchers <= 1.6.0 cannot hand over: the update to the first version with this feature is manual one last time: README gets one **Updating** section with a copyable command block per install kind, the reminder that an open window keeps its version until closed, and how to close one started by `/nb`.

## Left to the builder

File formats/names in the state folder (`latest`, lock, result, log); how a launcher learns `current` changed (watch, or server on exit with a new code); the handover mechanics; "came up" detection for rollback; version comparison in open.sh/open.mjs; notice/header layout within `UpdateNotice`; tests at least: unit (shared check, lock), launcher handover and rollback on ports 4790–4795 with temp `NOTA_BENE_HOME` and a fake registry (no network), e2e of notice states.

## Delivery

One issue and PR unless the builder finds a seam (shared check and notice first, runtime and handover second), each merged through its own PR. The release CHANGELOG says how to make the last manual update.
