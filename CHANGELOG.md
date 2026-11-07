# Changelog

## Unreleased

- Windows update themselves from this version on: **Update** in the header installs the newest release and restarts the window in a pause (no turn, no question, no running command), with the same session, and the open page reloads to the new version; **Update automatically** (off by default, per machine) does it for every release. A new version that does not start is rolled back. npm is asked once a minute per machine. Versions up to 1.6.0 cannot do this: make the last manual update once, see [Updating](README.md#updating).

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
