# Nota Bene guide

Nota Bene is a browser window over Claude Code, Codex or omp. You review what the agent made (replies, code, images, video frames, HTML pages, diagrams, 3D models), comment in the margin and send every comment as one batch. Exact limits and edge cases sit in collapsed **More** blocks. Short introduction: the [README](https://github.com/iCubeDm/nota-bene-ide/blob/main/README.md); how it is built: [architecture](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/architecture.md).

Contents

- [Quick start](#quick-start)
- [Starting a window](#starting-a-window)
- [One window per folder, one tab per window](#one-window-per-folder-one-tab-per-window)
- [Margin comments and the batch send](#margin-comments-and-the-batch-send)
- [Images and video](#images-and-video)
- [HTML pages and diagrams](#html-pages-and-diagrams)
- [3D models (experimental)](#3d-models-experimental)
- [Chat](#chat)
- [The @ picker and the / menu](#the--picker-and-the--menu)
- [Shell commands with !](#shell-commands-with-)
- [Files, branches and worktrees](#files-branches-and-worktrees)
- [Subagents and background tasks](#subagents-and-background-tasks)
- [Sessions and history](#sessions-and-history)
- [Projects: switching, opening, creating](#projects-switching-opening-creating)
- [Permission modes, settings, languages](#permission-modes-settings-languages)
- [Hotkeys](#hotkeys)
- [Usage, updates and the audit log](#usage-updates-and-the-audit-log)
- [Security](#security)
- [Remote access](#remote-access)
- [Codex and omp: what is supported](#codex-and-omp-what-is-supported)
- [State on disk](#state-on-disk)
- [Windows](#windows)
- [Troubleshooting](#troubleshooting)

## Quick start

1. Open a window on a project folder: `/nb` in Claude Code, `$nb` in Codex, `/skill:nb` in omp, or `nota-bene` in a terminal there. The browser opens on it, logged in.
2. Ask the agent something. Select a sentence of the reply, press **Comment**, type a note, press Cmd/Ctrl+Enter.
3. Open an image or a video from **Files**, press **Mark up** (N), draw around what is wrong, press **Comment** (Enter) and type the note. Lines of code and HTML pages take comments the same way.
4. Press **Send**. The agent gets one message with every fragment, your note on each, and the marked pictures.

## Starting a window

**Requirements:** Node.js 22+. macOS is used daily, Linux passes CI, Windows runs natively from 1.9.0 ([Windows](#windows)). Six interface [languages](#languages).

### From Claude Code: `/nb`

| Command | What it does |
|---|---|
| `/nb` | Opens the folder's window on its last session (or a new one); an open window comes to the front. |
| `/nb new` | Opens it on a fresh session. |
| `/nb fork` | Continues this conversation in the browser as a separate branch. |

The window is a background task of the Claude Code session: its output is the window's log; it stops with the task, the session, or **Stop Nota Bene** (⏻). The first `/nb` after installing or updating the plugin installs the npm package (about 330 MB per plugin version) and takes a few minutes.

### From a terminal: `nota-bene`

```sh
nota-bene [dir] [options]       # or: npx nota-bene-ide [dir] [options]
```

`dir` defaults to the current folder. Your home folder and `/` are refused (on Windows also a drive root `C:\` and a share root `\\server\share`).

| Option | Meaning |
|---|---|
| `--agent claude\|codex\|omp` | The agent (see [Which agent](#which-agent)); state is separate per agent. |
| `--port N` | Port N. Default: first free from 4777 to 4799, skipping 4780 and 4790–4795. |
| `--resume ID` [`--fork`] | Open this session, or with `--fork` a new branch of it. |
| `--new` | A fresh session (not with `--resume`). |
| `--detach` | Run on its own; print `opened URL` or `already-open URL`. Log: `$TMPDIR/nota-bene-PORT.log`. |
| `--no-open` | Do not open the browser. |
| `--url PORT` | Print the login URL of the window on PORT, for another browser. |
| `--front PORT` | Bring the window on PORT to the front, logged in. |

For a Codex or omp window, add `--agent codex` or `--agent omp` to `--url` and `--front`. Without `--detach` Ctrl+C (on Windows also closing the terminal) stops the window. Script helpers: `--find DIR [--scan]` (port of the live window on DIR, exit 1 if none), `--last DIR` (DIR's last session id), `--version`, `--help`.

<details><summary>More</summary>

The launcher supervises the server. **Restart the server** relaunches it at once, rebuilding the page first if web sources changed (a failed build keeps the old page until a source changes). A crash is relaunched after 1 s; after five within a minute it gives up. Example: `nota-bene ~/work/app --port 4800 --no-open`, then `nota-bene --url 4800` prints `http://127.0.0.1:4800/#t=...`.

</details>

### Which agent

Without `--agent` in a terminal, the launcher finds the agents that can start: Claude Code (`claude` on `PATH` or its config folder), Codex CLI 0.166.0+ and omp 18.16.0+ (by `--version`; `NOTA_BENE_CODEX` and `NOTA_BENE_OMP` name other executables). It never reads their login files. With several, it asks `Which agent for this folder?`: Enter takes the folder's last one (else Claude), a number or name picks another, Ctrl+C or Ctrl+D cancels. An agent below its minimum version is listed with the reason and not offered. Without a terminal (a script, `/nb`, `$nb`, `/skill:nb`) Claude starts unless `--agent` says otherwise. The choice is kept in `agent-choice.json`.

## One window per folder, one tab per window

A folder has at most one window per agent (Claude, Codex and omp can each have one). Launching again brings it to the front, waiting up to 10 s if it is restarting. A window has one owner tab: a second tab says "The window is already open in another tab", and **Work here** takes it over: the first tab shows "Open in another tab" and stops. A quick reload is not a second tab.

## Margin comments and the batch send

The core of the tool: review first, then send everything at once.

**Example.** The agent replies with a plan. Select "retry three times", click **Comment**, type `make this configurable`, press Cmd/Ctrl+Enter (Esc cancels): the fragment turns yellow and a card joins the **Comments** panel (Cmd/Ctrl+Shift+C). Select a line of another reply and click the quick label **Verify this**. Open `src/queue.ts` and comment on a function. Press **Send (3)** in the panel, or **Send** in the composer, which takes your typed text along. The agent gets one message, "Comments on fragments:", with each fragment, its source and your note. Sent comments are dimmed and tagged "sent".

- Comment on replies, your own messages, tool lines, subagent replies (sent to the main session), files, diffs, images, video frames, HTML pages and 3D models.
- Quick labels: Looks good, Love it!, Clarify this, Verify this, Give me an example, Missing overview, Match existing patterns, Consider alternatives, Ensure no regression, Out of scope, Needs tests. Most add an instruction for the agent.
- Emoji from the menu or a shortcode (`:+1:`); `@` works in the popup.
- Click a highlight to open its card; edit or delete there or in the panel. Popups drag by their header. Cards jump to the source; tabs and tree rows show counts.
- Comments persist per session. Changed text is marked "fragment changed" ("the file has changed since" for a file).
- **Voice clips.** With Whisper on, an empty comment field has a microphone: record, **Stop** adds the clip (up to 10). The agent gets each transcript after your text. A comment can be clips only.
- `/clear` is refused while comments are pending.

<details><summary>More</summary>

Esc while recording drops the clip, not the comment. **Add** waits for every transcript; a failed clip needs **Retry** or deletion. Cards show clips with play, wave and transcript.

</details>

## Images and video

### Attaching images to a message

Paste, drop or use the paperclip. Thumbnails open in a lightbox. The pen on a thumbnail opens the image in markup mode: draw, **Comment** (Enter), type. The agent gets the marked image and the note, which names it ("image 2"). Such a comment goes only with the message that carries its image.

<details><summary>More</summary>

Images are scaled to 1568 px on the long edge; a PNG over 3.5 MB becomes a JPEG. They are stored by content hash and sent as ids, so long histories reload fast. An image no longer in the draft (a reload, another device, removed) leaves its comment "image not attached" until **Attach again**. Removing an image with comments asks first. Needs protocol 17 or newer.

</details>

### Viewing and marking up images and video

Images open in a viewer (a click toggles natural size). Video and audio get a player with seeking, speed, volume, picture in picture and fullscreen. Leaving its tab moves a playing video to picture in picture, and audio keeps playing; closing the tab stops it. Video comments are ticks on the timeline; a click seeks there. Video and audio in chat replies get the same player, and their ticks open the file's tab at that time.

**Example.** Pause where the button looks wrong, press **Mark up** (N). Draw with Rectangle (R), Ellipse (E), Pen (P) or Arrow (A), colours 1–5 (red, yellow, green, blue, white), undo Cmd/Ctrl+Z. **Comment** (Enter), type `this button is misaligned`. Esc leaves (asking before dropping an uncommented drawing). The agent gets the frame with your marks; several comments on one frame make one image with numbered marks. Marks are saved under `.nota-bene/marks/` in the project, kept out of git.

| Player key | Action |
|---|---|
| Space, K | play or pause |
| Left, Right | seek by the bar's step |
| J, L | 10 s back or forward |
| Up, Down | volume 5 % |
| M / F | mute / fullscreen (video) |
| 0 to 9 | jump to 0–90 % |
| comma, period | one frame back or forward while paused |
| Home, End | start, end |
| N | mark up the frame |

### Images in the temp folder

An image the agent leaves in a temp folder (`/tmp/x.png`) is a link when its absolute path is in inline code, and a button on a tool line naming it. It opens like a project file, ready to mark up.

<details><summary>More</summary>

Only absolute paths in the system temp folders (`/tmp`, `/private/tmp`, `os.tmpdir()`, after resolving links), only images (png, jpg, jpeg, gif, webp, avif, bmp, svg), up to 50 MB, one at a time. No listing or search; nothing else outside the project is readable this way. A missing file says so.

</details>

## HTML pages and diagrams

An `.html` file opens as the page; **Page** / **Source** switch views. Images and stylesheets beside it load; project links open as tabs, web links in a browser tab. Scripts never run, because the window holds your access key ("scripts off" shows when a page needs them).

- Select text and comment, as in Markdown.
- **Mark** (N): click an element to comment on it (in a diagram, the nearest shape with its own tooltip, else its group), or drag inside an SVG to comment on an area, even an empty one. Esc leaves.
- Comments are outlined on the page; click one (or a large one's edge) for its card. After the agent edits the page, a comment finds its element by its text, or says "fragment changed".

Mermaid and SVG blocks in replies render as diagrams; **Open diagram** opens one full size in a tab.

**Example.** On `docs/map.html`, **Mark**, click the market and type `move it closer to the harbour`; drag a box between mill and market, type `a road is missing here`. The agent gets:

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

## Video edits (`.nbcut.json`)

A file named `<name>.nbcut.json` is an edit for the video editor (work in progress): video, photos and sound on tracks. It opens as a **Timeline**; **Source** shows its JSON. Video tracks are drawn top-down from the one on top of the picture, then the audio tracks. Each track header shows its name, gain and whether it is muted, solo or hidden. Clips sit at their time with the file name and a thumbnail (a photo, or a video's first used frame). The zoom buttons, or Ctrl/⌘ with the mouse wheel, zoom.

**Preview.** The frame above the timeline plays the edit as the export renders it: video tracks stacked (a later one on top), each clip at its `place`, sound mixed with gains, fades, mute and solo. Click or drag on the ruler, or drag the playhead, to scrub. An edit with problems does not play.

<details><summary>More: preview keys and behaviour</summary>

- Keys, with focus in the tab and not in a field: Space or K play/pause, J / L −10 / +10 s, ← / → the player's seek step, `,` / `.` one frame (pausing), ↑ / ↓ the previous or next clip edge on any track, Home / End the start and the last frame. The toolbar's buttons name their keys.
- A hidden track is not drawn, but its sound plays. Sound is off while scrubbing. While playing, the timeline scrolls to keep the playhead in view.
- Playback waits for a clip that is still loading or seeking; switching to another browser tab pauses it.

</details>

**Editing.** A valid edit of this folder is edited in place and saved to its file as you go (the bar above the timeline says *Saved*). Click a clip to select it; drag it to move it (also onto another track of its kind), drag an edge to trim it. Edges snap to the playhead, 0 and other clips' edges; hold Alt for none. Drag a video, sound or photo from Files onto a track, or below the tracks for a new one: the clip takes the whole file (a photo 5 s). The selected video clip's frame shows on the preview: drag it to move, a corner to resize (Shift: free proportions). The clip panel beside the preview has its numbers. **Undo** and **Redo** (⌘/Ctrl+Z, ⇧⌘/Ctrl+Shift+Z) step through your edits.

<details><summary>More: editing keys and rules</summary>

- Keys, with focus in the tab and not in a field: Delete or Backspace deletes the selected clip, S splits at the playhead (the selected clip, or every clip under the playhead), ← / → nudge the selected clip one frame (Shift: ten; with nothing selected they seek), Esc lets it go.
- Clips on a track never overlap: a moved, added or duplicated clip lands in the nearest free place on its track that holds it (after the last clip if no gap does); a trim stops at the neighbour, at the source's ends and at one frame of length. A split keeps the fade-in on the left part and the fade-out on the right.
- A track header renames on a double-click, and has M (mute), S (solo), H (hide the picture, video tracks), ↑ / ↓ (order among the tracks of its kind; up on a video track is over the picture) and × (remove with its clips).
- The clip panel: start, in and out (a photo: duration), gain, fades and mute of the clip's sound, and for a video track its frame and opacity in percent, with **Fit to frame** to fill the frame again. A value the format does not accept is marked and not applied.
- The file is the only state. When it changes on disk (the agent wrote it) and nothing is unsaved, the editor reloads it, keeping the playhead; undo starts again from that version. An edit made against an older version asks first: overwrite it, or take the version on disk. An edit with problems, or a view of another branch or worktree, stays read-only.

</details>

Problems are listed above the timeline by field (`clips[1].at: overlaps the clip before it on its track`), and the clips they concern are outlined. A source file that is not in the project is one of them; the rest of the edit is still drawn.

<details><summary>More: the format, for writing an edit by hand or by the agent</summary>

Times are seconds; `src` is a path relative to the project root, with `/`.

- Top level: `version` (always `1`), the output frame `width` and `height` in whole pixels from 16 to 8192, `fps` from 1 to 120 (29.97 is fine), `tracks` and `clips`.
- A track: `id` (unique), `kind` (`"video"` or `"audio"`), and optionally `name`, `gain` (dB, default 0), `mute`, `solo` (any solo track silences the tracks without it), `hidden` (a video track's picture is not shown; its clips' sound still plays). Video tracks stack in their order in `tracks`: a later one covers an earlier one.
- A clip: `id` (unique), `track` (a track's id), `src`, `at` (where it starts on the timeline). A video or audio clip takes `out` and optionally `in` (the used part of the source, `in` defaults to 0): it lasts `out - in`. A photo (png, jpg, jpeg, webp, avif, bmp) takes `dur` instead; a gif or svg is a problem, since the export cannot read it as a still (convert it to png). A source is a video (mp4, mov, webm, m4v), a sound (mp3, wav, m4a, ogg) or a photo by its extension; any other file is a problem. A sound file goes on an audio track only, a photo on a video track only. Optional: `gain` (dB) and `mute` for the clip's own sound, `fadeIn` and `fadeOut` (seconds of sound fade from each end; the picture never fades).
- On a video track a clip may have `place`: `x`, `y`, `w`, `h` as fractions 0 to 1 of the frame (top-left origin) and `opacity` 0 to 1. The picture fits inside keeping its aspect ratio. Without `place` it fills the frame. The box may run past the frame's right or bottom edge (`x + w` above 1): the part outside is cropped. A video file on an audio track contributes its sound only.
- Clips on one track must not overlap; clips on different tracks may.

A minimal edit: a video, a photo in the top-right corner for three seconds, a voice-over and quieter music.

```json
{
  "version": 1,
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "tracks": [
    { "id": "v1", "kind": "video", "name": "Main" },
    { "id": "v2", "kind": "video", "name": "Logo" },
    { "id": "a1", "kind": "audio", "name": "Voice" },
    { "id": "a2", "kind": "audio", "name": "Music", "gain": -12 }
  ],
  "clips": [
    { "id": "c1", "track": "v1", "src": "media/intro.mp4", "at": 0, "in": 2, "out": 8 },
    { "id": "c2", "track": "v1", "src": "media/street.mov", "at": 6, "out": 4 },
    { "id": "c3", "track": "v2", "src": "media/logo.png", "at": 1, "dur": 3, "place": { "x": 0.75, "y": 0.05, "w": 0.2, "h": 0.2, "opacity": 0.9 } },
    { "id": "c4", "track": "a1", "src": "media/voice.wav", "at": 0.5, "out": 9 },
    { "id": "c5", "track": "a2", "src": "media/music.mp3", "at": 0, "out": 10, "fadeIn": 1, "fadeOut": 2 }
  ]
}
```

The types are `Cut` in `shared/src/cut.ts`, and `validateCut` there is the check the timeline runs.

</details>

### Exporting an edit

An edit (`*.nbcut.json`) is exported by Export: pick video (MP4: H.264 and AAC at the edit's size and frame rate) or the sound mix alone (WAV or M4A). The file goes into the project as `exports/<name>.mp4` (`.wav`, `.m4a`), where `<name>` is the edit's file name without `.nbcut.json`; an earlier export of the same name is replaced only once the new one has finished. Progress shows while it runs, Cancel stops it, a failure shows ffmpeg's last lines, and the result is a link that opens the file in a tab. One export of an edit runs at a time. Every source of the edit and the output must be inside the project. Export sits at the right of the timeline's toolbar, for an edit of the session's project (not of another worktree or a revision); it is disabled while the edit has problems listed above the timeline, and the server refuses such an edit too (`validateCut`, the same check).

<details><summary>More: ffmpeg</summary>

Export needs ffmpeg on the machine: the path in `NOTA_BENE_FFMPEG`, else `ffmpeg` on `PATH`, else the usual places (Homebrew's `/opt/homebrew/bin` and `/usr/local/bin`, `/usr/bin`, `/snap/bin`; on Windows winget's, Scoop's and Chocolatey's folders, `Program Files\ffmpeg\bin` and `C:\ffmpeg\bin`). Without it the editor still works and Export says how to install it (`brew install ffmpeg`, `winget install ffmpeg`, `sudo apt install ffmpeg`); an ffmpeg installed later is found without a restart.

</details>

## 3D models (experimental)

`.glb`, `.gltf` and `.blend` open in a 3D viewer: orbit, zoom, reset view, animation clips, an info line. **Mark up** freezes the view to draw on; the comment keeps the camera pose, and its chip brings the camera back there. Off by default and not yet on Windows. Turn it on at server start (stop an open window on the folder first, or the variable is ignored):

```sh
NOTA_BENE_EXPERIMENTAL_3D=1 nota-bene .
```

<details><summary>More</summary>

`.blend` needs Blender: `NOTA_BENE_BLENDER`, else `blender` on `PATH`, else `/Applications/Blender.app/Contents/MacOS/Blender`. It converts in a locked-down mode (`sandbox-exec` on macOS), refuses files that reference outside the project, one at a time, 120 s at most; results go to `cache/blend/`. Models over 256 MB are not shown.

</details>

## Chat

Enter sends, Shift+Enter is a new line. The chat tab cannot be closed.

- A message sent while the agent works joins the running turn. Cmd/Ctrl+Enter interrupts and sends; while the agent works it asks first (Cmd/Ctrl+Enter again or **Interrupt and send**; Esc or **Cancel**; plain Enter joins the turn).
- The stop button stops the agent; Esc never does.
- Tool lines (`Read`, `Bash`…) open their full input and output; errors are red.
- Permission requests are cards (**Allow**, **Deny**). A plan is a card: **Approve** returns to the previous mode, **Keep planning** stays.
- Agent questions are cards with options (radio or checkboxes) and a free-text answer: **Send answers** or **Cancel**.
- The bar under the box shows context, the 5-hour and weekly limits, and the session cost when reported (on a plan, the API-price equivalent). Its buttons run `/compact` and `/clear`.
- **Idle compaction**: a conversation of 200,000+ tokens is compacted 50 minutes after its last turn (after 15 idle minutes in the window), so the cache is not wasted. Turn it off per project with its indicator, or `"idleCompaction": false` in `~/.claude/settings.json`.

### Voice messages

With Whisper on ([Settings](#settings)), an empty message field shows a microphone.

- **Click** it (or Alt+R): **Cancel** (Esc), **Stop** to listen first, **Send** (Enter or Alt+R). **Press and hold** (over 0.3 s) to record while held and send on release.
- It is its own message: the draft and images stay; pending comments go with it. It waits for a running turn. Recording stops and sends at 10 minutes.
- Your computer transcribes it; the agent gets only text. The bubble has play, a seekable wave, the transcript (**Aa** folds it) and, on failure, the reason and **Retry**. A badge such as FR marks another language.
- Without Whisper the microphone opens its settings. A denied microphone is reported under the field: allow it for the page in the browser.

<details><summary>More</summary>

Audio is 16 kHz mono 16-bit (about 1.9 MB a minute), kept as `attachments/<sha256>.wav`. Comments are taken when the upload leaves. An image alone does not hide the microphone; comments do not count as text. One voice plays at a time. **Clean unreferenced files** trashes unused recordings over a day old. Comments alone: **Send** in the Comments panel, or Enter in the empty field.

</details>

## The @ picker and the / menu

### `@` picker

`@` at the start of a word searches project files fuzzily (`@qcfg` finds `src/queue/config.ts`); Enter or Tab inserts, a folder opens inside, spaces get quotes. In a `!` command it inserts a shell-quoted path. Sent paths are clickable. Alt+E: recent files and file-name search.

### Prompt history

The field remembers this conversation's messages, `!` commands and voice transcripts, across `/clear`, forks, restarts and reloads.

- **↑** in an empty field: last prompt, older on repeat; **↓** newer, then empty.
- With a one-line draft, **↑** searches prompts containing it (like Ctrl+R); **↓** past the newest returns your draft.
- **Alt+↑** / **Alt+↓** (Option on a Mac) walk history whatever the draft.
- The clock button (Alt+H): a searchable list; Enter or a click fills the field, never sends.

<details><summary>More</summary>

Comment-only sends and the compact/clear buttons are not recorded; images are not recalled. Editing a recalled prompt ends the walk. A multi-line draft keeps normal arrows; in a multi-line recalled prompt the arrows step history only from the first or last line. An open `/` or `@` list keeps the arrows. A recalled `/command` does not open the menu. A typed draft comes back with Alt+↓ past the newest; the draft a prompt from the Alt+H list replaced comes back with ↓ (unless you edit the prompt).

</details>

### `/` menu

`/` as the first character lists the agent's commands and skills; Enter or Tab writes `/name `, Esc closes. Local command output (`/context`, `/usage`) shows as a reply.

- Listed: commands and skills the CLI allows outside a terminal (yours, project, plugin, MCP prompts), and "built-in" ones tested that way: `/compact`, `/clear`, `/context`, `/usage`, `/recap`, `/rename`, `/skill-doctor`, `/reload-skills`, `/list-agents`, `/dataviz`, `/claude-api`, `/simplify`, `/code-review`, `/verify`, `/run`, `/security-review`, `/loop`, `/update-config`, `/init`.
- Hidden: terminal-only commands, those that change model, effort, style or settings behind the UI (`/model`, `/effort`, `/output-style`, `/config`…) or need a terminal (`/mcp`, `/doctor`, `/color`). Typed by hand they still run; the header pills and Settings cover them.
- `/compact` and `/clear` are refused while the agent is busy (they cannot be queued); `/clear` also with pending comments. `/clear` keeps the old session in Sessions (**Archive previous session** hides it).

## Shell commands with !

A one-line draft starting with `!` is a shell command ("Shell · Enter runs", button **Run**). It runs in the project folder, streams output into the chat, and works while the agent is busy. Nothing is sent at once: the run goes in front of your next message in Claude Code's `!` format. After a failing `! npm test`, typing `fix the failing test` sends both in one message.

- No terminal, stdin closed: editors, pagers, `git rebase -i`, `sudo` and password prompts end with an error. Use a real terminal.
- One at a time; **Stop** ends it; 10 minutes at most. Not run with pending comments or images.
- A leading space sends `!…` as a message; multi-line drafts and `![` are always messages.

<details><summary>More</summary>

- macOS and Linux: `$SHELL -lc` for sh, bash, zsh, dash or ksh, else `/bin/sh`. Nota Bene's and Claude Code's own variables are not passed. Stop sends TERM to the group, KILL after 3 s; background jobs end with it.
- Limits: 32 KB command; the block shows the last 64 KB without ANSI colours; the agent gets the last 32 KB of stdout and stderr. Up to 10 runs wait (64 KB in all, newest kept, with a note). A `/command` message does not take them; a session switch or `/clear` drops them.
- Windows: Settings → Defaults → **Shell for ! commands**: **Auto** (Git Bash, else PowerShell 7, else Windows PowerShell 5.1), **Git Bash**, **PowerShell 7**, **Windows PowerShell**, **cmd**. Git Bash comes from `CLAUDE_CODE_GIT_BASH_PATH` or the Git for Windows of `git` on `PATH`, never WSL. A missing chosen shell is refused, not swapped. Git Bash runs `bash -lc`, PowerShell `-NoProfile`, `cmd` one line (join with `&`). The block names the shell; the agent is told when it was not Git Bash. Stop ends at once; a background process from PowerShell or `cmd` may survive. OEM code pages are decoded.

</details>

## Files, branches and worktrees

**Files** (Cmd/Ctrl+Shift+F) is the project tree: filter, refresh, collapse/expand all, reveal the open file (Alt+F1). It refreshes after each turn.

- Markdown renders and code is highlighted; both take comments. Alt+Z wraps. Code blocks have line numbers and a copy button.
- **✎** edits a text file; Alt+S or Cmd/Ctrl+S saves. Unsaved text survives closing and reloads; a change on disk meanwhile is never overwritten without asking. Other branches are read-only.
- Paths in `code` spans and links in the chat open files; missing ones are struck through.
- A video edit (`*.nbcut.json`) opens as its timeline; **Source** shows its JSON ([video edits](#video-edits-nbcutjson)).
- Files over 2 MB and binaries are not shown; **Open raw** serves the file as is.
- Tab menu: Close, Close others, Close to the right, Close all, Copy path. Middle click closes; Alt+W closes, Alt+Shift+T reopens.

### Other branches and worktrees

The header's branch button lists this folder, other worktrees and local branches, with search; rows show `↑N` commits, `✗` uncommitted work and a pulsing dot when a Nota Bene agent works there. Picking one shows it in the tree, Changes and log ("viewing", in orange) while the window and agent stay put; its files open read-only and comments remember the ref. A worktree's **Open** opens it in its own window. An absolute path the agent prints inside another worktree opens from that worktree.

**Switch** on a branch row moves the folder to that branch after a confirmation, carrying non-conflicting changes; git's refusals are shown, and it is refused mid-turn. Worktree rows have no Switch: git keeps a branch to one worktree. Tabs reload; the agent is not told. If Nota Bene runs from this folder, restart the server.

### Changes and the Git log

Both views only read: nothing commits, stages or reverts.

- **Changes** shows one changed file at a time (`‹ ›` between files, one or two columns), as a flat list or a **Tree**.
- **Show** picks the comparison: **Uncommitted** (default), **Whole branch from X** (X is the branch it was created from, else `origin/HEAD`, `main` or `master`) or any local branch; remembered per project and branch.
- **Git log** is the commit graph of all branches or the branch shown (latest 400), filtered by text, author or hash; a branch chip switches the view to that branch. A commit shows its message, files and diffs. Select diff text to comment (`src/queue.ts @ feature/retry`); a comment on a commit opens it in the log.

<details><summary>More</summary>

At most 3000 files and a 3 MB patch, with a note when cut. `node_modules`, `.nota-bene` and the state folder never show. If git does not answer, the last result stays. A comment on a removed line has no place in the current file.

</details>

## Subagents and background tasks

A subagent is a card with type, description and status; **Open** shows its conversation read-only and live (comments go to the main session). The message box always talks to the main agent.

The task indicator (Alt+T) opens **Tasks**: subagents, shell tasks and monitors with status, time, last tool and model. Per task: open, **Stop** (click twice), **To background**. Shell tasks open a live **Task output** tab. Parallel subagents group under one row with **Stop all**; a workflow lists its agents. The last 20 finished stay.

Stopping a Claude turn leaves background tasks running (stop them here); a call the turn waited on stops with it, and ↻ or a session switch ends all. With Codex and omp, Stop does what their agent does.

## Sessions and history

The chat tab's **▾** lists this project's sessions with a filter; pick one to switch in place, or **+ new session in this project**. An open window owns its conversation: don't write to it from another client meanwhile (the history gets mixed); use `fork` to carry one over.

- ✎ (or **Rename** in the tab's menu) renames, with the agent's own title.
- Archive hides a session from the list only; **Show archive (N)** → **Restore**.
- ✕ deletes for good, after a confirmation: the agent's own data (Claude Code: the transcript and its subagents' transcripts; Codex: the thread; not offered for omp) and what Nota Bene kept (history, sent prompts, comments). Never the open session or one open elsewhere.
- `/nb fork` or `--resume ID --fork` branches a conversation.
- **Show before compaction** loads history Claude Code no longer replays (`history/<sessionId>.jsonl`).
- **Restart the agent** (↻) keeps the session and works mid-turn, for a stuck turn. Its menu has **Restart the server** under the launcher. **Restart server · code updated** is for developing Nota Bene.

## Projects: switching, opening, creating

The project name in the header (Alt+P) opens the switcher, a chat-style list: one row per running folder with the last message, session, agent and state (*working*, *waiting for you*, *idle*, *restarting*, *not answering*). Type to filter. The path under the name copies on click.

A badge says what needs you: **!** when it waits (a permission, question or plan), else unseen replies (seen once on screen in a focused tab). The header button and tab title (`(!)`, `(3)`) sum the other projects. Waiting rows come first.

The **projects rail** on the window's left edge shows the same running folders as tiles, sorted by name so they stay put, each with its state dot and badge. Click one to switch; this project's is outlined, a dimmed one has no live window (its state is in the tooltip). **+** opens a folder. Turn it off in Settings → Defaults → **Projects rail** (for every window of this agent); narrow windows hide it.

- Choose a project to move this tab to its window, logged in. The arrow lists its sessions of every agent; **+ New session** asks which agent. Hover a session of this window to rename or archive it.
- **⏻** on a row stops that project's windows (not this one's).
- **Recent**: folders not running; **✕** removes one.
- **Open folder…**: a folder dialog (places, a clickable path, Tab completion, repositories first, **Show hidden**); pick the agent and **Open**.
- **New folder here** / **New project…** creates a folder (a git repository unless unchecked) and opens it. Names Windows refuses (`: * ? " < > |`, CON, a trailing dot) are refused everywhere.

## Permission modes, settings, languages

### Agent permission modes

The mode pill under the box, or Shift+Tab, cycles (saved per project; Codex and omp: [their modes](#codex-and-omp-what-is-supported)):

| Mode | Behaviour |
|---|---|
| Default | Asks before edits and commands. |
| Accept edits | Edits freely, asks before commands. |
| Plan | Reads and thinks, then shows a plan to approve. |
| Auto | A classifier approves safe actions, asks about the rest. |

The model pill in the header sets model and effort (**Auto**, Low … Max, as the model offers; arrows, Home, End step it), with `1M` for the 1M-context variant. Changes apply from the next reply; it warns when that re-reads the whole context. Long lists (OpenRouter) get search, grouped by provider.

**Stop Nota Bene** (⏻, right of the gear) stops every window after a confirmation that warns about running turns. The tab then stays stopped and does not reconnect; sessions stay, and `/nb` or `nota-bene` opens a window again.

### Settings

The gear: language, theme, interface scale (− +; Alt+=, Alt+−, Alt+0 anywhere), **Usage**, **Remote access**, **All settings…**:

- **Windows**: this agent's running windows (folder, port, state, tabs, uptime) with Open, Restart agent, Restart server, Stop.
- **Storage**: disk use; **Clean unreferenced files** moves unused images and recordings over a day old, and history of deleted sessions, to `trash/` (nothing is deleted).
- **Voice messages (Whisper)**: **Install Whisper** downloads the `whisper-small` model and its runtime from npm and Hugging Face (about 430 MB, 770 MB on disk) into the state folder after a confirmation naming the path; then no network is needed. A checkbox turns it on for every window of this agent, and their phones. **Spoken language**: detect automatically or pin one, also per agent. **Remove Whisper** keeps the recordings.
- **Defaults**: language, scale (90–150 %), the start mode for new projects, **Sounds** (a tab you are not looking at needs you: on; a turn ended: off; **▶** previews), the update check, the audit log, the projects rail, and on Windows the `!` shell.
- **Themes**, and **About** (version, state folder, logs, Node).

Icon buttons name themselves and their key in a tooltip.

<details><summary>More</summary>

Whisper runs in one background process shared by every window, loading at the first recording and unloading after 10 idle minutes; long recordings are transcribed in one-minute parts. Detection uses the first 30 s and falls back to the interface language. Sounds: a failed turn sounds lower, a stopped one not at all; one tab per window sounds; reloads never do; an untouched tab stays silent (a browser rule).

</details>

### Themes

**Darcula** (default), **Plannotator**, **Solarized Dark**; **IntelliJ Light**, **GitHub Light**, **Solarized Light**. Set in the gear menu or Settings → Themes, for all windows of this agent (`prefs.json`); a light theme stays light in a dark OS. Code, Mermaid and the logo follow it. Inline colour codes (`#ff8980`, `oklch(0.7 0.2 60)`) show a swatch.

### Languages

English, Russian, Simplified Chinese, Spanish, Brazilian Portuguese and German, from the gear menu, for all windows of this agent. English is the default whatever the browser says.

## Hotkeys

The full list is in the window's Hotkeys help. Tab keys use Alt because Chrome keeps Cmd/Ctrl+W, T and 1–9. On a Mac, Alt+letter does not fire inside a text field (Option types a character).

| Keys | Action |
|---|---|
| Alt+W / Alt+Shift+T | close tab / reopen closed tab |
| Alt+Left, Alt+Right | previous, next tab |
| Alt+1 to Alt+9 | tab N (1 the chat, 9 the last) |
| Alt+E | recent files and search |
| Alt+P | project switcher |
| Alt+H | prompt history list |
| Alt+↑ / Alt+↓ | older / newer prompt, any draft |
| Cmd/Ctrl+Shift+F / Cmd/Ctrl+Shift+C | Files / Comments panel |
| Alt+T | Tasks drawer |
| Alt+R | record a voice message; again to send |
| Alt+Z | wrap lines |
| Alt+S, Cmd/Ctrl+S | save an edited file |
| Alt+= / Alt+− / Alt+0 | larger / smaller / 100 % |
| N | mark up a frame, element or area; Esc leaves |
| Alt+F1 | reveal the file in the tree |
| / or Esc | focus the message box (outside text fields) |
| Shift+Tab | next permission mode (message box) |
| Enter, Shift+Enter | send, new line |
| Cmd/Ctrl+Enter | interrupt and send (while working: twice); add a comment in the popup |

Player and markup keys: [Images and video](#viewing-and-marking-up-images-and-video).

## Usage, updates and the audit log

### Usage

**Usage** (gear menu) counts tokens of every project on this machine from Claude Code and Codex transcripts, so outside work counts too. Nothing leaves the machine.

- Separate **Claude** and **Codex** counters; **Reset** starts anew (**All time** keeps the rest).
- **Weighted tokens**: input ×1, cache write ×1.25, cache read ×0.1, output ×5. A yardstick, not a price; hover for raw counts.
- **Limit hits**: charts of 5-hour windows over the weeks, red where a limit was hit, and a table listing each hit with what was spent in the 5 hours (or the week) before it; click a row for the tasks.
- **Tokens per 1%**: a table with one column per weekly window (the last 8) and rows avg 1% 5h and avg 1% weekly; a falling row means 100 % buys fewer tokens. Orange marks extra usage, with its tokens and cost.
- **Where it went**: the costliest **Tasks** (a message and all the agent did for it) and **Projects**; click a task for its subagents and costliest calls.

<details><summary>More</summary>

Each per-1% number averages from that window to the current one; a dash means no 5-hour readings that week. Codex keeps limit readings itself; Claude's (and hits passed on extra usage) are recorded only while a window is open. Empty periods are left out; data outlives deleted transcripts; temp-folder sessions are skipped. Hover a project for its subagent share.

</details>

### Updates

An installed window checks npm (at most once a minute per machine, and on returning to the tab; nothing about you is sent). A newer version shows `↑ <version>` with its changes; **Later** hides it.

- **Update** installs it beside the current one; the window restarts in a pause (nothing running, empty composer) on the same port and session. **Restart** does it at once.
- **Update automatically** (off by default, per machine) does this for every release.
- A failed install, no answer in 20 s or an exit in the first minute rolls back and shows `runtime/update.log`.
- Source checkouts never update; versions up to 1.6.0 update once by hand ([Updating](../README.md#updating)).

Turn the check off in Settings → Defaults (per agent) or with `NOTA_BENE_NO_UPDATE_CHECK=1`.

<details><summary>More</summary>

The answer is shared through `update-check.json`; changes come from the GitHub CHANGELOG once per version. Only the newest version seen on npm installs, never one the page names. With no page open the server restarts itself. The page reloads when its composer is empty, else offers **Reload**. **Restart** is off while something runs. Auto retries a failed install after an hour, a rolled-back one never.

</details>

### Audit log

Each window logs system events to `~/.nota-bene/audit/YYYY-MM-DD.jsonl`: server and page lifecycle, sends, stops, permission answers, mode and model changes, tool names, how turns ended, tasks, retries, errors (`port` and `pid` tell windows apart). Use it to learn later why a turn stopped. It never holds message, comment, command or tool text. Private, 14 days, 50 MB a day at most, never sent. Off in Settings → Defaults.

## Security

Nota Bene gives a web page the power to read your project and run an agent, so it lets in only you.

- **Local only.** The server binds to `127.0.0.1` and checks hosts and origins.
- **Access token.** `<state>/token`: 32 random bytes, mode 600, folder mode 700 (Windows: see [Windows](#windows)). Every route and the WebSocket need a credential derived from it. It is never on a command line, in the environment, a URL or a log; the agent and `!` commands do not get it.
- **Login.** The launcher opens a mode-600 page in `<state>/open/` that redirects to `http://127.0.0.1:PORT/#t=LOGIN` (a keyed hash of token, port and a per-launch value). The page trades it once for an HttpOnly, SameSite=Strict cookie `nb_<port>` and a key in local storage. The cookie alone opens only `GET /file` and `/attach/<id>`; the rest needs the key.
- **One launch.** The login dies with the launcher; a crash relaunch opens a fresh login page. **Restart the server** keeps it.
- **Another browser:** `nota-bene --url PORT`, which first checks the port is really your window.
- **Rotating:** delete `<state>/token` and restart, then reopen old windows: `--find` no longer recognises them, so until you do, `/nb` or a new launch on that folder starts a second window.
- **The state folder is never served**, even inside a project.

Residual risk:

- Any process running as you, the agent included, can read the token. The aim is to keep out other users and software that cannot read your files.
- Browsers send cookies to every `127.0.0.1` port: a local server on another port that you visit gets `nb_<port>` and can read open-project files (`/file`) and pasted images (`/attach/<id>`), nothing more, until the next launch.
- A token committed to git stays in its history. Do not make the state folder a repository.

<a id="remote-access-prototype"></a>

## Remote access

A paired phone reaches this computer's windows through a relay you run (`relay/`). Both sides connect out, nothing on the computer listens, and traffic is end-to-end encrypted: the relay sees only ciphertext and which phone talks to which host.

### From a window

A dot on the gear shows remote access: none (off), amber (connecting), green (online), red (failing; the **Remote access** row's tooltip says why). The row opens the **Remote** tab:

- **Access**: relay address, [access key](#access-key), the switch that lets phones in, state, the computer's fingerprint.
- **Pair a phone**: a QR code (or text, Copy), time left, fingerprint. A code pairs one phone; another is refused and named.
- **Phones**: each paired phone with **Revoke** (immediate).

With a relay saved and access on, the first window starts the connector and others share it, so the phone stays connected while any window is open. Only the computer can pair, revoke or switch access.

<details><summary>More</summary>

The connector stops a minute after the last window closes; log: `remote/connector.log`. A lasting refusal is retried after 1, 2, 5, then 10 minutes; a change in the tab retries at once. Only the pairing window shows the code.

</details>

### Access key

A relay may admit only invited computers: its operator gives you a key (`nbk1_…`). Enter it in the Remote tab or with `nota-bene remote key`; it stays on this computer (`remote/access-key`, yours only) and signs every connection. A key works on a few computers at once (3 by default).

- *The relay does not admit this computer*: the key is missing, mistyped or revoked.
- *This access key is already used on the most computers allowed*: close Nota Bene elsewhere (its connector stops a minute later); this one then connects by itself.

Running your own relay: `relay/README.md`, Access keys. A relay without `-members` admits anyone.

### From a terminal

`nota-bene remote` runs the connector in the foreground; windows use it. It turns access back on; the window's switch or a new relay stops it.

```sh
nota-bene remote --relay wss://relay.example.com   # run it (relay saved; later just `nota-bene remote`)
nota-bene remote pair                             # another terminal: a QR code, valid 5 minutes
nota-bene remote devices                          # paired phones: id, name, fingerprint, online
nota-bene remote revoke <id>                      # unpair; cut off at once
nota-bene remote status
nota-bene remote key                              # save the access key (hidden input); --clear removes it
```

- It reaches every window of every agent with their own credentials, which never leave the computer.
- `pair` prints both fingerprints; compare with the app. A new `pair`, Ctrl+C or 5 minutes end the code.
- **A paired phone is fully trusted**: it can do what a tab can, including **Work here**.
- One connector per user ("already running"); it also stops if the relay reports another with the same key.
- A project folder named `remote` opens with `nota-bene ./remote`.

### The Android app (prototype)

Run the Mobile workflow by hand (Actions → Mobile → Run workflow), download `nota-bene-android` and install the APK. Repository builds share a signing key, so updates keep pairings (fork debug builds do not). Needs Nota Bene 1.8.0+; a newer app hides what an older computer lacks.

- **Unlock** by the phone's biometrics, PIN or pattern; again after 5 minutes away. No screen lock, no app.
- **Pair**: `nota-bene remote pair` or the Remote tab, then *Pair a host* (or *Paste the code instead* with the `nbremote://` text); compare fingerprints.
- **Sessions**: one group per host, messenger-style rows with time, last message, a badge (unread or !) and a working dot. Pull to refresh; offline hosts show when last seen; a revoked phone can *Forget*; long-press renames a host locally. The last chat reopens.
- **One tab**: the phone is a tab of the window; *Work here* takes it, the computer can take it back.
- **Notifications** for finished replies and waits; a tap opens the chat. Not for the chat on screen; the lock screen says only "New reply in <project>". While an agent works or waits, and 5 minutes after, the app stays connected (a quiet notification, dismissable on Android 13+); otherwise it checks every 15 minutes. Android asks for the permission once, the first time an agent works; Settings → **Notifications** turns it off. Closing from recents disconnects, but the 15-minute check goes on. No Google push.

<details><summary>More: what the app does</summary>

- **Chat** as on the desktop (Markdown, code, formulas, zoomable Mermaid), with tool calls folded into "N actions"; long-press a message for labels, *Comment*, *Copy*, *Reply* or *Select text*.
- Messages wait for the turn, or *Send now* interrupts; *Stop* ends it. The header pill opens model, effort, mode and *Restart agent*; the context ring opens tokens, limits, cost, idle compaction, *Compact*, *Clear* and *Stats*. Permissions are sheets, questions cards; offline, history stays readable.
- **Panes** Files, Chat and Comments switch by tabs or swipe (side by side when wide); Markdown, images and video open full screen, other text up to 2 MiB read-only, and git *Changes* and *Log* show diffs.
- **Comments**: tap a paragraph, heading, list item, quote or table for the labels (a chevron shows all eleven), *Comment* (text, images, voice clips) or *Copy*; select text in files and diffs, or mark up images and video frames.
- "N comments to send" opens the Comments pane, where long-press edits, a left swipe deletes (*Undo*) and *Send* sends; typed and voice messages carry pending comments, and the desktop shows them too. Comments on HTML pages, 3D models and desktop-attached images stay on the desktop.
- **Images** zoom with a pinch or double tap; the paperclip offers *Gallery*, *File*, *Camera* and recent photos (up to ten). Videos play in the app.
- **Voice** (Whisper on at the computer): hold to record, slide left to cancel, slide up to lock (*Stop* → *Delete* or *Send*), release to send; up to 10 minutes, transcribed on the computer, the same for comment clips, in the **Automatic** or a pinned language.
- **Project icons**: long-press a session or open the window sheet for *Set icon* (camera or gallery, a 256 px square) or *Remove icon*; kept by Nota Bene on the computer, never in the project, and shown on every phone.
- **Settings**: the six themes, language, text size (85–150 %), interface size (90–130 %), voice language, notifications and paired hosts, all kept on the phone.

</details>

## Codex and omp: what is supported

Choose the agent at launch (`--agent codex`, `--agent omp`, or [Which agent](#which-agent)). Each keeps its own secrets, settings, windows, sessions and comments (under `providers/codex`, `providers/omp`; see [State on disk](#state-on-disk)). Nothing is converted between agents.

| Feature | Claude Code | Codex | omp |
|---|---|---|---|
| New, resume, fork, list, switch sessions | yes | yes | yes |
| Streamed replies, tool rows, comments, images | yes | yes | yes |
| `@` file search | yes | yes | no |
| `/` menu | commands and skills | skills, `/compact`, `/clear` | omp's commands |
| Permission and question cards | yes | yes, incl. MCP forms | shell, writes, `ask` |
| Model and effort | yes | yes | yes, by provider |
| Join a running turn; Stop | yes | yes | yes |
| `/compact`, idle compaction | yes | yes | no idle compaction; `/compact` only as omp's own command |
| `/clear` | yes | yes | yes |
| Meters | context, limits, cost | context, account limits | context, cost |
| Subagent tabs | yes | yes (child conversations) | no (progress text) |
| Tasks: stop / to background / output tab | yes / yes / yes | terminals / no / no | no |
| Rename / delete a session | yes / yes | yes / yes | open one only / no |
| Status | stable | stable | preview |

### Codex support

Needs Codex CLI 0.166.0+ (`NOTA_BENE_CODEX` picks the binary); an older one says so and starts nothing. Codex handles sign-in; the window offers sign-in or retry. Models and permission profiles apply from the next turn: **Codex config** inherits Codex's own settings; **Read only**, **Workspace** and **Full access** are explicit, and Full access turns off sandbox and approvals.

Gaps: no API to push a foreground tool into the background; no native next-prompt suggestions (none are invented); terminal tasks have no output tab; MCP device verification fails explicitly (form and URL requests work). No USD cost on ChatGPT, an empty context meter until Codex reports tokens, no invented pre-compaction count.

<details><summary>More: development checks</summary>

```sh
npx tsc -b && npm test && npm run build -w web && npm run e2e && npm run e2e:codex
NOTA_BENE_NATIVE_TEST=1 npx vitest run server/src/agent/codex/native.test.ts
```

The opt-in native test drives the installed Codex with a temporary `CODEX_HOME`, project and local Responses endpoint, with no paid calls: skill discovery, streaming, commands, history from another app-server, fork, and a terminal ending with its session.

</details>

### omp support

A preview, tested against a scripted omp. The window runs `omp acp` (omp 18.16.0+; `NOTA_BENE_OMP` picks the binary) with omp's own login, models and sessions; an older omp says so.

Modes are omp's approval levels: **Yolo** (default: only restricted folders and critical commands ask), **Write** (shell and exec ask), **Ask** (every write and exec) and **Plan** (read-only; writes ask). The start mode is set in Settings → Defaults; each project keeps its last. Moving between Yolo, Write and Ask/Plan restarts omp on the same conversation (refused mid-turn); Ask ↔ Plan is in place. Shell cards offer Allow, Always allow, Deny, Always reject.

`/skill:nb`, `/skill:nb new`, `/skill:nb fork` open a detached window (README, Install; from a checkout `ln -sfn "$PWD/omp/skills/nb" ~/.omp/agent/skills/nb`); **Stop Nota Bene** (⏻) ends it. Do not use the same conversation from an omp terminal meanwhile.

## State on disk

Everything is in `~/.nota-bene/` (`NOTA_BENE_HOME` to move it; `npm run dev` uses `~/.nota-bene-dev`), except media marks. Rows marked *per agent* are Claude's at the root and Codex's and omp's under `providers/codex/` and `providers/omp/`; the rest is shared by every agent.

| Path | Holds |
|---|---|
| `token`, `control-token` | *per agent*: the access token (delete to rotate) and the secret for controls between windows |
| `open/` | *per agent*: short-lived login pages |
| `sessions.json` | *per agent*: each folder's last session |
| `prefs.json` | *per agent*: mode per project, language, theme, Whisper on and spoken language |
| `comments/<sessionId>.json` | *per agent*: comments |
| `attachments/<sha256>.<ext>` | *per agent*: pasted images and recordings (`.wav`) |
| `windows/<port>.json`, `locks/` | *per agent*: running windows, launch locks |
| `history/<sessionId>.jsonl` | *per agent*: conversation before each compaction |
| `cache/blend/` | *per agent*: converted `.blend` files (safe to delete) |
| `trash/` | *per agent*: what Storage → Clean moved |
| `agent-choice.json` | each folder's last agent |
| `recent.json`, `recent-hidden.json` | the switcher's Recent folders, and those removed with ✕ |
| `project-icons/` | project pictures set from the phone |
| `update-check.json`, `runtime/` | the newest npm version; [updates](#updates) installed, with state and log |
| `audit/YYYY-MM-DD.jsonl` | the [audit log](#audit-log) |
| `usage/` | Usage counts and short labels (64 characters of a prompt, a subagent's description) |
| `remote/` | `host.key` (delete to unpair every phone), `devices.json`, `config.json`, `access-key` (all mode 600), `control.sock` (Windows: a named pipe and `control-secret`) |
| `whisper/`, `whisper-host/` | the model; the shared process's socket (Windows: pipe and `host-secret`), lock and log |

On Windows `~` is `%USERPROFILE%` and the folder must stay inside it ([Windows](#windows)). The only thing written into a project: `<project>/.nota-bene/marks/<comment id>/frame.jpg` and `layer.png`, with a `.nota-bene/.gitignore` of `*`.

## Windows

Native, no WSL or Docker. Differences:

- **Needs** Node.js 22+ (checkout: 23.6+). [Git for Windows](https://git-scm.com/download/win) recommended: its Git Bash gives Claude Code the Bash tool; without it Claude Code uses PowerShell and the first message says "Git Bash recommended". Looked for in `CLAUDE_CODE_GIT_BASH_PATH`, beside `git` on `PATH`, then `Program Files\Git`. Codex and omp are found as `.exe` or `.cmd`; npm's Codex starts its bundled `codex.exe`; `NOTA_BENE_CODEX` and `CODEX_CLI_PATH` may name a `.exe`, `.cmd` or `.js`.
- **Starting**: `nota-bene` in PowerShell or `cmd`, `/nb` in Claude Code. Ctrl+C or closing the terminal stops it; killing the launcher in Task Manager takes its server along. `--detach` logs to `%TEMP%`.
- **`!` commands**: see [Shell commands with !](#shell-commands-with-).
- **State folder**: no file modes, so your profile's access rights keep it private. It must be inside `%USERPROFILE%`; elsewhere (`D:\nb`) it is refused unless you restricted it yourself and set `NOTA_BENE_ALLOW_SHARED_HOME=1`. Links or junctions in place of private files are refused.
- **Paths** show as `C:/Users/...`; `src\a.ts` and `src/a.ts` open the same file, `%TEMP%` images open in either form (elsewhere a backslash is part of a name); a drive-root project works. Tips name Ctrl.
- **Voice and remote** use named pipes with secret files (`whisper-host/host-secret`, `remote/control-secret`); restart a running connector if `control-secret` is replaced.
- **Not yet**: 3D models and `.blend` conversion.

## Troubleshooting

**Starting**

- **`/nb` fails with an apostrophe in the path** (`/Users/o'brien`): use `npm i -g nota-bene-ide` and `nota-bene`.
- **"cannot write to the plugin data dir ... sandbox mode"**: allow writes to that folder in Claude Code's sandbox settings, or turn the sandbox off for `/nb`.
- **"port N is in use"**: another `--port`, or none. "no free port": stop a window in Settings → Windows.
- **`nota-bene . &` stops with its shell**: use `nota-bene . --detach`.
- **"This window is not logged in"** (a bookmark, an old tab, after a crash relaunch): run `nota-bene` or `/nb` again, or `nota-bene --front PORT`; `--url PORT` prints a URL.
- **A refused token file** (readable by others, a link, another user's, not 64 hex): follow the printed fix (``chmod 600 <file>``, or delete it, which logs every window out). Same for `control-token` and a state folder owned by someone else (set `NOTA_BENE_HOME`). On Windows only links, folders and bad content are refused: delete the file.

**Running**

- **Interactive commands** (`sudo`, logins, vim, pagers) get empty input in `!` and in the agent's shell: use a real terminal.
- **3D files open as plain files**: turn on [3D models](#3d-models-experimental).

**Windows only**

- **"the state folder ... is outside your user profile"**: unset `NOTA_BENE_HOME` or point it inside `%USERPROFILE%` (case-insensitive, junctions followed); or, if only you can read it, set `NOTA_BENE_ALLOW_SHARED_HOME=1`.
- **"PowerShell 7 is not installed (Settings → Defaults → Shell for ! commands)"**: install it or choose another shell or Auto.
- **"Git Bash recommended"**: install Git for Windows or set `CLAUDE_CODE_GIT_BASH_PATH` to `bash.exe`, then restart.
- **A file is in use (`EPERM`, `EBUSY`)**: antivirus or the indexer held it past the 2-second retry. Retry, or exclude the state folder from scanning.
