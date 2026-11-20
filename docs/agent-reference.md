# Nota Bene: agent reference

Rules and procedures for agents working on this repository. What the product does is in the
[guide](guide.md), how it is built in the [architecture](architecture.md). Route lists, limits and
timeouts live in the code and its tests; this file names them only where a rule depends on them.

## Rebuild (root)

Node >= 23.6 runs the server's `.ts` directly. From the repo root:

- `npm run dev`: the server on 4780 (`node --watch`, `--allow-origin http://localhost:5173`) and Vite on 5173.
  Its state is `~/.nota-bene-dev` (`NOTA_BENE_HOME` overrides), so experiments never touch `~/.nota-bene`.
  `npm run dev:open` opens it logged in.
- `npm start [-- <dir> --port N --resume ID --continue]`: builds `web/dist` and serves it unsupervised (port 4777).
- `npm test` (Vitest, random ports; every project sets a fixed default provider and clears inherited supervision
  flags), `npx tsc -b`, `npm run build -w web`.
- `npm run e2e` (Playwright, 4791-4795; `ffmpeg` on PATH makes the media fixtures, else those tests are skipped,
  `NB_E2E_FFMPEG=0` forces that), `npm run e2e:codex`, `npm run e2e:omp` (a scripted ACP agent). They share ports:
  run them one at a time.
- `node scripts/build-package.mjs [--out DIR]`: the npm package in `pkg/` (git-ignored; never publishes). esbuild
  bundles the server, the launcher and the Whisper host (`host.js`) to JS at the sources' depth, with a fresh
  `web/dist`. Installed, there is no `web/src` or `.git`: the launcher never builds, `/info.codeChanged` is false and
  state lives only in `NOTA_BENE_HOME`. Test: `bin/package.test.ts`.

Ports: windows 4777-4799 except 4780 and 4790-4795; dev 4780 and 5173; tests only 4790-4795 (manual smoke 4790).
`/info.root` tells windows apart.

**Checkout command.** `ln -s "$PWD/bin/nota-bene-dev.mjs" ~/.local/bin/nota-bene-dev` (Windows: a `nota-bene-dev.cmd`
shim holding `@node "<checkout>\bin\nota-bene-dev.mjs" %*`). It is the ordinary launcher of this checkout with every
argument, state in `~/.nota-bene-dev` (`NOTA_BENE_DEV_HOME` overrides; an inherited `NOTA_BENE_HOME` is ignored). It
follows the checkout's branch and is not shipped.

**Launcher** (`bin/nota-bene.mjs [dir] [--port N] [--resume ID [--fork]] [--new] [--detach] [--no-open]`). It rebuilds a
stale `web/dist` at launch and before a restart, opens the browser and supervises the server. One window per folder:
a launch takes the folder's lock and gives way to a window already serving it (up to 10 s for one in its restart gap).
Exit codes: 75 relaunches at once with `--continue`; 77 hands over to a newer version ([In-app update](#in-app-update));
0, 130, 143 stop; 98 on a relaunch gives up; anything else is a crash, relaunched after 1 s, giving up after 5 crashes
in 60 s. A relaunch keeps the port and the registry entry. The server is spawned with an IPC channel and stops when
it closes, so a killed launcher leaves no orphan; the channel also carries `nota-bene:stop`, the Windows stand-in for
SIGTERM. A foreground launcher stops when its parent shell is gone. `--detach` prints one line (`opened URL` or
`already-open URL`) and logs to `$TMPDIR/nota-bene-PORT.log`.
Helpers: `--find DIR [--scan]` (the port of the live window, exit 1 if none), `--last DIR` (its last session id),
`--url PORT` (the login URL), `--front PORT` (bring to front, logged in).

**`/nb` skill** (`plugin/skills/nb/`). A checkout links it with `ln -sfn "$PWD/plugin/skills/nb" ~/.claude/skills/nb`; on Windows, in `cmd`, a junction needs no admin rights or Developer Mode: `mklink /J "%USERPROFILE%\.claude\skills\nb" "<checkout>\plugin\skills\nb"`.
`open.mjs --plan` prints `NB-RUN` / `NB-WAIT` / `NB-NAME` and launches nothing; the skill runs `NB-RUN` as a Claude Code
background task (its output is the window's log; ending the task or the session stops the window), then
`open.mjs --wait` for the URL. Rules:

- `open.mjs` is plain Node with no imports beyond Node's own, so it runs on Windows; `plugin/` holds no `package.json`
  or lockfile (Claude Code would run npm there), and the plugin version equals the root `package.json` version (tested).
- SKILL.md passes `--data '${CLAUDE_PLUGIN_DATA}'` single-quoted: a live `${...}` makes Claude Code refuse the line.
  Plan commands are quoted by `q()`: safe words as they are, anything else single-quoted.
- The launcher is a checkout's (`bin/nota-bene.mjs` three levels above the physical skill dir) or the npm package
  `nota-bene-ide@<plugin version>` installed into `<data>/<version>/` on the first run, inside `NB-RUN`, never in the plan.
  `.nb-installed` marks a finished install, `.nb-install-failed` a failed one.
- Nothing the skill prints carries the `#t=` login: its output enters the transcript and goes to the API.
- Test: `scripts/nb-open.test.ts` (kept out of `plugin/`, which ships).

The Codex skill is `codex/skills/nb/`, the omp skill `omp/skills/nb/`.

### Windows

Native since 1.9.0. What differs from POSIX goes through `server/src/platform.ts` (the launcher imports it too) and
`shared/src/paths.ts`. Rules:

- No bare `spawn('npm' | 'npx' | 'codex' | ...)`: resolve with `resolveBin`, then `spawnSpec`; npm and npx go through
  `npmSpec` / `npxSpec` (the running Node's `npm-cli.js`, no shim). An agent CLI is spawned only through
  `server/src/agent/bin.ts`.
- No `process.kill(-pid)` (use `killTree`), no `process.kill(pid, 0)` (use `pidAlive`), no hard-coded `/` checks or `===`
  on paths (`isAbsPath`, `samePath`, `isInside`).
- Never `taskkill` a tree of MSYS processes (Git Bash and its children): it can break MSYS so that every later `bash`
  dies at start ("cmalloc would have returned NULL"). A Git Bash `!` run carries `NOTA_BENE_SHELL_RUN=<mark>` and Stop
  kills it by that mark from inside MSYS.
- Absolute paths on the wire use the slash form (`C:/Users/x/proj`, `server/src/wirePath.ts`); `/info` and the window
  registry keep the native form, so compare them with `samePath`.
- No unix sockets: the remote connector and the Whisper host listen on named pipes whose clients prove a per-home
  secret (`remote/control-secret`, `whisper-host/host-secret`). A pipe name stays held while any accepted connection to
  it is open.
- Private files: no modes or owners to check, so the profile's ACL is trusted and links are refused with `lstat` (there
  is no `O_NOFOLLOW`; never OR an undefined `fs.constants` flag in); the
  state folder must be inside `%USERPROFILE%` unless `NOTA_BENE_ALLOW_SHARED_HOME=1`. State writes go through
  `renameRetry`.
- The repo is LF on every OS. CI runs on Ubuntu only: check Windows by hand before a release.

### Tests

- Never signal a pid read from outside (`ps`, a ppid, a file) without checking it is the test's own: an orphan's parent
  is 1, and `kill(-1)` is every process of the user. `vitest.node-setup.ts` makes `process.kill` throw for -1, 0, 1 and
  the runner's own group; `killTree` refuses a pid under 2.
- Every node test file gets a state home of its own, so a test that forgets `NOTA_BENE_HOME` cannot reach `~/.nota-bene`.
- A POSIX-only test gets `it.skipIf(process.platform === 'win32')` with its reason, or a Windows variant; never weaken
  the POSIX assertion. A directory link fixture is a junction.
- A handover test's newer version is `999.999.999`, which never ships.
- `server/src/remote/*.test.ts` build and run the real relay with `go`, so `npm test` needs Go on PATH.
- `startServer` takes the test-only `insecureNoAuth` (no flag or env var sets it); tests that are not about auth pass it.
  Tests that need several sockets pass `oneTab: false`. The e2e servers are seeded with a known token and nonce
  (`e2e/serve.mjs`, `e2e/auth.ts`).

## State

The folder's layout is the guide's [State on disk](guide.md#state-on-disk). `NOTA_BENE_HOME` is the base: Claude's
state is the base itself, Codex's and omp's are `providers/codex` and `providers/omp` under it. Never in the repo.
The only write into a project is `<root>/.nota-bene/marks/` (`server/src/marks.ts`).

## In-app update

A published window (package root without `.git`) updates itself; a checkout never does. Code: `server/src/update.ts`
(the check), `runtime.ts` (the runtime store, `runtime/<x.y.z>/`, `current`, `state.json`), `updater.ts`, the
`/system/update*` routes, `web/src/shell/UpdateNotice.tsx`.

- Handover: the outer launcher runs `runtime/current`'s launcher as its child when that is a newer plain `x.y.z`, on
  the same port with the same nonce. Exit 77 means "a newer version is current: hand over"; the server exits 77 only
  with `NOTA_BENE_HANDOVER=1`, and only in a pause (the same `pauseExit` as a deferred restart, below). 77 is no crash.
- Rollback: no `/info` from the new version within 20 s, or its launcher exits uncleanly in its first 60 s. `current`
  goes back, `state.json` records `rolledBack`, and automatic updates never retry that release. A failed install is
  retried an hour later. 76 (no agent binary) is no rollback.
- Env from the launcher: `NOTA_BENE_INNER`, `NOTA_BENE_HANDOVER_NONCE`, `NOTA_BENE_HANDOVER`, `NOTA_BENE_UPDATED_FROM`.
  `NOTA_BENE_NO_UPDATE_CHECK` turns the check off. Test-only: `NOTA_BENE_TEST_PUBLISHED`,
  `NOTA_BENE_TEST_HANDOVER_INFO_MS`, `NOTA_BENE_TEST_CRASH`.
- Manual smoke on 4790: pack, install the archive into a temp prefix, put a second archive with a higher version into
  `<NOTA_BENE_HOME>/runtime/<version>/` and `current`, start the first with `--no-open`, and see `/info` answer the
  second version and `/system/update` show `updatedFrom`.

## Providers

`--agent claude|codex|omp` (Claude by default). A window stays bound to one backend; discovery, locks, secrets,
preferences, comments and archives are per provider, and the session picker lists only its own.

- Codex: `server/src/agent/codex/`. Native RPC shapes stay inside it. The marketplace `.agents/plugins/marketplace.json`
  installs `codex/plugin.json`, whose skill runs the pinned npm runtime through `npm exec`. Publishing marketplace
  metadata does not replace a published npm version. The guide's [Codex support](guide.md#codex-support) lists the gaps;
  do not infer parity from the shared UI.
- omp: the generic ACP adapter in `server/src/agent/acp/`; everything omp-specific is the `OMP` profile in `acp/omp.ts`.
  ACP frames stay in that folder, omp wording in the profile. Spawned as `omp --approval-mode <m> acp` (flags before
  `acp`); it needs `clientCapabilities.elicitation.form` (without it omp denies tool approvals) and keeps its sessions in
  its default storage (never pass `--session-dir`).

## Workflow

Every change reaches `main` the same way. There is no bypass, for admins either; force-push and deletion of `main` are
refused.

1. Open a GitHub issue.
2. Branch from `main`. Commit subjects read `gh-<issue>: <message>`.
3. Open a pull request with the same kind of title and `Closes #<issue>` in its body.
4. Wait for the required checks: `test (ubuntu-latest)` and `pr-format`. The branch must be up to date with `main`.
5. Squash merge, the only method allowed. The title becomes the commit on `main`.

There are no release branches: `main` is always the next release. A large piece of work is an epic issue whose subtasks
are checkboxes; each subtask is its own pull request titled `gh-<epic>: <message>` with `Part of #<epic>`, and the last
one closes the epic.

## Releasing

A release follows the workflow above, then publishes from a tag on `main`.

1. Open an issue for the release; its body is the version's changelog.
2. Bump the version on its branch. Root `package.json` is the source (`server/src/version.ts` reads it). Keep in sync:
   the lockfile root entries, `plugin/.claude-plugin/plugin.json`, `codex/plugin.json`, the npm pin in
   `codex/skills/nb/SKILL.md` and the README pins.
3. Move the notes under `## Unreleased` in CHANGELOG to the version's section. Update README and guide for user-visible
   changes.
4. Run types and the package, skill and launcher tests. Run browser suites one at a time when behavior changes; a
   documentation or version-only release needs focused checks.
5. Merge, wait for CI on `main`, then put an annotated tag `vX.Y.Z` on that commit and push it by name (never `--tags`:
   any tag starts `publish.yml`), straight away: the plugins on `main` pin the version, so new installs fail until npm
   has it.
6. The tag starts `.github/workflows/publish.yml`: it checks the tag against `package.json` and `main`, builds with
   `scripts/build-package.mjs`, publishes through npm trusted publishing and creates the GitHub release. Pushing the tag
   is the authorization to publish. The package name stays `nota-bene-ide`; the root stays private.
7. If the workflow cannot publish, do its steps by hand from a checkout of the tag, with
   `npm publish <archive> --access public --tag latest` after a confirmed `npm whoami`; never print credentials.
8. Verify the registry version and integrity.
9. Verify the Codex marketplace install from `main` in an isolated `CODEX_HOME`, then smoke-test the published runtime
   with the installed skill and a fake Codex backend.
10. Keep later repository-only plugin and documentation changes distinct from that archive.

Do not restart a live NB server as part of building or publishing.

## Access token

The canonical security model. Nothing on the machine reaches the API or the socket without a secret
(`server/src/auth.ts`, whose header comment lists every derived value).

- **The secret** is `<state>/token` (32 random bytes as hex, mode 600, folder 700), created on first need with an
  exclusive link so two first launches agree. **Only a missing file makes a token (the ssh rule)**: a loose mode,
  garbage, a foreign owner, a directory, a FIFO or a symlink make the server and every helper stop with a message that
  names the file and the fix. Nothing is rotated silently. The same holds for `control-token`, made at server start.
- **It never travels**: not in argv, not in the environment of the agent or of `!` commands, not in a log, `/info` or
  the startup line.
- **Derived values.** Each is HMAC(token, `nota-bene:<label>:<port>:<nonce>`): `login` (the `#t=` fragment), `cookie`,
  `key`, `helper`, and `proof` (adds a challenge). The launcher makes the nonce and passes it to every server it starts
  (`NOTA_BENE_NONCE`). **Exit 75 keeps it, so open tabs stay logged in; a crash relaunch takes a new one** and the
  launcher opens a fresh login page. A value from one launch is dead in the next; one for a port is dead on any other.
- **Login.** The launcher opens a mode-600 page in `<state>/open/` that redirects to `http://127.0.0.1:PORT/#t=<login>`,
  so the login is not in `ps`. The page drops the fragment from the address bar, POSTs `{login}` to `/auth` (the raw token
  is refused there) and gets the HttpOnly, SameSite=Strict cookie `nb_<port>` plus the **key**, kept in localStorage.
- **Two tiers.** The cookie alone opens **only `GET`/`HEAD` of `/file`, `/attach/<id>` and `/voice/<id>`** (what
  `<img>`, `<video>` and `<audio>` load; `cookieRoute`). **Every other route needs the key too, the socket included,
  and so does any route added later** (`server/src/auth.test.ts` pins every route in a table). The key travels as the
  `x-nota-bene-key` header through `apiFetch` (`web/src/net/auth.ts`) and as the `nb.<key>` WebSocket subprotocol,
  never in a URL. A helper's `Authorization: Bearer <helper>` and the raw token as a Bearer open both tiers.
- **Public:** `/`, static assets, `POST /auth` (own Origin only) and `GET /hello`. A non-GET request needs an allowlisted
  Origin **even with a Bearer**; `/ws` accepts an unset Origin only with valid auth. `/control/` uses `control-token`
  and refuses any Origin, so only a server reaches it. Compare secrets in constant time.
- **Prove before sending.** A helper first asks `GET /hello?c=<challenge>` and sends no derived value to a port until its
  listener proved it holds the token (`proveListener`, `verifiedBearer`). Every probe goes through it: `--find`, the
  launcher's checks, Settings → Windows, the project switcher, the remote connector, `--url` and `--front`.
- **What prints the login.** `--detach`'s line and `--url` carry `#t=` (the user's own terminal). The foreground
  launcher's lines, every log and everything the `/nb` skill prints do not.
- **The state folder is never served.** `/file`, `/tree`, `/complete` and every `src=` source refuse whatever really is
  inside it (`server/src/stateGuard.ts`), so a root that contains it (a session in `$HOME`) does not hand out the token.
- **Routes that reach beyond the project** stay key tier: `/tmpimage` (images in a temp folder, realpath checked, no
  listing, one 404 for every refusal) and `/os/reveal`, `/os/open` (loopback peer without `Authorization` only). The
  phone relay refuses `/control`, `/remote`, `/system/projects`, `/system/folders`, `/system/agents` and `/os`
  (`server/src/remote/device.ts` `goodPath`; [channel contract](../server/src/remote/CHANNEL.md)).
- **`/file`** serves `.html` and other text kinds as `text/plain`, everything under a CSP `sandbox`.
- **Project switcher** (`server/src/projects.ts`, `projectRoutes.ts`): a window mints another window's login itself,
  from that provider's token after `proveListener`, and returns it only in a JSON body. The `&s=<id>` hand-off after the
  login is dropped with the fragment before `/auth`.
- **Trust limit.** The token is readable by any process of the same OS user, the agent included: the aim is to keep out
  other users and software that cannot read the file. Accepted residual risk: browsers send cookies to every
  `127.0.0.1` port, so a local web server the user visits gets `nb_<port>` and can read what the cookie tier opens, until
  the next launch; it cannot open the socket or write. A token committed to git stays in its history.
- **Rotating** means deleting `<state>/token` and restarting; windows live under the old token can no longer be proved
  and must be reopened: `--find` does not see them, and a `/nb` or launch meanwhile starts a second window on the folder.
- A page without a login (a bookmark, an old tab) shows "This window is not logged in" and stops reconnecting.
- Dev: `npm run dev` has its own token; `npm run dev:open` proves both the backend and the Vite proxy before it logs in.
- Smoke on 4790: with a temp `NOTA_BENE_HOME`, log a browser in with `node bin/nota-bene.mjs --front 4790`; for the API
  use the raw token in your own shell: `curl -H "Authorization: Bearer $(cat "$NOTA_BENE_HOME/token")" http://127.0.0.1:4790/info`.

**Remote connector** (`nota-bene remote`, `server/src/remote/`). It reads each provider's `token` (never creates one),
sends the helper bearer only to a window that proved itself, and adds `Host` and, on non-GET, `Origin` to what it
proxies. Its secrets are `remote/host.key`, `devices.json` and `access-key` (mode 600, never logged; the page only learns
`accessKey: true`); its only listener is `remote/control.sock` (600; a named pipe on Windows). Every launcher window keeps
one running while a relay is saved (`keeper.ts`); a window outside the registry (dev, a test server) has no keeper and
its `/remote` answers 503. Tests use a temporary `NOTA_BENE_HOME` and an in-process connector.

## Session rules

- **One tab per window.** The first socket owns the session; a second tab can take over, and the old one gets close code
  4001. A reload of the owner within 700 ms is not a second tab.
- **Switch and ↻ are in-process**: the server closes the agent and resumes (another) session. A new session may start
  only in the current root or in a folder that already has sessions.
- **Restart.** ↻ restarts the agent, never the server, and works while it is busy. "Restart the server" (only when
  `/info.supervised`) exits 75 and the launcher resumes with `--continue`.
- **Deferred restart** (`server/src/restartGate.ts`): `POST /restart-server` exits 75 only in a pause (no turn, question,
  approval, switch, `!` run or running task); otherwise it is pending until one. A page that connected with `?pause=1`
  holds it until its own side is quiet; `{now: true}` cuts the turn. The update's 77 uses the same `pauseExit`.
- **Pending compaction** (`server/src/compactOrder.ts`, issue 499): Compact while busy waits for the same pause, after a
  pending restart. Sends of a `?held=1` socket (protocol 27) wait behind either (`send-held`, `compact-pending`) and go
  after the compaction's turn; a forced send does not wait, and `/clear` is refused meanwhile. `<state>/compact-pending/<sessionId>.json` keeps both across a restart.
- **Cut turns** (`server/src/turnMarks.ts`): while the agent works, `<state>/turns-open/<sessionId>` exists; a start that
  finds it offers **Continue**. Nothing is sent by itself.
- **`!` commands** (`server/src/session/shell.ts`, `shellText.ts`): owner socket only, one at a time, no turn of its own.
  The environment drops the launcher's variables and Claude Code's own state (`shellEnv`, tested). Each run has its own
  process group, stopped with TERM then KILL on Stop, timeout, a switch, `/clear` or server exit. Finished runs go in
  front of the next message in Claude Code's own `<bash-input>` / `<bash-stdout>` / `<bash-stderr>` form.

Smoke hygiene with a real agent: restart the server before reloading the page; use port 4790, a temp project, a temp
`NOTA_BENE_HOME` and a temp `CLAUDE_JOURNAL_VAULT` (else the agent writes into the real journal). Afterwards move the
temp projects' transcripts (`~/.claude/projects/-private-tmp-nb-*`) to the Trash.

## Audit log

When a window misbehaved (a stopped turn, a lost connection, a crash loop), read its audit log before guessing:
`<NOTA_BENE_HOME>/audit/YYYY-MM-DD.jsonl` (UTC days), one JSON object per line with `ts`, `port`, `pid`, `ev` and the
event's fields. `ev` is `server-start` (`root`, `agent`, `node`, `supervised`), `server-stop`, `server-exit` (`code`: 75
is the user's restart), `ws-open` / `ws-close` (`conn`, `code`; 4001 is a takeover), `client` (the page's message `type`;
`send` has `chars`, `force`, `comments`, `images`), `event` (`kind`; `turn-end` has `stop` and `secs`, `tool-call` has
`tool`) and `agent-system` (an SDK system message the chat does not show). A turn that ended `interrupted` was stopped
by a `client` `interrupt`, a `send` with `force`, or a `restart` just before it. Text is never logged, so quote freely.

```sh
jq -c 'select(.port == 4778)' ~/.nota-bene/audit/2026-11-03.jsonl | tail -50
jq -c 'select(.ev == "client" and .type == "interrupt")' ~/.nota-bene/audit/*.jsonl
```

## Whisper host

Dictation and voice messages run Whisper in one detached process per state folder, shared by every window of every
agent: the **Whisper host** (`server/src/dictation/`: `hostWire.ts` holds the framing, caps and deadlines, `hostMain.ts`
the host, `hostClient.ts` the window's side, `transcribe.ts` the in-process fallback `transcribeLocal`).

- **Where.** `<NOTA_BENE_HOME>/whisper-host/` (700): the socket `h<HOST_PROTO>-<sha8 of the pins>.sock` (600; another
  protocol or other pins get another name, so incompatible windows never share a host), `host.log` and `host.log.1`,
  `spawn.lock`. It is outside `whisper/` so that Remove does not delete a live socket. On Windows: the named pipe
  `\\.\pipe\nota-bene-whisper-<hash>-h<HOST_PROTO>-<pins>` and `host-secret`; find a host by its pipe name.
- **Lifetime.** It survives window stops, restarts and updates, loads the model at its first job and exits after 10
  minutes with nothing queued or running. One job runs at a time, round-robin across windows.
- **Model files.** Only the installer's load may fetch the model, by id and pinned revision. Every other load reads the
  folder by path with `env.allowRemoteModels = false`, so a load that races a Remove fails instead of downloading again.
- **Fallback.** A window uses its own model when the host is unusable (no `host.js`, a socket path too long, a host that
  keeps dying). A job that lost a host under its one retry fails instead of running in the window: the clip may be what
  killed the host.
- **Remove** (`POST /dictation/remove`): Whisper off and `ready.json` gone first, then the host asked to shut down, then
  SIGTERM to the pid that answered on that very connection (never another process or group), then `whisper/` deleted.
- **Environment.** The host gets only `PATH`, `HOME`, `TMPDIR`, `NOTA_BENE_HOME` and the test idle knob (plus the Windows
  system variables): never a token or nonce, and no TCP listener.
- **Look from a shell:** `GET /dictation` (its `host` field), `pgrep -fl hostEntry.ts` (checkout) or `pgrep -fl host.js`
  (package), `tail <NOTA_BENE_HOME>/whisper-host/host.log`.
- **Stopping it safely.** By hand, only a host of your own temporary `NOTA_BENE_HOME`: SIGTERM its pid (Windows:
  `taskkill /T /F /PID <pid>`). The host under the user's real `~/.nota-bene` serves their windows: leave it alone and
  report it. It stops itself 10 minutes after the last job.
- **Tests.** `NOTA_BENE_TEST_WHISPER_IDLE_MS` shortens the idle time. A test that needs a host sets a short home of its
  own (unix sockets in `/tmp/nbw-` folders fit `sun_path`), restores the file's home in `afterEach`, kills every process
  it started and bounds every wait. After a run, `pgrep -fl hostEntry.ts` and `pgrep -fl host.js` must show none of yours.

## You may be running inside this tool

If the project root is this directory, the chat window you are talking through is most likely served by this checkout.

- `web/` changes take effect after `npm run build -w web` and a page reload (tell the user to reload). "Restart the
  server" also rebuilds a stale `web/dist` first; a crash relaunch never builds. A failed build is logged, the old
  `web/dist` is served, and the build is not retried until a source changes. While the launcher builds, its registry
  entry carries `building`, so another launch on that folder waits instead of opening a second window.
- `server/` and `shared/` changes need a server restart: ask the user to open the ▾ menu next to "↻ Agent" and pick
  "Restart the server" (or press "Restart server · code updated"); the session resumes. **Do not kill, restart or curl
  your own window's server**: that kills your own turn.
- Before asking for the restart, run `npx tsc -b`, then start the server once on 4790 with a temp project and a temp
  `NOTA_BENE_HOME` (`node server/src/main.ts <tmpdir> --port 4790`), see it answer `/info` with the token (see
  [Access token](#access-token)), and stop it. A broken server edit crash-loops: the launcher gives up after 5 crashes
  and the user has to relaunch the window.
- A second browser tab on your own window parks behind the "already open" overlay, and "Work here" there parks the
  user's tab (4001). Check on a separate 4790 window instead.
- Tests move the web build with `NOTA_BENE_BUILD_ROOT` and `NOTA_BENE_BUILD_CMD`, so they never touch the checkout's
  `web/dist`.
