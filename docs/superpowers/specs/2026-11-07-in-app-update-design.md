# In-app update: one click, or by itself, every window

## Intent

The first user who updated Nota Bene from 1.5.0 to 1.6.0 needed more than half an hour and help in a chat. What went wrong,
in order:

1. No notice came: the window asked npm before the release and was not going to ask again for 6 hours.
2. He ran `npm i -g`, but `/nb` starts the plugin's own copy of the package (pinned to the plugin's version), so the global
   install changed nothing; a typo in the command (`nota-bene -ide@1.6.0`) passed unnoticed.
3. The Claude plugin needs two commands to update (`claude plugin marketplace update`, `claude plugin update`).
4. After the plugin update `/nb` brought the old 1.5.0 window to front: a running window keeps its code.
5. To get rid of it he had to stop "task bg… in the task list" of the Claude Code session that ran `/nb`, which he could
   find only by guessing `/tasks` and a small "x".

The goal: a window shows `↑ 1.7.0`; one click (or nothing, when the user chose automatic updates) and every open window is
running 1.7.0, in the same sessions. No commands, no tasks to stop, no windows to close.

## Goals, non-goals, anti-goals

Goals:

- A newer release is noticed within about 10 minutes, and at once when the user comes back to a window's tab.
- **Update** in the notice installs it; every open window of the machine then restarts on the new version and continues
  its session.
- **Automatic updates** (off by default) do the same without the click.
- It works the same for the Claude plugin (`/nb`), the Codex plugin and a global `npm i -g` install.
- After an update the window says once that it was updated and what changed; after a failure it says so, names the log,
  and the old version keeps working.

Non-goals: updating a source checkout (it never checks, as today); updating Claude Code, Codex or omp themselves;
downgrades and choosing a version; updates on Windows; release channels (beta).

Anti-goals: a turn cut off by an update; a draft in the composer lost by an update; a window that does not come back
after an update; the page or anything outside the user's own click/setting deciding what gets installed; asking npm more
often because more windows are open.

## Constraints

- Hosts: macOS and Linux. Node ≥ 22 for the package. The state folder (`~/.nota-bene`, `NOTA_BENE_HOME`) stays private
  (700); nothing new listens on a port.
- One package is about 330 MB installed (70 MB through the Codex plugin, which omits the Agent SDK binaries).
- Every new or changed string in all six UI languages (`LANGS`).
- Windows of Claude, Codex and omp share the state folder's root; their state dirs are `providers/<agent>` under it.
- The existing check (`server/src/update.ts`, `/system/update`, `web/src/shell/UpdateNotice.tsx`, the Settings switch and
  `NOTA_BENE_NO_UPDATE_CHECK`) stays the gate: with the check off, nothing is asked and nothing is installed.

## Decisions

### Noticing a release (the author's decision)

- npm is asked at most once per 10 minutes **per machine**, not per window: the answer (`latest`, when asked) is kept in a
  file in the state folder's root, and every window reads it from there. A window's page asks its server when it loads and
  when its tab gets focus again (as today); the server answers from the file and asks npm only when the file is older
  than 10 minutes.
- The request stays what it is today: `GET registry.npmjs.org/nota-bene-ide/latest`, no project, session or account data.

### One copy of Nota Bene per machine (my call)

- Installed releases live in `<state root>/runtime/<version>/` (an `npm install --prefix` of `nota-bene-ide@<version>`), and
  `<state root>/runtime/current` names the one in use.
- Every way of starting Nota Bene (the Claude plugin's `open.sh`, the Codex plugin's `open.mjs`, the global `nota-bene`)
  runs the newer of two: the version it carries itself (the plugin's pinned version, or the global package) and `current`.
  So updating no longer depends on updating the plugin; a plugin update still works and simply brings its own version.
- The Claude plugin's existing per-version installs (under the plugin's data folder) and the Codex plugin's npm cache keep
  working for their own version; nothing is migrated. The first in-app update creates `runtime/`.
- Disk: `runtime/` keeps `current` and the one before it (for a fallback); older ones are removed after a successful
  update.
- One package for every agent (the author's decision): `runtime/` holds the full package (about 330 MB), and Claude,
  Codex and omp windows all run on it. A Codex user's first in-app update therefore downloads the full package once,
  instead of the 70 MB the Codex plugin takes today.
- The choice is made by the launcher when it starts (my call), not by the plugin scripts: `open.sh` and `open.mjs` keep
  starting their own pinned launcher, and that launcher, when a newer `current` exists, runs it instead.
  So `--find`, `--last`, `--front` and `--wait` keep using one launcher, and a 1.6.0 plugin script needs no change.
- Only plain `x.y.z` versions are compared; anything else (a pre-release, a checkout's `git describe`) always runs itself.

### Update (the author's decision: one click, all windows)

- The notice gets an **Update** button and, beside it, a checkbox **Update automatically**. **Later** stays.
- A click on **Update**: the server of that window installs the release into `runtime/<version>/` under a lock in the state
  folder (one install at a time for the machine; a second click, in any window, joins the running one), then points
  `current` at it. While it installs, every window's header shows "Updating to 1.7.0…".
- What gets installed is always the newest release the machine has seen on npm, never a version the page names, and only
  newer than the running one. npm's own integrity check applies; the package is published with provenance.
- Then **every** open window restarts on the new version: its launcher hands over to the new version's launcher, keeping
  the port, so the open tab reconnects by itself and the window continues its session (like the restart that exit 75 does
  today). For `/nb` the Claude Code background task stays the same task: nobody has to stop it.
- How the handover works (my call): the process the plugin or the terminal started stays alive as a thin outer part whose
  only job is to run the newest launcher as a child, pass signals and exit codes through, and run it again
  when it exits with a new exit code meaning "a newer version is current". The outer part is small and changes rarely, so
  old code staying in it is harmless; the window's registry entry, launch nonce and parent watch belong to the inner
  launcher, which is always the current version. A pre-feature launcher (1.6.0 and before) has no outer part: see below.
- The server installs with the npm that sits beside the Node running it, else the one on `PATH`; with no npm the install
  fails as below, naming the cause.

### When a window restarts (the author's decision: wait for a pause)

- A window restarts only in a pause: no turn running, nothing in the composer, no question or approval waiting.
- Until then its header shows **1.7.0 is ready · Restart**; a click restarts it at once (the user's choice, draft or not:
  drafts already survive a reload).
- This holds for both modes; with **Update** the clicked window usually restarts right away, because the user is in a pause
  when they click.
- The composer's state lives in the page, so the page tells its server whether the composer is empty (a new client
  message; my call). A window with no tab connected is in a pause when no turn runs and nothing waits for an answer: its
  drafts are kept in the browser and come back after the reload. Turn and approval state come from the session, the same
  for every backend.

### Automatic updates (the author's decision: both modes; off by default)

- A setting in Settings → Defaults, **Update automatically**, off by default; the checkbox in the notice sets the same
  setting. It is per machine (all agents), like the update itself, so it lives in a file in the state folder's root, not
  in a provider's prefs (my call).
- When it is on and a newer release is noticed, the install starts by itself; then the windows restart in their pauses,
  as above. With the update check off, the automatic update is off too.
- Each window's server looks at the shared answer every 10 minutes on its own (my call), so a release is noticed, and
  installed when automatic, also with no tab open.

### After the update

- Each window that was restarted by the update shows once **Updated to 1.7.0** with what changed (the changelog sections
  between the old and the new version, as the notice already reads them); a window opened later does not (my call).
- An install that fails (npm, network, disk): `current` does not move; the header says **Update failed** with the log path
  (`<state root>/runtime/update.log`); the next notice offers **Update** again.
- A new version that does not come up in a window (its server does not answer within 20 s, or exits within its first
  60 s): `current` goes back for the machine, and every window already on the new version goes back too in its next
  pause, so the machine never runs two versions for long (my call). The header says the update was rolled back, with the
  log. The release is not installed again automatically; the button still offers it. The previous version is the one
  in `runtime/`, or, after the first update, the launcher's own version.

### Installs that cannot update themselves (my call)

- A source checkout: no check, no notice (as today).
- A window whose launcher is older than this feature (1.6.0 and before) cannot hand over. The update from 1.6.0 to the
  first version with this feature is manual, one last time: the README gets one **Updating** section with the commands for
  each kind of install, the reminder that an open window keeps running its version until it is closed, and how to close
  one started by `/nb`. Its commands are one copyable block per install kind.

## Left to the builder

The file formats and names in the state folder (the `latest` file, the lock, the result and log); how a launcher learns
that `current` changed (a watch, or the server telling it on exit with a new code); the handover between the old and the
new launcher; how a window detects "came up" for the rollback; how open.sh and open.mjs compare versions; the exact layout
of the notice and the header states within the existing UpdateNotice; the test strategy, with at least: unit tests of the
shared check and the lock, a launcher test of the handover and the rollback on test ports 4790–4795 with a temporary
`NOTA_BENE_HOME` and a fake registry (no network), and an e2e of the notice's states.

## Delivery

One issue and one PR, unless the builder finds a seam (for example the shared check and the notice first, the runtime and
the handover second); each part is merged through its own PR under the usual rules. The CHANGELOG of the release says how
to make the last manual update.
