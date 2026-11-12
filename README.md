<p align="center"><img src="https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/web/public/icon-512.png" width="128" alt="Nota Bene"></p>

<h1 align="center">Nota Bene</h1>

<p align="center">
  <strong>An agentic development environment (ADE) in your browser: review and steer your coding agent.</strong><br>
  Select any fragment of the chat with an agent or of any file, leave a comment in the margin, send all the comments as one batch.<br>
  Works with <strong>Claude Code</strong>, <strong>Codex</strong> and <strong>omp</strong>.
</p>

<p align="center">
  <a href="#supported-agents">Supported agents</a> ·
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#updating">Updating</a> ·
  <a href="https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md">Guide</a> ·
  <a href="https://github.com/iCubeDm/nota-bene-ide/blob/main/CHANGELOG.md">Changelog</a>
</p>

![Selecting text in a reply, adding a comment and sending it](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/annotate-text.gif)

Nota Bene brings your agent into a window made for review: margin comments on replies, code, images and video frames, a file tree with viewers, Git, sessions and usage. It runs the agent you already have, with its own login, models and sessions.

## Supported agents

| Agent | Models | Needs | Open a window from the agent | Status |
|---|---|---|---|---|
| **Claude Code** (default) | Those of your Claude Code: Opus, Sonnet, Haiku | Claude Code, logged in | `/nb` ([plugin](#install)) | Stable |
| **Codex** (CLI and local Desktop) | Those of your Codex account (ChatGPT or API key) | Codex CLI 0.166.0+, `codex login` | `$nb` ([plugin](#install)) | Stable; [a few native gaps](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md#codex-support) |
| **omp** | Any provider set up in omp | omp 18.16.0+, logged in | `/skill:nb` ([skill](#install)) | Preview; [limits](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md#omp-support) |

No agent session is needed to start a window: in a plain terminal, `nota-bene` starts the agent itself, with the agent's own login. When more than one agent is installed it asks which (Enter takes the one last used in the folder); `--agent claude|codex|omp` skips the question. Each agent has its own windows and saved settings; two agents can work in the same project.

| Platform | |
|---|---|
| macOS | Tested, used daily |
| Linux | Unit tests pass in CI; not used daily |
| Windows | Not supported (the launch skills are bash scripts) |

Every install needs Node.js 22 or newer. The interface is in English, Russian, Simplified Chinese, Spanish, Brazilian Portuguese and German.

## Install

<details open>
<summary><strong>Claude Code plugin</strong> (recommended)</summary>

In Claude Code:

```
/plugin marketplace add iCubeDm/nota-bene-ide
/plugin install nota-bene@nota-bene
```

Then, in any project folder, type `/nb` (`/nb new` for a fresh session, `/nb fork` to carry the current conversation over). The first `/nb` installs the `nota-bene-ide` npm package (about 330 MB, mostly the Agent SDK's binaries) into the plugin's data folder and opens the window. If another skill is also called `nb`, use `/nota-bene:nb`.

</details>

<details>
<summary><strong>Codex plugin</strong></summary>

From a terminal:

```sh
codex plugin marketplace add iCubeDm/nota-bene-ide --ref main
codex plugin add nota-bene@nota-bene
```

Reload skills or restart Codex, then use `$nb`, `$nb new` or `$nb fork` (or pick nb in the Desktop skill picker). The first use downloads the package through npm (about 70 MB, without the Claude Code binary). A window started from Desktop keeps running after the chat turn ends; **Stop window** (⏻) in its header shuts it down.

Without the plugin: `npm i -g nota-bene-ide` (add `--omit=optional` if you only use Codex), then ask Codex:

```text
$skill-installer Install the nb skill from https://github.com/iCubeDm/nota-bene-ide/tree/main/codex/skills/nb
```

</details>

<details>
<summary><strong>omp</strong></summary>

Install the launcher and link its skill into omp:

```sh
npm i -g nota-bene-ide
ln -sfn "$(npm root -g)/nota-bene-ide/omp/skills/nb" ~/.omp/agent/skills/nb
```

Then use `/skill:nb`, `/skill:nb new` or `/skill:nb fork` in omp, or open a window from a terminal with `nota-bene . --agent omp --detach`.

</details>

<details>
<summary><strong>Terminal, any agent</strong></summary>

```sh
cd your-project
npx nota-bene-ide                   # Claude
npx nota-bene-ide . --agent codex   # or omp

# or install the command once
npm i -g nota-bene-ide
nota-bene
```

</details>

An open window owns its conversation: don't keep writing to it from another client meanwhile; use `fork` to carry one over.

## Quick start

1. Open a window on a project folder in either of two ways: from your agent's session (`/nb` in Claude Code, `$nb` in Codex, `/skill:nb` in omp), or from a plain terminal in that folder with `nota-bene` (no agent session needed; Nota Bene starts the agent itself and, when more than one is installed, asks which). The browser opens on the window, already logged in.
2. Ask the agent something. When the reply arrives, select a sentence in it and press **Comment**. Type the note and press Cmd/Ctrl+Enter to add it.
3. Open a file from the **Files** panel, select a line of code, and comment on that too. Comments from every reply and file collect in the **Comments** panel.
4. Press **Send (2)**. The agent receives one message that lists each fragment with your note on it.

The same works on code:

![Commenting on a line of code](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/annotate-code.gif)

on images, where you draw on the picture and the marked picture goes to the agent:

![Marking up an image](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/annotate-image.gif)

and on single frames of a video:

![Marking up a video frame](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/annotate-video.gif)

## Features

**Review**
- Margin comments on any reply, on your own messages and on any open file, sent as one batch. Eleven one-click labels (Looks good, Clarify this, Verify this, and others).
- Markup on images and video frames with a rectangle, ellipse, pen or arrow, and a comment on the marked frame.
- HTML pages render in a tab: comment on their text, on an element, or on an area of an SVG diagram.

**Chat**
- A message sent while the agent works joins the running turn; Cmd/Ctrl+Enter interrupts the agent and sends, after a confirmation.
- `@` mentions a file, `/` opens the agent's commands and skills, `!` runs a shell command in the project folder.
- Subagent conversations in their own tabs, and a drawer for background tasks.
- Agent permission modes, model and effort, context, 5-hour and weekly plan-limit meters in the same order for Claude and Codex. Questions from the agent are cards you answer in the window.
- Voice messages: record in the message field and your computer transcribes it with Whisper (installed from Settings, off by default); the agent gets the text. Comments can be voice clips too.
- Prompt history: ↑ / ↓ bring back what you sent, and a searchable list finds older prompts.

**Files and Git**
- File tree and viewers: Markdown, highlighted code, images, video and audio with seeking. Mermaid and SVG diagrams render in the chat.
- Edit a text file by hand, without overwriting a change made on disk meanwhile.
- A branch picker over other worktrees and branches, a Changes view and the Git log, all read-only.

**Sessions and usage**
- Sessions from any folder, branches of a conversation, the history from before each compaction.
- A Usage tab: tokens across every project and agent, limit hits and what was spent before them, extra usage.
- An audit log of each window's system events (never what anyone wrote), for working out later why a turn stopped.
- [Updates itself](#updating), with one click or automatically.

**Remote control (prototype)**
- An Android app drives your windows from a phone, through a relay you run yourself, end-to-end encrypted: chat, files and Git changes, comments, images and voice messages. Pair it with `nota-bene remote pair`; see [Remote access](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md#remote-access-prototype).

![The window: chat, file tree and comments panel](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/overview.png)

<details>
<summary>More screenshots</summary>

![The slash menu](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/slash-menu.png)

![A Codex window: model, approval card, sandbox profile and account limits](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/codex.png)

</details>

## Updating

From 1.7.0 on, a window updates itself. When a newer release is out, the header shows `↑ <version>`: **Update** installs it, and the window restarts in a pause (no turn running, nothing in the composer, no question or approval waiting) with the same session; **Update automatically** does this by itself for every new release (off by default; per machine). If the new version does not start, the window goes back to the one before and says so. A source checkout never updates.

Versions up to 1.6.0 cannot do this, so update them once by hand, with the block for how you installed it:

```sh
# terminal
npm i -g nota-bene-ide@latest
```

```sh
# Claude Code plugin; then restart Claude Code
claude plugin marketplace update nota-bene
claude plugin update nota-bene@nota-bene
```

```sh
# Codex plugin
codex plugin marketplace upgrade
codex plugin add nota-bene@nota-bene
```

Then close the old windows and open them again. A window started by `/nb` is a background task of that Claude Code session (stop it in `/tasks`); a terminal window stops with Ctrl+C. Versions after 1.7.0 also stop from the window itself: **Stop window** (⏻) in its header. Your sessions, comments and settings stay in place. See [Updates in the guide](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md#updates).

## Guide

Starting options, every feature with an example, the security model, where state is kept and troubleshooting: [the guide](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md). How it is built: [architecture](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/architecture.md).

## Contributors

- [Milos Marinkovic](https://github.com/milosmns): the omp backend over ACP (1.5.0).

## Licence

Apache-2.0. See [LICENSE](https://github.com/iCubeDm/nota-bene-ide/blob/main/LICENSE) and [THIRD-PARTY-NOTICES.md](https://github.com/iCubeDm/nota-bene-ide/blob/main/THIRD-PARTY-NOTICES.md).
