# Changelog

## Unreleased

- **Relay access keys.** A relay can now admit only invited people: its operator issues each person an access key (`nb-relay invite`), every connection of their computer is signed with it, one key works on up to 3 computers at once (`nb-relay limit` changes it), and `nb-relay revoke` cuts that person's computers off within seconds. Enter the key in the Remote tab or with `nota-bene remote key`; the tab says when the key is missing, revoked or in use on too many computers. A relay started without `-members` stays open as before. See [Access key](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md#access-key).
- **Remote access and Usage moved into the settings menu.** The header's phone and bars buttons are now rows of the gear's menu; the gear shows the remote access state as a dot (green online, amber connecting, red not working).
- **Remote access from the window.** While a relay is saved, the first window starts the connector in the background and the others share it, so the phone keeps its access while any window is open, without `nota-bene remote` in a terminal. A phone icon in the header shows the state (connecting, online with the number of phones, or why it does not work), and its **Remote** tab sets the relay, turns access on and off, pairs a phone with a QR code and revokes one. The terminal commands still work. A paired phone cannot use these actions. See [Remote access](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md#remote-access).
- **Long paths fit in a comment card.** A comment on a file with a long path no longer makes its card wider than the comments panel: the path wraps, and the edit and delete buttons stay in reach.
- **Comments no longer vanish between windows.** A comment change is sent as that change alone, from the web and the phone, so a window that has not seen a new comment can no longer delete it, and a comment deleted in one window does not come back from another. Changes made offline go once the window reconnects; on the phone they are kept even when the app is closed. When another window changed or deleted the comment first, your change is dropped and a message says so.
- **Stop spares background agents (Claude).** Stopping the turn no longer ends the subagents running in the background; they go on and stop from the Tasks drawer, one by one or with **Stop all**. Background shell tasks already went on.
- **A sound when a tab needs you.** A tab you are not looking at plays a short sound when the agent waits for you: a permission, a plan to approve, a question. Settings → Defaults → **Sounds** turns it off, or adds a sound when a turn ends; the choice is shared by every window. Only one tab of a window sounds, and a reload or reconnect never does.
- **Clearer header buttons.** The Sessions button says **Sessions** next to its clock, and it is the same height, corners and type as ↻ Agent beside it. The ↻ Agent button's menu half lines up again: both halves are one height, so the seam between them no longer looks broken.
- **Switch the folder's branch.** A local branch in the header's branch menu has a **Switch** button: after an inline confirmation the project folder moves to that branch, carrying uncommitted changes that do not conflict. It is refused, with the reason, while an agent works in the folder or when git refuses; the tree, Changes, the log and open tabs then show the new branch.

## 1.10.0 — 2026-11-13

- **Parallel agents under one row.** Agents that one reply starts together (Claude Code or Codex) are listed under an umbrella row in the tasks drawer, with their combined state (done, failed), tokens and time and a **Stop all**. A Claude Code workflow shows its name and lists its agents under it.
- **A tidier Sessions menu.** Folder groups show their session count and open or close; only the current project starts open, the menu remembers the rest, and a filter opens every group with a match. A session can be archived: hidden from the list by Nota Bene alone (the agent's files stay), listed under **Show archive (N)** with **Restore**. Claude Code and Codex sessions can also be deleted for good, after a confirmation; omp sessions cannot. The open session can be neither archived nor deleted. After `/clear`, the "context cleared" line offers **Archive previous session**.

## 1.9.0 — 2026-11-13

- **Windows support, native (no WSL or Docker).** `nota-bene`, `npx nota-bene-ide`, the Claude Code plugin's `/nb`, the Codex plugin and the omp skill run on Windows. It needs Node.js 22 or newer; Git for Windows is recommended (without its Git Bash, Claude Code runs shell commands in PowerShell and the first message says so). See [Windows](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md#windows) in the guide. 3D models are not supported on Windows yet.
- **`!` commands on Windows** run in the shell of Settings → Defaults → **Shell for ! commands**: Auto (Git Bash, else PowerShell 7, else Windows PowerShell 5.1), Git Bash, PowerShell 7, Windows PowerShell or cmd. A chosen shell that is not installed refuses the run and says so; the first line of the output names the shell. Stop and the 10-minute limit end the command at once, background jobs of a Git Bash command included, and console output in the OEM code page is decoded. macOS and Linux keep `$SHELL -lc`. The Stop tooltip no longer names TERM and KILL.
- **The state folder on Windows.** The token and the other private files are kept private by the user profile's access rights, so they are not checked for mode or owner there; a symbolic link or a junction in their place is still refused. A state folder outside `%USERPROFILE%` is refused, since other users of the computer can read it by default; `NOTA_BENE_ALLOW_SHARED_HOME=1` allows one whose access rights you restricted by hand. On file systems without hard links (FAT, exFAT, some network shares) the token is created without one, on every OS. State and project files are replaced with a short retry when antivirus or the indexer holds them.
- **Launcher on Windows.** The server watches its launcher through an IPC channel instead of the parent pid, and stops with a message instead of a signal; Ctrl+C or closing the terminal stops a window, and a killed launcher takes its server along. Process trees are cleaned up with `taskkill`. The browser opens through `start`, and the launcher refuses a drive or share root as the project. The in-app update and the `web/dist` build run npm through the running Node's `npm-cli.js` on Windows.
- **Agents on Windows.** Codex and omp are found on `PATH` through their `.exe` or `.cmd` names, and an npm install of Codex starts its bundled `codex.exe`; their process trees are cleaned up when the window closes. Session folders compare without regard to letter case, and the Usage tab leaves out sessions in `%TEMP%`.
- **Remote control and voice messages on Windows.** `nota-bene remote` and the shared Whisper process listen on named pipes, and their clients prove a per-state-folder secret (`remote/control-secret`, `whisper-host/host-secret`). Voice messages on Windows now use the one shared Whisper process, as on macOS and Linux, instead of loading the model in every window.
- **Paths on Windows.** Paths show as `C:/Users/...`; a reply's `src\a.ts` opens the same file as `src/a.ts` when the server runs on Windows, and `C:\` paths of temp images open as tabs. A project at a drive root (`D:\`) serves its files, `@`-completion hits with backslashes are normalised, and shortcut tips show Ctrl+Enter and Ctrl+V off a Mac. The session picker, Settings → Windows and the header handle Windows paths.
- **The `/nb` skill helper is a Node script** (`open.mjs` instead of `open.sh`), so it runs on Windows. The Codex and omp skills start the launcher behind npm's `nota-bene.cmd` with Node. To link the omp skill on Windows, use a junction (see the README).
- The in-app updater revalidates npm metadata before installing a release, so a cached version list from before publication does not cause a spurious "No matching version found" failure.

## 1.8.1 — 2026-11-12

- Context and plan-limit meters use the same order in Claude and Codex windows: context, 5-hour limit, weekly limit. Codex's weekly window uses the same label and tooltip as Claude's.
- A local checkout can be opened with `nota-bene-dev`, using the normal launcher's options and automatic UI build, with its state in `~/.nota-bene-dev`. See the [development setup](docs/agent-reference.md#rebuild-root); this command is installed from the checkout and is not part of the npm package.
- Restart and timer characterization tests no longer race session shutdown or leave fake timers behind.

## 1.8.0 — 2026-11-12

- **Remote control from an Android phone (a prototype).** `nota-bene remote` connects this computer to a relay, a small stateless program you run yourself (source and container recipe in `relay/`), and a paired phone reaches your windows through it. The computer and the phone both connect out, nothing on the computer accepts connections, and everything between them is end-to-end encrypted: the relay sees only ciphertext and which phone talks to which host. Pair with the QR code of `nota-bene remote pair` and compare the two fingerprints; `remote devices` lists the paired phones and `remote revoke` cuts one off at once. A paired phone is fully trusted: it can do in a window what a tab of that window can. The app is an APK built by a manual run of the repository's Mobile workflow; see [Remote access](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md#remote-access-prototype).
- **Phone: chat and sessions.** The window's conversation as on the desktop: Markdown, highlighted code, formulas and Mermaid diagrams, tool calls folded into "N actions" lines, permission sheets and question cards, Send (after the turn, or now), Stop, Compact, Clear, model, effort and mode. The session list shows each window's state, last message and unread count, with pull to refresh and host names you can rename; a project icon set from the phone shows on every phone. The app opens only after the phone's own unlock check (fingerprint, face, or the screen lock's PIN or pattern), and has the six themes, a language, and text and interface sizes.
- **Phone: files and comments.** A chat is three panes: Files, Chat and Comments. Files has the session's files and the project tree, any text file read-only, and Changes and Log with diffs in a git repository; the app also shows usage statistics. Comment on a paragraph of a reply (tap it, pick a quick label or write one), on a selection in Markdown, code or a diff, and on an image or a video frame with markup. Comments gather in the Comments pane and go as one batch, as on the desktop. Images zoom with a pinch, and the attach sheet offers your recent photos.
- **Voice messages, on the web and the phone.** With Whisper installed and on (Settings → Voice messages: off by default, a one-time download of about 430 MB, after which transcription needs no network), the microphone sits in the message field, as in a messenger, while there is no text to send. On the web click it (Alt+R) to record, or hold it and let go to send; on the phone hold it, slide left to cancel and up to lock. The computer transcribes the recording and the agent gets only the text; the message shows a play button, the wave and the transcript. Comments take voice clips too, and a recording carries the pending comments with it. Up to 10 minutes.
- **Spoken language.** Whisper recognises the language of each recording by itself (the default) and falls back to the interface language when unsure; pin one of the six languages instead in Settings → Voice messages (Settings → Voice language on the phone). A small badge with the language code marks a voice message recognised in another language than yours.
- **One Whisper process for every window.** The speech model (about 0.5–1 GB of memory) runs in one background process that all windows of this computer share: it loads at the first recording and unloads after 10 minutes without one. **Remove Whisper** stops it. A window that cannot reach it runs the model itself.
- **Prompt history.** On the web, ↑ and ↓ in the message field bring back what you sent in the conversation (messages, `!` commands, voice transcripts); with text typed, ↑ searches the prompts that contain it, Alt+↑ / Alt+↓ walk the history whatever the draft is, and the clock button (Alt+H) opens a searchable list. The history survives `/clear`, a fork, a restart and a reload.
- **A new message field.** On the web, the history button and the microphone sit inside the field; Send is always there, with a badge counting the pending comments it carries, and the field shows no scrollbar until it reaches its maximum height. The comment popup uses the same field and can be dragged by its header.
- **Comments on an image you attach.** On the web, a pen on a thumbnail in the draft opens the image for markup and a comment; the agent gets the marked image and the note with the message.
- **Questions as cards.** The questions Claude asks (AskUserQuestion) show as a card on the web and the phone, as Codex's and omp's already did: the options as radio buttons or checkboxes with their descriptions, and a free-text answer.
- **Model and effort.** Effort is a stepped slider in the model menu (Auto, then one stop per level the model has) instead of wrapping chips, and the header pill is shorter: the model's short name, a `1M` tag for the 1M-context variant and a tiny effort bar. The Tasks drawer shows a subagent's model.
- Themes are listed dark first, then light, in Settings and in the header menu. Nota Bene is described as an agentic development environment (ADE) in the README and in the plugin and package descriptions.
- The plan limits stay shown when an answer comes without them, until their reset time, and the session's cost shows beside them.
- In a Claude window, after a reload your messages no longer carry the agent harness's own notes (`<system-reminder>`, `<task-notification>`).
- The model pill finds a session model with a context suffix such as `[1m]` and keeps its effort row; changing the effort no longer switches the model.
- `/nb` runs that wait on a lock left by an interrupted first install no longer install the package twice, and **Restart the server** of a source checkout rebuilds a stale `web/dist` first.
- `nota-bene remote` is a command now: open a project folder named `remote` with `nota-bene ./remote`. The phone app needs Nota Bene 1.8.0 or newer on the computer, the first version with `nota-bene remote`; a newer app leaves out what an older computer cannot do.

## 1.7.1 — 2026-11-08

- **Stop window** (⏻, right of the gear in the header) stops the window you are in, its agent and its launcher, after a confirmation: no more looking for the terminal or the `/nb` task to close it. The session stays and can be resumed; the tab says the window is stopped.
- KaTeX 0.19.1 under mermaid instead of 0.18.11, which npm marks as deprecated (published with breaking changes).

## 1.7.0 — 2026-11-08

- Windows update themselves from this version on: **Update** in the header installs the newest release and restarts the window in a pause (no turn, no question, no running command), with the same session, and the open page reloads to the new version; **Update automatically** (off by default, per machine) does it for every release. A new version that does not start is rolled back. npm is asked once a minute per machine. Versions up to 1.6.0 cannot do this: make the last manual update once, see [Updating](README.md#updating).
- A turn the agent starts itself (woken by a background task, for example after feedback it waited for) shows as working: Stop works, and an update waits for it. When the agent dies, its background tasks no longer stay "running".
- `nota-bene` without `--agent`, in a terminal, finds the installed agents (Claude Code, Codex, omp) and, when there is more than one, asks which to start; Enter takes the one last used in the folder. Scripts and the `/nb`, `$nb` and `/skill:nb` skills are not asked.
- Security updates: glob 14 (development only) and KaTeX 0.18.11 under mermaid close the open Dependabot alerts.
- README: a link bar to every section, one table of the supported agents (models, what runs them, minimum version, how to open a window from each) and install steps per agent.

## 1.6.0 — 2026-11-07

- Long inline code (a path, a qualified name in a command) wraps inside the message instead of running past the window.
- The update notice shows what changed since your version: the changelog of every newer release, read from GitHub when you open it.
- Themes: Darcula, the new default, with IntelliJ's colours on millimetre paper, and Plannotator, the previous look; pick one in the gear menu or Settings → Themes. To get the old look back, choose Plannotator. Solarized Dark and three light themes join them: IntelliJ Light, GitHub Light and Solarized Light; Darcula is tuned too (lighter panels, readable footer meters). The header logo takes each theme's colours; inline code that is a colour (`#ff8980`, `rgb(…)`) shows a swatch of it.
- Sessions, ↻ Agent and Open raw are icons now; their names and keys are in the tooltips.
- Security updates: mermaid 10.9.8, DOMPurify 3.4.17 and uuid 11.1.1 (through mermaid) close Dependabot alerts on diagram and Markdown rendering. KaTeX 0.16 (low) stays until mermaid 12.
- An interface scale, 90–150 %: text and spacing grow, in every window at once. The gear in the header is now a menu with the language, the scale and All settings; Alt+= / Alt+− / Alt+0 step the scale. The globe button is gone: the language is in that menu.
- omp: a new project starts in Yolo, omp's own default, instead of Write.

## 1.5.0 — 2026-11-06

- Add omp (https://omp.sh, 18.16.0+) as a third agent, a preview: `--agent omp` speaks the Agent
  Client Protocol to `omp acp`, with streamed replies, tool rows, approval and question
  cards, sessions (list, resume, fork, rename, clear), models, effort, cost and four
  modes (Write, Ask, Plan, Yolo); a new project starts in Write. An omp skill (`/skill:nb`) opens the window from omp.
  Not available over ACP: subagent tabs, task controls, compaction events and file search.
  Contributed by [Milos Marinkovic](https://github.com/milosmns).
- An `.html` file opens as the page, with a Page / Source switch. Its text takes comments as
  in Markdown; Mark (N) comments on an element, or on an area of an SVG diagram dragged as a box.
  The agent gets the place as a path of named elements and, for an area, its viewBox
  coordinates and what it covers. The page's scripts never run.
- The player's clock and timeline show milliseconds: `1:02.345`, as comments already quote the time.
- The model menu handles long lists (a router offers dozens of models): a search field, scrolling inside the menu, groups by provider with the one in use first.
- Changes: a **Tree** checkbox shows the changed files as a folder tree that folds; the choice is remembered.
- Cmd/Ctrl+Enter asks before it interrupts a working agent; a message sent with Enter is still injected into the running turn.

## 1.4.0 — 2026-11-03

- Git in the header: a branch picker over the worktrees and branches next to your checkout, a Changes view of uncommitted work or of a whole branch, and the Git log. All read-only; a dot marks a branch whose Nota Bene window has the agent at work.
- Only the stop button stops the agent: Esc no longer interrupts a turn, wherever the focus is.
- An audit log of what happens in each window, for working out later why a turn stopped or a socket dropped: `~/.nota-bene/audit/`, one file a day, kept 14 days. System events only, never what anyone wrote. Settings → Defaults turns it off.

## 1.3.0 — 2026-11-02

- The header says when a newer version is out and how to update. Settings → Defaults turns the check off, so does `NOTA_BENE_NO_UPDATE_CHECK=1`.
- Rename a session: ✎ on its row in Sessions, for the open session or any other, or right-click the chat tab.
- The Usage tab sits on the same card as Settings and Markdown files.

## 1.2.0 — 2026-11-01

- Add a Usage tab: token accounting across every project and both agents, read from
  the local transcripts, so work outside Nota Bene counts too. Weighted totals per
  model, project, task, subagent and call, with a resettable counter.
- The Usage tab charts five-hour windows and weeks of work, lists each limit hit with
  what was spent before it, and shows tokens per 1% of the weekly limit and the tokens
  and dollars spent on extra usage.
- Edit a text file by hand: ✎ in the file's header. A change made on disk meanwhile is
  never overwritten silently, and unsaved text survives a closed tab or a reload.
- Code blocks in replies and Markdown files wrap, number their lines and have a copy
  button; a wrapped part of a line has no number of its own.
- Add interface languages: Simplified Chinese, Spanish, Brazilian Portuguese and
  German. The translations have not been reviewed by native speakers yet.

## 1.1.1 — 2026-10-31

- Refuse a Codex CLI older than 0.166.0 with a clear message instead of a native
  RPC failure on the first unsupported call.
- The Codex plugin no longer downloads the Claude Code binary: first use is about
  70 MB instead of 330 MB.
- A Claude window started from an install without the Claude Code binary stops with
  one clear message instead of crashing five times.
- Fix a race in the Claude plugin's first install: several simultaneous `/nb` runs
  facing a stale lock could install twice or wait a minute.
- Name the right agent in the login and About texts of a Codex window.
- Add continuous integration on macOS and Linux, a check that every release pin
  follows the package version, and a Codex screenshot in the README.

## 1.1.0 — 2026-10-31

- Add native Codex integration alongside Claude Code, using Codex CLI 0.166.0+
  and its existing ChatGPT or API-key login.
- Add a Codex CLI / local Desktop skill for opening, starting and forking sessions.
- Isolate windows, sessions, settings, secrets, comments and archives by provider.
- Support Codex streaming, paginated history, subagent tabs, native approvals,
  questions, model/reasoning controls, compaction and account-limit meters.
- Keep existing Claude behavior and its default launch path.
- Make unit tests independent of the invoking NB window's provider and launcher.
- Share repository instructions through AGENTS.md with a short Claude entry point.

Codex API limitations: force-background, terminal output-tail retrieval and prompt
suggestions are unavailable. Session cost is unknown for ChatGPT accounts. See the
guide for the supported workflows. ACP is not part of this release.

The repository also provides a Codex marketplace plugin for this runtime. Install
it with `codex plugin marketplace add iCubeDm/nota-bene-ide --ref main` and
`codex plugin add nota-bene@nota-bene`; its first `$nb` fetches the pinned 1.1.0
npm package. The marketplace files are distributed from GitHub separately from
the immutable npm archive.

## 1.0.0

Initial npm release with the Claude Code backend, inline review comments, file and
media viewers, session history and the Claude Code plugin.
