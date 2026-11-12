# Nota Bene guide

Nota Bene is a browser window over Claude Code, Codex or omp. Claude is the default; use `--agent codex` for Codex CLI or local Desktop, `--agent omp` for omp. This guide covers starting it, each feature with an example, the security model, where state is kept, and what to do when something goes wrong. For a short introduction see the [README](https://github.com/iCubeDm/nota-bene-ide/blob/main/README.md); for how it is built see [architecture](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/architecture.md).

Contents

- [Starting a window](#starting-a-window)
- [One window per folder, one tab per window](#one-window-per-folder-one-tab-per-window)
- [Chat](#chat)
- [Margin comments and the batch send](#margin-comments-and-the-batch-send)
- [The @ picker and the / menu](#the--picker-and-the--menu)
- [Shell commands with !](#shell-commands-with-)
- [Files, branches and worktrees](#files-branches-and-worktrees)
- [Images and video](#images-and-video)
- [Subagents and background tasks](#subagents-and-background-tasks)
- [Sessions and history](#sessions-and-history)
- [Permission modes, settings, languages](#permission-modes-settings-languages)
- [Hotkeys](#hotkeys)
- [Security](#security)
- [Remote access (prototype)](#remote-access-prototype)
- [State on disk](#state-on-disk)
- [Troubleshooting](#troubleshooting)

## Starting a window

### From Claude Code: `/nb`

With the plugin installed (see the README), type in any Claude Code session:

| Command | What it does |
|---|---|
| `/nb` | Opens the window for the current folder and resumes the folder's last session, or starts one. |
| `/nb new` | Opens the window on a fresh session. |
| `/nb fork` | Continues the current Claude Code conversation in the browser as a separate branch. Messages sent here and there no longer see each other. |

The window runs as a background task of that Claude Code session. It shows in the task list, its output is the window's log, and it stops when you stop the task, end the session, or press **Stop window** (⏻) in the window. The first `/nb` after installing or updating the plugin installs the npm package into the plugin's data folder (about 330 MB per plugin version) and takes a few minutes.

If a window for the folder is already open, `/nb` brings it to the front instead of starting another.

### From a terminal: `nota-bene`

```sh
nota-bene [dir] [options]
npx nota-bene-ide [dir] [options]
```

`dir` is the project folder and defaults to the current one. The launcher refuses your home folder and `/`: it asks you to `cd` into a project first.

| Option | Meaning |
|---|---|
| `--agent claude\|codex\|omp` | Select the agent for this window. Without it, see [Which agent](#which-agent) below. Sessions and state are separate per provider. |
| `--port N` | Listen on port N. Without it the launcher takes the first free port from 4777 to 4799, skipping 4780 and 4790 to 4795. |
| `--resume ID` | Open the session with this id instead of the folder's last one. |
| `--resume ID --fork` | Open that session as a new branch; the original stays as it is. `--fork` needs `--resume`. |
| `--new` | Start a fresh session. Cannot be combined with `--resume`. |
| `--detach` | Start the window on its own and return after printing one line, `opened URL` or `already-open URL`. The log is `$TMPDIR/nota-bene-PORT.log`. |
| `--no-open` | Do not open the browser. |
| `--url PORT` | Print the login URL of the window on PORT. Use it to log in a second browser. For a Codex or omp window add `--agent codex` or `--agent omp`. |
| `--front PORT` | Bring the window on PORT to the front in the browser, logged in. For a Codex or omp window add `--agent codex` or `--agent omp`. |

Without `--detach` the launcher stays in the foreground; Ctrl-C stops the server and closes the window. The first line it prints after any build is `Nota Bene: URL  project: DIR`.

Helpers that the `/nb` skill uses, handy in scripts: `nota-bene --find DIR [--scan]` prints the port of the live window serving DIR (exit 1 if there is none), `nota-bene --last DIR` prints DIR's last session id if its transcript still exists, `nota-bene --version`, `nota-bene --help`.

Example: open a project without a browser and get the login URL for a different one.

```sh
nota-bene ~/work/app --port 4800 --no-open
# in another terminal
nota-bene --url 4800
# http://127.0.0.1:4800/#t=...
```

The launcher supervises the server. When you pick "Restart the server" in the window, it relaunches the server at once and the session resumes. If the web sources changed since the last build, the launcher rebuilds the page first, so the restart takes as long as the build and then shows the new UI (building by hand first is optional). A failed build is logged, the old page is kept and the build is not retried until a source changes. A crash is relaunched after one second without a build; five crashes within a minute and it gives up.

### Which agent

Without `--agent`, in a terminal, the launcher looks for the agents that can start: Claude Code (`claude` on `PATH` or its config folder), Codex CLI 0.166.0 or newer and omp 18.16.0 or newer (by running `--version`; `NOTA_BENE_CODEX` and `NOTA_BENE_OMP` name other executables). It never reads their login files. With one found, that one starts. With more, it asks:

```text
Which agent for this folder?
  1) Claude Code 2.1.319
  2) Codex 0.166.0  (last used here)
Agent [2]:
```

Enter takes the agent last opened on the folder (else Claude); a number or a name picks another; Ctrl+C or Ctrl+D cancels. An agent below its minimum version is listed with the reason and not offered. Without a terminal (a script, `/nb`, `$nb`, `/skill:nb`) nothing is asked: Claude starts unless `--agent` says otherwise, and the skills always pass it. The folder's last agent is kept in `agent-choice.json` in the state folder.

## One window per folder, one tab per window

A folder has at most one window per provider. Claude, Codex and omp can each have a window on the same folder. Launching again on a folder that is already open (with `/nb` or `nota-bene`) does not start a second server for that provider: it brings the existing window to the front. If the window is in the middle of a restart, the launch waits up to 10 seconds for it.

A window also has one owner tab. Open the same address in a second browser tab and that tab shows "The window is already open in another tab". Press **Work here** to take the window over: the first tab then shows "Open in another tab" and stops. A reload of the owner tab within a moment is not counted as a second tab.

## Chat

The chat is the first tab and cannot be closed. Type a message and press Enter to send, Shift+Enter for a new line.

- A message sent while the agent is working is injected into the running turn.
- Cmd/Ctrl+Enter interrupts the agent and sends, but while the agent works it asks first: a bar above the field says the agent will be interrupted. A second Cmd/Ctrl+Enter or **Interrupt and send** confirms; Esc or **Cancel** takes it back; plain Enter adds the message to the running turn instead. When the agent is idle, Cmd/Ctrl+Enter just sends.
- The stop button stops the agent; Esc does not, so a stray Esc never ends a turn.
- Shift+Tab in the message field cycles the permission mode (see below).
- Tool calls appear as lines such as `Read` or `Bash` with their argument. Click one to see the full input and output; errors are red.
- A permission request shows as a card with **Allow** and **Deny**. In plan mode, the plan appears as a card: **Approve** continues in the previous mode, **Keep planning** stays in plan mode.
- A question from the agent (Claude's AskUserQuestion, or a Codex or omp question) is a card too: its header, each question with its options and their descriptions (radio buttons, or checkboxes when several may be picked) and a free-text answer. **Send** answers, **Cancel** declines. The phone shows the same card.
- Mermaid and SVG blocks in replies render as diagrams. The **Open diagram** button opens one full size in its own tab.
- The bar under the message box shows the context size, the 5-hour and weekly plan limits, and the session's API cost (on a plan, what the session would cost at API prices). An answer that comes without plan limits keeps the last known ones until their reset time. The compact and clear buttons by the message box run `/compact` and `/clear`.
- An idle conversation is compacted for you 50 minutes after the last turn, if the window saw no activity for 15 minutes and the context is at least 200,000 tokens, so the prompt cache is not wasted. Click the idle-compaction indicator to turn it off for the project, or set `"idleCompaction": false` in `~/.claude/settings.json`.

### Voice messages

With Whisper installed and on (Settings, Voice messages), the microphone sits inside the right edge of the message field, as in a messenger, while the field has no text: it goes when you type and comes back when the field is emptied. An attached image alone does not hide it, since a recording never carries the draft or its images. **Send** stays right of the field: it is off while there is nothing to send (no text, no image, no pending comment) and its badge counts the pending comments it will carry. Pending comments do not count as text: with them and an empty field the microphone stays, and a recording takes them along. Without Whisper the microphone opens that settings section. A server older than this feature shows no microphone.

- **Click** the microphone (or press Alt+R): a recording starts and takes the place of the field: a blinking dot, the time, the live level and the buttons **Cancel** (Esc), **Stop** and **Send** (Enter, or Alt+R again). **Stop** keeps the recording for you to listen to; then **Send**, or the trash button to delete it.
- **Press and hold** the microphone for more than 0.3 s: it records while you hold and sends when you let go.
- A voice message is a message of its own: the draft in the field and its images stay where they are and do not go with it. The pending comments do go with it, after the transcript; they are taken when the recording has been uploaded and leaves, so comments added or sent while it uploads are handled as they stand then (with a server that is new enough; an older one gets the recording alone and the comments stay pending); the phone does the same. To send comments alone use **Send** in the Comments panel (Enter in the empty field does too). While the agent works it waits for its turn, like a message sent "after". The recording stops by itself after 10 minutes and is sent.
- The recording is made in the browser as 16 kHz mono 16-bit audio (about 1.9 MB a minute) and handed to this computer, which stores it beside the pasted images (`attachments/<sha256>.wav`), transcribes it with Whisper and gives the agent only the text. The agent never hears the audio.
- In the chat a voice message shows a play button, the wave (click or drag it to seek), the length, and the transcript under it. **Aa** folds the transcript. While the text is not in, the bubble says "Transcribing…". If it fails, it says why (Whisper off, nothing recognised, failed) and **Retry** sends the same recording again as a new message. Only one voice plays at a time. When the recognised language is not the interface language, a small badge with its code (for example FR) sits beside **Aa**; hover it for the language name.
- A denied microphone is reported in the status line under the message field: allow it for the page in the browser.
- Settings, Storage, **Clean unreferenced files** covers recordings as it covers images: a recording that no message or comment uses and that is over a day old goes to the trash, and is restored when something asks for it.

## Margin comments and the batch send

This is the core of the tool: review first, then send everything at once.

**Example.** The agent replies with a plan and two paragraphs of code explanation.

1. Select the phrase "retry three times" in the reply. A **Comment** button appears next to the selection. Click it.
2. In the popup type `make this configurable` and press Cmd/Ctrl+Enter. The fragment turns yellow and a card appears in the **Comments** panel. Esc cancels the popup.
3. Select a line in a second reply, and instead of typing, click a quick label such as **Verify this**. One click adds the comment with no typing.
4. Open `src/queue.ts` from the **Files** panel, select a function and comment on it too.
5. Comments alone are sent from **Send (3)** in the Comments panel, or from **Send** in the composer while its field is empty (its badge says 3). Type a message of your own and the same **Send** sends it with the comments. Press **Send**.

The agent receives one message that starts with "Comments on fragments:" and lists each fragment with its source (a chat reply, a file, a tool command) next to your note. Comments sent are shown dimmed and tagged "sent".

Details:

- You can comment on agent replies, on your own messages, on tool lines, on subagent replies (the comment goes to the main session), and on any open file.
- The quick labels are Looks good, Love it!, Clarify this, Verify this, Give me an example, Missing overview, Match existing patterns, Consider alternatives, Ensure no regression, Out of scope and Needs tests. Most carry a short instruction for the agent that is sent with the batch.
- Comment text takes emoji from the emoji menu or by typing a shortcode such as `:+1:`. The `@` picker works in the comment popup too.
- Click a highlighted fragment to open its card in a popup; edit or delete it there or in the panel. Both the new-comment popup and an opened card can be dragged by their header line out of the way; a new selection or another card puts it back at its anchor. The panel's cards jump to the source. Tabs and tree rows show a count badge.
- Comments are stored per session and survive reloads and resumes. If the text a comment was made on has changed, the card is marked "fragment changed" and kept; for a file that changed since, "the file has changed since".
- The Comments panel opens with Cmd/Ctrl+Shift+C.
- **Voice clips.** With Whisper on, the comment popup has the same field as the message box: a microphone while the field is empty that turns into **Add** once you type or attach an image. Click the microphone to record, click **Stop** to add the clip under the text (Esc while recording drops the recording, not the comment). Each clip shows a play button, its wave and its transcript; delete one with the cross, record again for more (up to 10). **Add** waits until every clip is transcribed; a clip that failed needs **Retry** or deletion. A comment can be clips only: with clips (or a drawing) and an empty field the microphone stays in the field, so more clips can be recorded, and **Add** sits in the row below it. The agent gets the clips' transcripts, each on its own line, after what you typed. Cards and the sent comments under a message show the clips with play and transcript.
- `/clear` would drop pending comments, so the window refuses it until they are sent or removed.

## The @ picker and the / menu

### `@` picker

Type `@` at the start of a word in the message box (or in a comment popup) to search the project's files. Matching is fuzzy: `@qcfg` finds `src/queue/config.ts`. Arrow keys move, Enter or Tab inserts, Esc closes. Choosing a folder keeps the picker open inside it. A path with spaces is inserted in quotes. Paths in sent messages are clickable and open as tabs.

In a `!` shell command the same picker inserts the plain path, quoted as a shell word, rather than an `@` mention.

Alt+E opens a list of recent files with a project-wide file-name search.

### Prompt history

The message field remembers what you sent in this conversation: typed messages, `!` commands and voice transcripts (not comment-only sends or the compact and clear buttons). The history survives `/clear`, a fork, a restart and a reload.

- **↑** in an empty field brings back the last prompt, **↑** again an older one, **↓** a newer one; **↓** past the newest empties the field again. With a single-line draft typed, **↑** searches instead, like Ctrl+R or history-substring-search: it walks back through the prompts that contain the typed text (any case, newest first), **↓** walks forward, and **↓** past the newest puts exactly what you typed back, so the draft is never lost. The search keeps the text you typed, not the recalled one; editing a recalled prompt ends the walk and the edited text is a new search. With no match **↑** does nothing, and a multi-line draft keeps the field's own arrows. In a multi-line recalled prompt the plain arrows first move the caret and step through the history only from the first or last line. **Alt+↑** / **Alt+↓** (**Option** on a Mac) always walk the history, older and newer, whatever the draft is: a multi-line prompt you recalled, or a draft you typed, which is kept and comes back with **Alt+↓** past the newest. While a `/` or `@` list is open it keeps the arrows, Alt included. Editing the recalled text ends the walk. Images are not recalled. A recalled `/command` does not open the `/` menu; in a draft you type, the `/` menu and `@` mentions keep the arrows.
- The clock button left of the message field (Alt+H) opens a searchable list, newest first, with the time and a microphone mark on voice messages. Typing shows the prompts that contain it, then looser matches. Enter or a click puts the prompt in the field; it is never sent from there, and the draft it replaced comes back with **↓** (as long as you do not edit the prompt).

### `/` menu

Type `/` as the first character of a message. A menu lists the agent's commands and skills, filtered as you type. Enter or Tab picks one; it writes `/name ` and leaves the caret after it. Esc closes the menu for that word.

What is in it:

- Every command and skill of the session that the Claude Code CLI itself marks as available outside a terminal: your own skills and commands, project and plugin ones, MCP prompts.
- A fixed set of built-in commands that were each tried against a real CLI without a terminal: `/compact`, `/clear`, `/context`, `/usage`, `/recap`, `/rename`, `/skill-doctor`, `/reload-skills`, `/list-agents`, `/dataviz`, `/claude-api`, `/simplify`, `/code-review`, `/verify`, `/run`, `/security-review`, `/loop`, `/update-config`, `/init`. They are labelled "built-in".

What is hidden: the commands the CLI tags as terminal-only, and built-ins that change the model, effort, output style or settings behind the interface's back (`/model`, `/effort`, `/output-style`, `/config` and similar) or that need a terminal (`/mcp`, `/doctor`, `/color`). A command you type by hand that is not in the menu still runs. The window's own controls cover the hidden ones: the model and effort pill in the header, the permission mode pill, Settings.

Output of local commands such as `/context` or `/usage` is shown as a reply.

`/compact` and `/clear` typed in the message box behave like the footer buttons, with two rules:

- While the agent is busy they are refused with "Not sent: wait for the agent to finish. /compact and /clear cannot be queued." Send them again when the turn ends.
- With pending comments, `/clear` is refused with "Not sent: /clear would drop the pending comments. Send or remove them first."

`/clear` starts a new conversation and keeps the old session in the Sessions list. `/compact` shows a progress line while it runs and a "context compacted" line when done.

## Shell commands with !

A draft whose first character is `!` and that is one line is a shell command, as in the Claude Code terminal. The box switches to a monospace font and shows "Shell · Enter runs"; the send button reads **Run**.

```
! git status
```

Press Enter. The command runs on the server in the project folder, and its output streams into a block in the chat.

The rules:

- Ordinary commands only. There is no terminal behind it and standard input is closed, so anything that waits for input (an editor such as vim, a pager, `git rebase -i`, `sudo`, a login or a password prompt) gets an empty input and ends by itself, usually with an error. Run those in a real terminal.
- It runs as `$SHELL -lc` (a login shell) when `$SHELL` is sh, bash, zsh, dash or ksh, and as `/bin/sh` otherwise. Nota Bene's own variables, and the ones Claude Code sets for its sessions, are not passed on.
- One at a time. A second one is refused with "Not run: a command is still running. Stop it or wait for it."
- It works while the agent is busy, because it does not go through the agent.
- Stop in the block ends it: the whole process group gets TERM, and KILL three seconds later if something is still there. A command that runs longer than 10 minutes is stopped the same way and marked "stopped: it ran longer than 10 minutes". Background jobs started by the command end with it.
- A command can be at most 32 KB. The block shows the last 64 KB of output with ANSI colour codes removed; the agent is given the last 32 KB of each of stdout and stderr.
- With pending comments or images in the draft it is not run: "Not run: the message has pending comments or images. Send or remove them first."
- To send a message that begins with `!` to the agent, put a space before it. A draft of several lines is always a message, never a command, and so is `![` (a Markdown image).

**How the agent hears about it.** Nothing is sent to the agent when the command finishes, and no extra turn is started. The finished run is queued, and in front of your next message the server puts the command and its output in the form Claude Code itself uses for `!` commands (`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`). Up to 10 finished runs wait; together they are capped at 64 KB, newest kept, and a note says how many earlier runs were left out. A message that is itself a `/command` does not take the queued runs, so the command still works as one. A session switch or `/clear` drops the queue.

Example:

```
! npm test
```

The test output streams in, it fails, and you type `fix the failing test`. The agent receives the `npm test` command and its output followed by that sentence, in one message.

## Files, branches and worktrees

The **Files** panel (Cmd/Ctrl+Shift+F) is the project tree. It has a filter box, a refresh button that keeps open folders, collapse all and expand all, and a "select opened file" button; Alt+F1 reveals the current file in the tree. The tree refreshes after each turn of the agent.

Click a file to open it in a tab:

- Markdown renders and can be commented on. Code is highlighted and can be commented on. Alt+Z wraps long lines.
- An HTML file opens as the page; **Source** shows its text (next section).
- Code blocks in replies and Markdown files wrap, with a number per source line, and a button on hover copies the block.
- Images, video and audio open in a viewer (next section).
- Files over 2 MB and binary files are not shown ("File is too large to show", "Binary file, not shown"). The **Open raw** icon (the arrow out of a box) in the file's header shows the file as the server sends it.
- **✎** in a text file's header edits it by hand: Alt+S or Cmd/Ctrl+S saves. Text that is not saved stays through a closed tab or a reload. If the file changed on disk during your edit (the agent wrote it, say), nothing is overwritten until you choose: overwrite it, or take the version on disk. Files of another branch or worktree stay read-only.
- Paths in `code` spans and relative links in the chat are clickable. A path whose file does not exist is struck through.

Tabs have a right-click menu: Close, Close others, Close to the right, Close all, and for files Copy path. A middle click closes a tab. Alt+W closes the active tab and Alt+Shift+T reopens the last closed one.

### HTML pages

An `.html` file opens as the page itself, the way a browser shows it. **Page** and **Source** in the tab's header switch between the page and its text. The page's scripts never run, because the window holds your access key: a page that needs them shows "scripts off" in the header and looks the way it does without them. Images and stylesheets next to the file load from the project. A link to another file of the project opens it as a tab, a web link opens in a new browser tab.

- Select text on the page and comment on it, as in a Markdown file.
- **Mark** (N) comments on the page itself. The element under the mouse is outlined; a click comments on it. In a diagram the click takes the nearest shape that has its own tooltip, else its group. A drag inside an SVG draws a box and comments on that area, also where nothing is drawn yet. Esc leaves.
- The comment is outlined on the page. A click on a small outline, or on the edge of a large one, opens its card.

**Example: commenting on a map.** Open `docs/map.html`, press **Mark**, click the market's circle and type `move it closer to the harbour`. Then drag a box between the mill and the market and type `a road is missing here`. The agent receives the places as they read on the page, with the element path to find them in the source:

```
1. [docs/map.html]
> h2 «Map» › svg#map «Town» › g.node «Market» › circle «Market: open on Fridays»
> element: body>:nth-child(6)>:nth-child(2)>:nth-child(1)
→ move it closer to the harbour

2. [docs/map.html]
> h2 «Map» › svg#map «Town»
> area x 100, y 60, 60×80 (viewBox units)
> covers or is next to: g.node «Mill», g.node «Market», g.node «Harbour»
> element: body>:nth-child(6)
→ a road is missing here
```

When the agent changes the page, a comment finds its element again by what it reads as; one whose element is gone is marked "fragment changed". Marking needs a server from this version; after an update, restart the server.

### Other branches and worktrees

The window never switches your checkout, since a live window may be running from it. Instead the branch button in the header opens a list of "this folder", every other git worktree of the repository, and every local branch that has no worktree, with a search box. Each row shows `↑N`, the commits over its base, `✗` when it has uncommitted work, and a pulsing dot when an agent is working there. The dot follows the Nota Bene windows on this machine: an agent in a plain terminal, or a subagent in its own worktree, gets none.

Pick one and the tree, Changes and the log show it. The button turns orange and says "viewing": the window's folder and the agent stay where they are. Files from another source open read-only in tabs marked with the branch name, and you can still comment on them; the comment remembers the ref.

Example: the agent works in the `feature/retry` worktree while your window is on `main`. Pick that worktree in the header, open `src/queue.ts` from it, comment on a line, and send. Paths the agent prints inside another worktree open from that worktree too.

### Changes and the Git log

In a git repository the left strip has two more buttons. Both only read: nothing here commits, stages, reverts or switches.

**Changes** opens a panel in place of Files and a tab with one changed file at a time, so a large diff stays as light as a small one; `‹ ›` moves between files, and one or two columns are remembered. **Show** picks what is compared:

- **Uncommitted**, the default for a folder: everything not committed yet, new files included.
- **Whole branch from X**: from the point where the branch left X. A branch with no folder starts here, as it has nothing uncommitted.
- Any other local branch.

Git does not record a branch's parent. X is the branch named in the record of its creation, and otherwise the default branch (`origin/HEAD`, then `main`, then `master`). The choice is kept per project and per branch.

The file list is flat, each name followed by its folder; **Tree** shows the same files as folders (a folder holding just one folder is one row, `server/src`), each folds with a click, and the choice is remembered.

The list shows at most 3000 files and a patch at most 3 MB; the view says when something was cut. `node_modules`, `.nota-bene` and the state folder are never shown. If git does not answer, the view says so and keeps the last result.

**Git log** is a tab with the commit graph of all branches or of the branch shown, at most the latest 400 commits. The filter dims what does not match by text, author or hash, and a chip of a branch switches the view to it. Click a commit for its message, its files and the diff of one file; the card's width can be dragged.

Select text in a diff to comment, as in a file. The comment names the file, with the branch or commit when it is not this folder (`src/queue.ts @ feature/retry`), and is marked in the diff. A click on a comment made on a commit opens that commit in the log. A comment on a removed line has no place in the current file, so a jump to it finds nothing there.

### 3D models (experimental)

Off by default. See [troubleshooting](#experimental-3d).

## Images and video

### Attaching images to a message

Paste an image from the clipboard, drop it on the window, or use the paperclip button. Images are scaled down to at most 1568 px on the long edge, and a PNG over 3.5 MB becomes a JPEG. They show as thumbnails in the draft and open in a lightbox. They are stored on the server by content hash and travel as ids, so a long history of screenshots does not slow a reload.

**Comments on an attached image.** With a Nota Bene that is new enough (protocol 17), each thumbnail in the draft has a pen with the number of comments on it. It opens the image full-window in markup mode, with the same tools as a media tab; draw, press **Comment** (Enter) and type the note. The agent gets the image with your marks drawn on it and the note in the batch, which names the image ("image 2"). Such a comment goes only with the message that carries its image: if the image is no longer in the draft (a reload, another device, or it was removed), the comment shows "image not attached" and stays pending until **Attach again** puts the image back. Removing an image that has pending comments asks first and removes them with it.

### Viewing and marking up images and video

Images open with a click to toggle natural size. Video and audio open with a player: play and pause (Space or K), seek, playback speed, volume, picture in picture, fullscreen. The seek step is set on the bar. A playing video goes to picture in picture when you leave its tab, and audio keeps playing; closing the tab stops it.

Player keys, when the player has focus:

| Key | Action |
|---|---|
| Space, K | play or pause |
| Left, Right | seek by the step set on the bar |
| J, L | back or forward 10 s |
| Up, Down | volume 5 % |
| M | mute |
| F | fullscreen (video) |
| 0 to 9 | jump to 0 to 90 % |
| comma, period | one frame back or forward while paused (video) |
| Home, End | to the start or end |
| N | annotate the frame |

**Example: marking up a video frame.** Pause the video where the button looks wrong and press **Mark up** (or N). Draw on the frame with Rectangle (R), Ellipse (E), Pen (P) or Arrow (A); pick a colour with 1 to 5 (red, yellow, green, blue, white); undo with Cmd/Ctrl+Z. Press **Comment** (Enter) and type `this button is misaligned`. Esc leaves markup mode, and asks before it throws away a drawing you have not commented on. The comment joins the batch. When you send, the agent receives the frame with your marks drawn on it and the note, along with the other comments. Several comments on one frame are combined into one image whose marks carry the comment numbers.

The marked frame and layer are saved in the project folder under `.nota-bene/marks/`, with a `.gitignore` inside that keeps them out of git (see [state on disk](#state-on-disk)).

### Images in the temp folder

When the agent leaves an image in a temporary folder, for example a screenshot saved to `/tmp/x.png`, the absolute path in inline code in the chat is a link, and a tool line that names one gets a button beside it. Click it and the image opens in a tab, like a project file: you can mark it up and comment on it. If the file is gone, the tab says so.

This is narrow on purpose. Only absolute paths inside the system temp folders (`/tmp`, `/private/tmp` and `os.tmpdir()`, checked after resolving symbolic links) are served, only image files (png, jpg, jpeg, gif, webp, avif, bmp, svg), up to 50 MB, one file at a time. There is no listing and no search of the temp folder, and nothing else outside the project is readable this way.

## Subagents and background tasks

When the agent starts a subagent, the call in the chat is a card with the subagent's type, a description and its status (running, done, error, stopped). **Open** shows the subagent's conversation in its own tab, read-only, refreshed while it runs. Comments you make there go to the main session. The message box always talks to the main agent, whichever tab is open.

The task indicator under the message box counts running subagents and background shell tasks. Click it or press Alt+T to open the **Tasks** drawer: a tree of subagents, shell tasks and monitors with status, elapsed time, the last tool and, for a Claude subagent, its model. Per task you can open it, **Stop** it (click twice: the first click turns the button into "Stop?") or send a foreground call **To background**. A shell task opens as a **Task output** tab that shows the tail of its output and refreshes every second while it runs. Finished tasks stay in the list (the last 20).

## Sessions and history

The **Sessions** icon in the header opens a picker over the selected provider's sessions on the machine, grouped by folder, with the current project first and a filter box (title or folder). Pick one to switch the window to it in place, without a reload. If the session is from another folder, the window moves to that project (tree, file access and the agent's working folder). The dialog warns you not to keep the same session open in another agent client at the same time: the history would get mixed up. **+ new session in this project** starts a fresh one. A new session can only start in the current folder or in a folder that already has sessions.

✎ on a row renames that session, the open one or any other, without switching to it. The open session also has **Rename** in the chat tab's right-click menu. Enter saves, Esc cancels. The title is the agent's own, so Claude Code or Codex shows it too.

Branches of a conversation: `/nb fork` from Claude Code, or `nota-bene --resume ID --fork`, opens a copy of a conversation that continues on its own. The original is untouched.

Claude Code replays a session only from its last compaction. Nota Bene keeps what came before: after a `/compact` an earlier part of the chat shows a "Show before compaction" link that loads the archived segment. The archive is in `history/<sessionId>.jsonl` in the state folder.

The **Restart the agent** icon (↻) restarts the agent and continues the same session. It stays available while the agent is busy, as an escape hatch for a stuck turn. The arrow next to it has **Restart the server**, shown when the window runs under the launcher (always for `/nb` and `nota-bene`, never for `npm start` or `npm run dev`). A **Restart server · code updated** button appears when the server's code changed after it started; this only matters when you are developing Nota Bene itself.

## Permission modes, settings, languages

### Agent permission modes

The mode pill under the message box, or Shift+Tab in the box, cycles through:

| Mode | Behaviour |
|---|---|
| Default | Asks before edits and commands. |
| Accept edits | Edits files without asking, asks before commands. |
| Plan | Only reads and thinks, changes nothing, and ends with a plan to approve. |
| Auto | A classifier approves safe actions itself and asks about the rest. |

The mode is saved per project folder. The model and effort pill in the header sets the model and the effort (Low, Medium, High, Extra high, Max). In the menu the effort is a stepped slider: **Auto** (the model's own default, no level) and one stop per level the model has; click a stop, drag, or step with Left, Right, Home and End. It shows the model's short name (for the default row: the name of the row for the same model (an alias row first), else the model's short name such as "Opus 5.5", else the row's name without its parenthetical), a small `1M` for the 1M-context variant and a tiny bar for the effort (nothing for Auto); the tooltip and the screen-reader name spell the effort out. In the menu, the model under the pointer or focus (else the current one) has its full description under the list, since the rows cut it short. A change applies from the next reply, and the pill warns when it makes the next reply re-read the whole context. A long list (a router such as OpenRouter offers dozens of models) has a search field at the top, scrolls inside the menu and is grouped by provider, the provider in use first.

**Stop window** (⏻, the last button of the header, right of the gear) stops the agent and the window after a confirmation, which warns when a turn is running; the launcher exits with it (a `/nb` background task ends, a terminal gets its prompt back). The tab then says the window is stopped and does not reconnect; the session stays, and `/nb` or `nota-bene` opens it again.

### Settings

The gear in the header opens a menu: the interface language, the colour theme, the interface scale (− and + step it and keep the menu open; Alt+= and Alt+− do the same anywhere, Alt+0 goes back to 100 %), and **All settings…**, the Settings tab:

- **Windows**: every running window with its folder, port, state (working or idle), number of open tabs and uptime. Open, Restart agent, Restart server and Stop work on any of them.
- **Storage**: what is on disk for pasted images, voice recordings, comments, chat history from before compaction and media marks, with **Clean unreferenced files**, which moves pasted images and voice recordings that no message or comment references and that are over a day old, and the history of sessions that no longer exist, to the state folder's `trash/`. Nothing is deleted.
- **Voice messages (Whisper)**: off by default. **Install Whisper** downloads the `whisper-small` speech model with the transformers runtime from npm and Hugging Face (about 430 MB to download, 770 MB on disk) into the `whisper` folder of the state folder, after a confirmation that names the exact path. The model runs in a separate thread, so the window stays responsive while it transcribes, and in a background process that all windows of this computer share: it loads the model at the first recording and unloads it after 10 minutes without one, so the model's memory is used once, not once per window. Once it is installed, a checkbox turns Whisper on or off: with it on, the microphone buttons of this window and of the phone (in the message field and in comments) record up to 10 minutes and this computer transcribes the recording, a long one in parts of up to a minute. Without Whisper the microphone button offers to install it, or to turn it on. The audio of voice messages is not thrown away after it is transcribed: see Voice messages in the chat section. **Spoken language** (with Whisper installed, on a new enough server) chooses what you speak: **Detect automatically** (the default) lets Whisper recognise the language of each recording from its first 30 seconds and falls back to the interface language when it is not sure or the recording is very short; picking one of the six languages pins it. The choice belongs to this computer and is shared by every window. **Remove Whisper** stops that background process and deletes the model files, not the recordings.
- **Defaults**: interface language, interface scale (90–150 %: text and spacing grow, for every window at once), and the agent mode for projects that have none of their own.
- **Themes**: the six colour themes, each with a swatch of its own colours; pick one. It is the same choice as the Theme row of the gear menu.
- **About**: version, state folder, where the logs are, Node version.

Sessions, Restart the agent and a file's Open raw are icons; each names itself in a tooltip, and a tooltip also names the key when the action has one.

### Themes

Six colour themes ship: **Darcula** (the default, with IntelliJ's colours on millimetre paper), **Plannotator** (the look earlier versions had) and **Solarized Dark**, dark; **IntelliJ Light**, **GitHub Light** and **Solarized Light**, light. Pick one in the gear menu (Theme) or in Settings → Themes. The choice is saved in `prefs.json` and shared by all windows; a window that is already open takes it when it next connects. A light theme stays light when the operating system is dark. Code highlighting, mermaid diagrams and the header logo follow the theme. Inline code that is a colour, such as `#ff8980` or `oklch(0.7 0.2 60)`, shows a swatch of it before the text. Layout, tabs and keys do not change with it.

### Languages

The gear menu in the header lists the interface languages: English, Russian, Simplified Chinese, Spanish, Brazilian Portuguese and German. The choice is saved in `prefs.json` and shared by all windows. English is the default whatever the browser language is.

## Hotkeys

The full list is in the window's Hotkeys help. Tab keys use Alt because Chrome keeps Cmd/Ctrl+W, T and 1 to 9. On a Mac, Option plus a letter types a character, so in a text field the Alt+letter shortcuts do not fire there.

| Keys | Action |
|---|---|
| Alt+W | close tab |
| Alt+Shift+T | reopen closed tab |
| Alt+Left, Alt+Right | previous or next tab |
| Alt+1 to Alt+9 | tab N (1 is the chat, 9 is the last) |
| Alt+E | recent files and project search |
| Alt+H | prompt history (searchable list) |
| Alt+↑ / Alt+↓ | older / newer prompt in the message field, any draft |
| Cmd/Ctrl+Shift+F | Files panel |
| Cmd/Ctrl+Shift+C | Comments panel |
| Alt+T | Tasks drawer |
| Alt+R | record a voice message; again, send it |
| Alt+Z | wrap lines in a text file |
| Alt+= / Alt+− / Alt+0 | a larger interface / a smaller one / back to 100 % |
| N (an HTML page) | mark an element or an area; Esc leaves |
| Alt+F1 | reveal the current file in the tree |
| / or Esc | focus the message box (outside text fields) |
| Shift+Tab (in the message box) | next permission mode |
| Enter, Shift+Enter | send, new line |
| Cmd/Ctrl+Enter | interrupt the agent and send (while it works: press twice, or confirm) |
| Cmd/Ctrl+Enter (comment popup) | add the comment |

## Security

Nota Bene gives a web page the power to read your project and run an agent, so it is built to let in only you.

- **Local only.** The server binds to `127.0.0.1`. Nothing outside your machine can connect. Hosts and origins are checked on top of that.
- **Access token.** The first launch creates `<state>/token` (state is `~/.nota-bene`, see below): 32 random bytes as hex, mode 600, in a folder with mode 700. Every route and the WebSocket need a credential derived from it. The token itself is never put on a command line, in an environment variable, in a URL or in a log, and the agent's environment and `!` commands do not get it.
- **How login works.** When the launcher opens your browser, it opens a small page in `<state>/open/` (mode 600) that redirects to `http://127.0.0.1:PORT/#t=LOGIN`. LOGIN is a keyed hash of the token, the port and a per-launch random value, not the token. The page removes it from the address bar, sends it to the server once, and the server answers with an HttpOnly, SameSite=Strict cookie `nb_<port>` that lasts a year and a key that the page keeps in its local storage. The cookie alone opens only `GET` of `/file` and `/attach/<id>` (what `<img>` and `<video>` need). Everything else, including the WebSocket, also needs the key.
- **A login belongs to one launch.** The login value, the cookie and the key all die when the launcher exits. After a crash relaunch they are replaced and the launcher opens a fresh login page. Restarting the server from the window keeps them, so open tabs stay logged in.
- **A second browser.** `nota-bene --url PORT` prints the login URL of a running window. Open it in the other browser. The URL works until that window's launcher exits. The command first checks that the port really answers as your window, and refuses with an error for a port that cannot prove it.
- **Rotating the token.** Delete `<state>/token` and restart the server. A window that was live under the old token can no longer be recognised by `nota-bene --find`, so reopen it; until you do, `/nb` or a new launch on that folder starts a second window.
- **The state folder is never served.** The file routes, the tree, search and branch views refuse anything inside the state folder, even when your project folder contains it.

The residual risk, in plain words:

- The token file is readable by any process running as your OS user, the agent included. The aim is to keep out other users and other software that cannot read your files, not your own tools.
- Browsers send cookies to every port on `127.0.0.1`. While a window is open, a local web server on another port that you visit in the same browser receives its `nb_<port>` cookie. With it, that server can read files of the open project through `/file` and pasted images through `/attach/<id>`. It cannot open the WebSocket, write anything or reach any other route, because those need the key, which only the page's own origin can read. The cookie stops working at the next launch.
- A token that was ever committed to git stays readable in the repository history after the file is removed. Do not make the state folder a repository.

### Usage

The bars button in the header opens **Usage**: exact token accounting for every project on this machine, read from the transcripts of Claude Code and Codex, so work outside Nota Bene counts too. Everything stays on your machine.

- **Claude** and **Codex** have separate counters. **Reset** starts a new count; nothing is deleted, the older data stays under **All time**.
- The large number is **weighted tokens**: input ×1, cache write ×1.25, cache read ×0.1, output ×5, the same for every model. It is a yardstick, not a price; a plain sum would be almost only cache reads. Hover over the word for the raw counts, or over a model for its own. The bar under it splits the tokens by model.
- **Limit hits**: two charts, 5-hour windows of work over weeks, red where a limit was hit; hover over a bar for its tokens. Under them a table of the hits: what went in the 5 hours (or the week) before each. Click a row for the tasks that ate the window. Then tokens per 1% of the weekly limit: a falling line means the same 100% buys fewer tokens. Codex has these readings from its own history; Claude's are recorded from now on, while a window is open. So is a limit you pass on extra usage: the work goes on and no transcript says it, so such a hit is only seen by an open Nota Bene window. Orange on top of a bar is extra usage. Under the table: the tokens spent on extra usage and what they cost, by the vendor's own sum.
- **Where it went**: the costliest **Tasks** and **Projects**. A task is one message of yours and all the agent did until the reply: click one for its subagents and costliest calls. A project is the folder a session started in, with its share of everything spent; hover over the row for the part that went to subagents.

Anything a period has nothing to show for is left out.

The store keeps what it read after the transcripts themselves are gone. Sessions under a temporary folder are skipped.

### Updates

An installed window asks the npm registry for the latest version, at most once a minute per machine (the answer is shared by all windows through `update-check.json`), and when you come back to its tab. The request carries no project, session or account data. When a newer version is out, the header shows `↑ <version>` with what changed since your version (read from the CHANGELOG on GitHub, once per version). **Later** hides it until the next version.

- **Update** installs the newest release this machine has seen on npm (never a version the page names) into `runtime/` in the state folder, next to the version you run. Then the header says `<version> is ready`.
- A ready version restarts the window in a pause: no turn running, no question or approval waiting, no `!` command and no task of the agent (a background command, a subagent) running and, for an open page, an empty composer (no draft, no images, no upload or message on its way). An open page asks for the restart itself; with no page open the server does. **Restart** restarts at once whatever the composer holds (it is disabled while the agent or a command runs, with the tooltip "After the agent and running commands finish"). Either way the server restarts on the same port, the same session continues, and the header shows **Updated to <version>** once.
- The open page then still has the previous version's code. It reloads itself as soon as its composer is empty and nothing runs; a draft is not kept across a reload, so with one the page stays as it is and the header offers **Reload** next to **Updated to**.
- **Update automatically** (in the same notice, off by default, one setting for the whole machine and every agent) installs each new release by itself; the window still restarts only in a pause.
- If the install fails, or the new version does not answer within 20 seconds, or exits within its first minute, the window keeps (or goes back to) the version it had. The notice says **Update failed** or **Update to <version> was rolled back** and shows the log, `runtime/update.log` in the state folder. **Update automatically** tries a failed install again an hour later, a rolled-back version never; **Update** tries either by hand.
- A source checkout never checks, installs or restarts. Windows older than the first one with this feature update once by hand ([Updating](../README.md#updating)).

Turn the check off in Settings → Defaults, for every window of that agent; `NOTA_BENE_NO_UPDATE_CHECK=1` turns it off whatever Settings say. With the check off nothing is asked and nothing is installed.

### Audit log

Every window writes what happens in it to `~/.nota-bene/audit/YYYY-MM-DD.jsonl`, one JSON line per event: the server starting and stopping, the page connecting and disconnecting, each send, stop, permission answer, mode or model change, each tool call by name, each turn's end and how it ended (done, interrupted, failed), tasks, API retries and errors. The windows share one file a day; `port` and `pid` tell them apart. It is for working out afterwards why something happened, for instance what stopped a turn. It never holds the text of messages, comments, commands, tool input or output: only names, ids, counts and times. Files are private to you, kept 14 days, at most 50 MB a day. Nothing leaves the machine. Turn it off in Settings → Defaults, for every window of that agent.

## Remote access (prototype)

`nota-bene remote` lets a paired phone reach this computer's windows through a relay, without anything on the computer
accepting connections: the computer and the phone each connect out to the relay, and everything between them is
end-to-end encrypted (the relay sees only ciphertext and which phone talks to which host). The phone side is an
Android app (below); this is the computer's side.

```sh
nota-bene remote --relay wss://relay.example.com   # run the connector (the relay is saved; later just `nota-bene remote`)
nota-bene remote pair                             # in another terminal: a QR code for the app, valid 5 minutes
nota-bene remote devices                          # the paired phones: id, name, fingerprint, online
nota-bene remote revoke <id>                      # unpair a phone; its connection is cut at once
nota-bene remote status
```

- The connector runs in the foreground; it reaches every window of every agent (Claude, Codex, omp) the way the
  launcher does, with each window's own credentials, which never leave the computer.
- Pairing: `pair` prints the QR code and the computer's fingerprint; when the phone has scanned it, it prints the
  phone's fingerprint. Compare both with what the app shows. A code pairs one phone; another phone presenting it is
  refused and named in the `pair` output. A new `pair`, Ctrl-C or the 5 minutes end the code.
- A paired phone is fully trusted: it can do in a window what a tab of that window can (and the one-tab rule applies:
  "Work here" on the phone takes the window over).
- `remote` is a command now: a project folder named `remote` opens with `nota-bene ./remote`.
- Only one connector runs per user; a second one stops with "already running". If the relay says another connector
  with the same key is connected, this one stops instead of fighting it.

### The Android app (prototype)

The app is built by a manual run of the Mobile workflow (Actions → Mobile → Run workflow): download its
`nota-bene-android` artifact and install the APK on the phone (allow installs from that source once). Builds of this repository are signed with one key,
so a newer APK installs over the older one and keeps the phone's key and pairings; a debug build (from a fork) does not.

- **Unlock.** The app opens only after the phone's own check (fingerprint, face, or the screen lock's PIN or pattern)
  and asks again after five minutes in the background. A phone without a screen lock cannot open it.
- **Pair.** Run `nota-bene remote pair` on the computer, tap *Pair a host* and scan the code (or copy the
  `nbremote://` text and use *Paste the code instead*). Compare the two fingerprints with what `pair` printed.
- **Sessions.** One group per paired host with its open windows, two lines a row as in a messenger: the session title
  with the time of the last message, and the last message (the folder as a coloured prefix) with a badge, the unread
  count or ! when the window waits for your answer; a dot on the avatar shows while the window works. Pull down to
  refresh. An offline host shows when it was last seen; a host that revoked this phone says so and offers *Forget*.
  Long-press a host to rename it (the name is kept on the phone only; it starts as the computer's name). At start the
  app reopens the chat used last, when its host is online and still has that window.
- **Chat.** The window's conversation as on the desktop (Markdown, highlighted code, formulas, Mermaid diagrams as
  pictures; tap a diagram to zoom). Consecutive tool calls fold into one "N actions" line, with its errors and comments;
  tap it to open the lines, and a line to see its result. Send (while the agent works, the message waits for the turn
  or, with *Send now*, interrupts it) and *Stop*. The header pill shows the session and its state (online, working with
  the current tool and the time, waiting for your answer, compacting, offline); tap it for the window sheet: model,
  effort, mode and *Restart agent*. The ring beside it is the context meter; tap it for the context sheet: tokens, the
  5-hour and weekly limits, the session's cost, idle compaction, *Compact*, *Clear* and *Stats* (the usage report of the
  computer, as the desktop's Usage tab). A tool asking for permission opens a sheet with the whole command; a question
  from the agent is a card in the chat, with its options and a free-text answer. When the host is offline what arrived
  stays readable and sending is off.
- **Panes.** A chat is three panes: Files, Chat and Comments, with a pill of tabs and a swipe across the screen (side
  by side on a wide screen). Files lists the session's files, then the project's folders and files with a search; a
  Markdown file, an image or a video opens full screen, any other text file read-only (the first 2 MiB), and in a git
  repository the pane has *Changes* and *Log* tabs whose files open as diffs.
- **One tab.** The phone is a tab of the window: if the window is open on the computer, *Work here* takes it over,
  and the computer's tab offers to take it back.
- **Settings.** The desktop's six themes (dark first, then light; Darcula until one is picked), the app's language
  (the phone's own, or one of the six), the text size (85–150 %) and the interface size (90–130 %), the voice language and
  the paired hosts. The choices stay on the phone, for every host; code highlighting and Mermaid diagrams follow the
  theme.
- **Comments.** Tap a paragraph, heading, list item, quote or table of a reply: a bubble offers the quick labels (a chevron
  shows all eleven), *Comment* (a sheet with the quote, the labels, a field, images and voice clips) and *Copy*. In a
  file, a Markdown text or a diff, select text and choose *Comment*; on an image or a video frame, mark it up (shapes,
  colours) and comment, as on the desktop. The comments gather in the *Comments* pane, and one line above the composer,
  "N comments to send", says how many wait; tap it to open the pane, where they are edited (long-press), deleted (swipe left,
  with *Undo*) and sent with its *Send*; the sent ones fold under "Sent". Typed text in the field takes them along as the
  desktop sends them, and so does a voice message: a recording made while comments are pending carries them. The desktop
  shows them too, because they are the window's comments. A comment is highlighted in its file; tap it to open it there.
  Comments on HTML pages and 3D models stay on the desktop.
- **Images.** Images open from the file links in the chat and zoom with a pinch (a double tap zooms in); the paperclip
  opens a sheet with *Gallery*, *File*, *Camera* and your latest photos to attach up to ten. Videos play in the app.
- **Voice messages.** With Whisper on at the computer (Settings, Voice messages there; without it the microphone offers to
  install it or turn it on), hold the microphone in the message field to record, slide left to cancel, slide up to lock
  the recording (then *Stop* leads to a preview with *Delete* and *Send*), let go to send. It is a message of its own,
  up to 10 minutes; the computer transcribes it, and the message shows a play button, the wave and the transcript, with
  *Retry* when it failed. Voice clips in a comment work the same way. The language is recognised by itself (**Automatic**,
  the default) or pinned in Settings, Voice language; a badge with its code marks a message recognised in a language
  other than the app's. The phone has no recognizer of its own.
- **Project icons.** Long-press a session in the list, or open the window sheet, and choose *Set icon* to give its project
  folder a picture from the camera or the gallery (cut to a centre square of 256 px on the phone); *Remove icon* takes it
  away. The picture is kept on the computer in Nota Bene's own folder, never in the project, so every window of that
  folder shows it on every phone (as the session's avatar in the list and in the chat header). The desktop shows nothing
  new.
- **Versions.** The app needs Nota Bene 1.8.0 or newer on the computer, the first version with `nota-bene remote`.
  What a computer on an older version cannot do is off in the app: the microphone is greyed and says the computer needs
  an update, and *Set icon* is not offered.
- **Not yet:** push notifications. Open items are tracked in #63.

## State on disk

All state lives in `~/.nota-bene/`, except the media marks. Set `NOTA_BENE_HOME` to use another folder. `npm run dev` of a source checkout uses `~/.nota-bene-dev`.

| Path | Holds |
|---|---|
| `token` | the access token; deleting it rotates it at the next server start |
| `control-token` | a separate secret for the controls between windows (Settings, Windows) |
| `open/` | the short-lived pages the browser is opened on |
| `sessions.json` | the last session of each project folder |
| `prefs.json` | agent mode per project, the interface language |
| `comments/<sessionId>.json` | pending and sent comments of a session |
| `attachments/<sha256>.<ext>` | pasted images and voice recordings (`.wav`), by content hash |
| `windows/<port>.json` | the registry of running windows |
| `locks/` | per-folder launch locks |
| `history/<sessionId>.jsonl` | the conversation before each compaction |
| `cache/blend/` | `.blend` files converted for the 3D tab (safe to delete) |
| `trash/` | what Settings, Storage, Clean moved |
| `update-check.json` | the newest version seen on npm and when it was asked, shared by every window |
| `runtime/` | releases installed by the in-app update, and its state and log (see [Updates](#updates)) |
| `audit/YYYY-MM-DD.jsonl` | the audit log of system events of every window ([Audit log](#audit-log)) |
| `usage/` | the Usage tab: token counts of every project and short labels (the first 64 characters of a prompt, a subagent's description) |
| `remote/` | the remote connector's host key (`host.key`), paired phones (`devices.json`), relay address (`config.json`), all mode 600, and its control socket (`control.sock`); deleting `host.key` unpairs every phone |

The one exception is media marks: `<project>/.nota-bene/marks/<comment id>/frame.jpg` and `layer.png`, with a `.nota-bene/.gitignore` containing `*`. They are the only thing Nota Bene writes into a project folder.

## Troubleshooting

### An apostrophe in the plugin data path

`/nb` passes the plugin's data folder to its script in single quotes. If the path to it contains an apostrophe (a home folder such as `/Users/o'brien`), the quoting breaks and `/nb` fails before it starts. Use the terminal route instead: `npm i -g nota-bene-ide`, then `nota-bene` in the project folder.

### The sandbox message

If Claude Code's sandbox mode is on, the first `/nb` can end with "cannot write to the plugin data dir ... The likely cause is Claude Code's sandbox mode". The install needs to write outside the project. Allow writes to that folder in the sandbox settings, or turn the sandbox off for `/nb`. Retrying changes nothing until you do.

### Interactive commands

`sudo`, logins, password prompts, editors such as vim and pagers need a terminal. In `!` commands and in the agent's own shell they get an empty input. Run them in a real terminal.

### A refused token file

If `<state>/token` is readable by group or others, is a symbolic link, belongs to another user, or does not hold 64 hex characters, the launcher stops before starting a server and prints the file and the fix, for example ``fix it with `chmod 600 <file>`, or delete it to make a new token``. Nothing is replaced silently, because a new token logs every open window out. The same goes for `control-token` and for a state folder owned by another user (point `NOTA_BENE_HOME` at a folder of your own).

### "This window is not logged in"

The page you opened has no login: a bookmark, a copied address, or a tab left over from an earlier launch. Open the window again with `nota-bene` in the folder, or `/nb`: both bring the existing window to the front, logged in. From a terminal, `nota-bene --front PORT` does the same, and `nota-bene --url PORT` prints a URL. After a server crash and relaunch the old tab shows this message too, and the launcher opens a fresh page for you.

### `nota-bene . &` stops when the shell exits

A foreground launcher stops itself when the shell that started it is gone, so that no window is left running after its terminal closes. `nota-bene . &` in a script or a shell that exits ends the window with it. Use `nota-bene . --detach`, which starts the window on its own and prints its URL.

### The port is in use

With `--port N` the launcher stops with "port N is in use". Pick another port, or omit `--port`. Without it, the launcher takes the first free port from 4777 to 4799 and reports "no free port" if all are taken (close a window you do not need: Settings, Windows, Stop).

### Experimental 3D

The model tab for `.glb`, `.gltf` and `.blend` files is off by default. Turn it on by starting the server with the environment variable `NOTA_BENE_EXPERIMENTAL_3D=1`:

```sh
NOTA_BENE_EXPERIMENTAL_3D=1 nota-bene .
```

A `.blend` file needs Blender on the machine: the path in `NOTA_BENE_BLENDER`, else `blender` on `PATH`, else `/Applications/Blender.app/Contents/MacOS/Blender`. Blender converts the file in a locked-down mode (and under `sandbox-exec` on macOS), refuses a file that references files outside the project, takes one conversion at a time and gives up after 120 seconds. Models over 256 MB are not shown.

The variable is read when the server starts. If a window for the folder is already open, a new launch only brings that window to the front, and the variable is ignored: the open window keeps the setting it started with. Stop the window first, then launch again.

## Codex support

Select the provider at launch: `nota-bene . --agent codex --detach`. The browser
stays bound to that vendor. Without `--agent`, see [Which agent](#which-agent); no transcript
conversion or cross-provider model switch occurs. Codex state is under the normal
Nota Bene state root's `providers/codex` directory. Secrets, settings, windows,
comments and archives are isolated from Claude.

Codex CLI 0.166.0+ is required for the native paginated history and experimental
terminal APIs; a window started on an older CLI says so and starts no session. `NOTA_BENE_CODEX` can select a Codex executable. Account sign-in is
handled by native Codex; the window offers sign-in/retry when needed.

Implemented flows include new/resume/fork/list/switch, streamed replies, command,
file and MCP tool results, paginated history with stable comment anchors, text and
image input, file search, skill discovery, model/reasoning selection, interruption,
manual and idle compaction, clear, context usage and actual account limit windows.
Child conversations are opened as subagent tabs. Native background terminals can
be discovered and stopped. Models and permission profiles apply to the next turn.
The configured profile inherits Codex's actual settings; explicit read-only,
workspace and full-access profiles are distinct from Claude modes. Full access
turns off sandboxing and approval prompts. Native advertised approval choices,
user questions and MCP form requests are answered through the browser.

Unavailable native facts stay unknown: ChatGPT session cost is not reported in
USD, context usage is empty before native token data, and a compaction without a
reported pre-token count does not invent one.

Full feature parity is **not yet achieved**. Current explicit gates:

- Codex app-server exposes terminal discovery/termination, but no supported API
  was found to force an arbitrary foreground tool into the background. The
  browser does not offer that action for Codex.
- No supported native next-prompt suggestion stream was verified. Nota Bene does
  not start additional model calls to fabricate suggestions.
- The native terminal API does not expose an output-tail read operation. Terminal
  tasks can be stopped, but the output-tail tab is unavailable for Codex.
- MCP device verification requires a native host authenticator and is not supported
  by the browser form bridge. Such requests fail explicitly rather than claiming
  verification. Ordinary form and URL elicitation are supported.

These are Codex gaps; Claude retains its existing controls.

Development checks for this integration:

```sh
npx tsc -b
npm test
npm run build -w web
npm run e2e
npm run e2e:codex
NOTA_BENE_NATIVE_TEST=1 npx vitest run server/src/agent/codex/native.test.ts
```

The opt-in native contract uses the installed Codex binary with a temporary
CODEX_HOME, project and local Responses endpoint. It verifies skill discovery,
streaming, actual command execution, history from another app-server, fork and
termination of a running terminal when its owning session closes. It makes no
paid model calls. Native ChatGPT account discovery was checked separately without
reading credentials; the existing Claude browser suite also remains part of the
acceptance run.

## omp support

omp support is a preview: it is tested against a scripted omp, less in daily use than Claude and Codex.

Select omp at launch: `nota-bene . --agent omp --detach`. The window spawns
`omp acp` (omp 18.16.0 or newer; `NOTA_BENE_OMP` can select the executable) and uses
omp's own login, models and session storage. A window on an older omp says so and
starts no session. State is under the Nota Bene state root's `providers/omp`.

Modes map to omp's approval levels: **Yolo** (omp's default: nothing asks except
restricted folders and critical commands), **Write** (shell and exec ask), **Ask**
(every write and exec asks) and **Plan** (omp's read-only plan mode; writes ask).
A new project starts in Yolo; Settings → Defaults picks another start mode,
and each project keeps the mode last chosen in it.
Switching to another approval level (Yolo, Write, or Ask/Plan) restarts the omp process on the same
conversation and is refused while the agent is working; switching between Ask and Plan happens in place.

Implemented flows: new, resume, fork, list and switch of omp sessions; streamed
replies; tool rows; approval cards for shell (Allow, Always allow, Deny, Always
reject) and for writes; the `ask` tool's questions with a free-text answer; a message
sent while omp works joins the running turn; Stop; `/clear`; rename of the open
conversation; model (the current model's provider first, the others under **Other
providers**) and effort; context use and session cost.

Not available over ACP: subagent tabs (a `task` call shows only its progress text),
task stop/background/output controls, compaction events and `@` file search.
Renaming a session other than the open one is refused; open it first.

From omp, install the skill once (`ln -sfn "$PWD/omp/skills/nb" ~/.omp/agent/skills/nb`
from a checkout), then `/skill:nb` opens or brings forward the window for the current
folder, `/skill:nb new` starts a fresh conversation and `/skill:nb fork` continues the
invoking omp conversation as a branch. The window runs detached; **Stop window** (⏻) in the window's header
ends it. Do not keep working in the same conversation from an omp terminal while the
window owns it.
