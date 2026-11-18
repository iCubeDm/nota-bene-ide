# M6 Workspace & Polish Implementation Plan

**Goal:** Act on the user's first-day review of the rebuild (2026-10-26). Three packages: A, polish (restore what the prototype did better); B, workspace (an IntelliJ-style frame: tool strips, tab overflow, recent files, hotkeys, file-type icons); C, settings (a Settings tab for everything outside a session). M2 (agents) comes after and lives on the new right strip.

**Spec:** `docs/superpowers/specs/2026-10-24-nota-bene-rebuild-design.md` (Follow-ups). The prototype (`prototype/public/index.html`, read only) is the look-and-feel reference. Base: branch `m6-workspace` from `main`.

M0-M5 rules hold (trailer `Task: M6-NN`, strings via `t()` in ru and en, tests on ports 4790-4795 only, smoke follows the CLAUDE.md hygiene). The user works in the app: a `web/` change reaches them after `npm run build -w web` and a reload; a `server/` change needs "Restart the server" after the check in CLAUDE.md.

## Rulings from the review

- **R-M6-1 Colour.** Restore the prototype accent `oklch(0.70 0.20 60)` as a distinct token `--nb-accent`. Cause: shadcn uses `accent` for its grey hover background, which turned every prototype accent grey. Every prototype `var(--accent)` maps to `--nb-accent`.
- **R-M6-2 Sizing** (revised by the user, 2026-10-26, once panels docked): prose (chat, md) keeps the prototype's 860 px; code is up to 256 characters a line; both leave a 1.5rem margin in a narrow column. Media is centred and fitted (`max-width:100%; max-height: calc(100% - margin)`), a click toggles natural size. (The first version made width relative to the viewport; rejected.)
- **R-M6-3 Strips.** Two thin IntelliJ-style tool strips (user, 2026-10-26: panels are docked, narrow the middle column, open by default; strips and panels run the full height under the header). Left: Files (later Structure). Right: Comments (later Agents, M2). An icon click toggles its panel; the header's Comments button goes away.
- **R-M6-4.** Settings is a tab like a file tab, opened by a gear button next to the language toggle.
- **R-M6-5 Hotkeys.** Chrome reserves Cmd/Ctrl+W/T/1-9 and Ctrl+Tab, so:

| Key | Action |
|---|---|
| Alt+W | close tab |
| Alt+Shift+T | reopen closed tab |
| Alt+Left/Right | previous/next tab |
| Alt+1..9 | tab N (1 = chat; 9 = last tab as in Chrome) |
| Alt+E | recent files + search (was Cmd/Ctrl+E; Claude in Chrome takes Cmd+E, user 2026-10-27) |
| Cmd/Ctrl+Shift+F | toggle Files |
| Cmd/Ctrl+Shift+C | toggle Comments |
| Alt+F1 | reveal the current file in the tree |
| `/` or Esc on empty space | focus the composer |

The list appears in the `?` help.

## Package A: polish

- **M6-01 Colours back.** Add `--nb-accent` to `web/src/theme.css` plus a Tailwind token. Audit and map every prototype `--accent` use (comment card quote stripe, user-bubble comment quotes, file-ref underline, quick-label chip hover, working dot, pending badge tones). Compare the markdown palette with prototype `.md` rules (inline code, links `--primary`, headings, blockquote, hljs theme); restore differences subtly. Test: computed style of the quote stripe uses the accent; contrast check.
- **M6-02 Selection button appears in place.** The comment button must not animate its position: drop `transition-all` for `left/top` or keep it hidden until positioned. Tested.
- **M6-03 Meters and footer buttons.** Prototype tooltip colours (popover background, 11.5 px, muted text); tooltips trigger over the whole button including disabled compact/clear (wrap them); restore the prototype's compact and clear icons (SVG paths from the prototype).
- **M6-04 Widths and media fit.** Chat and md use the prose width, code the code width (centred card); panes get the same grid background as the chat (user: the grey background was missing); images and video fit the pane with click-to-natural-size; audio unchanged (the user likes it). Tests: computed widths at 1440 and 2560.
- **M6-05 `:` emoji picker in the composer.** Mount ShortcodePicker on the composer, keeping the Esc/Tab/Enter contracts with the `@` picker and the suggestion Tab; real-keyboard e2e (`keyboard.type(':smi')`).
- **M6-06 Markdown in user messages and comments.** User bubbles and comment text (cards, batch details) render through sanitised `Markdown`. Anchors on user messages keep working (text model from the rendered DOM); old comments re-anchor via the quote fallback (tested).
- **M6-07 Quick labels: emoji only.** Popup and card chips show only the emoji; label text moves to a tooltip and aria-label.
- **M6-08 Git branch in the header.** Path followed by `(main ✔)` or `(feature/x ✗)` when dirty. Server: `/sources` (or `/info`) adds `here: {branch, dirty}` via `git status --porcelain`, `-c core.fsmonitor=false`, the hardened git env, cached 5 s, refreshed after each live turn. Not a repo: show nothing.

## Package B: workspace

- **M6-09 Tool strips (R-M6-3).** Left strip about 36 px with the Files icon; right strip with the Comments icon and pending badge. Panels dock next to their strip, open state persisted. The header's Comments and Files buttons are removed.
- **M6-10 Tree header actions (done).** Next to the refresh button: "Reveal current file" (IntelliJ "Select Opened File"), "Collapse all", "Expand all". Expand all lazy-loads one level at a time with a cap of 2000 rows: after review, folders open breadth-first only while their rows fit, at most 8 listings fetched at once, refresh and loading touch only shown folders. Ruling (2026-10-26): it never opens `node_modules` or `.git` (they would eat the cap before the project's own folders; a click still opens them). "Reveal in tree" is removed from the tab context menu (it belongs in the tree header).
- **M6-11 File-type icons (done).** Small built-in set by extension and well-known names, in the tree, tabs, `@` picker and recent files: `.ts/.tsx/.js/.mjs/.json/.md/.css/.html/.py/.sh/.yml/.toml`, images, video, audio, `package.json`, `README`, `.gitignore`, `Dockerfile`, folders open and closed. IntelliJ-like colours, inline SVG, no new dependency (a third-party set would have to be MIT, vendored, licence noted).
- **M6-12 Tab overflow (done).** No horizontal scrollbar; the wheel scrolls the strip and the active tab scrolls into view. A "▾" button lists all tabs with search. Ruling (2026-10-26): "▾" is always shown, not only on overflow (it doubles as a searchable list; no layout probe needed).
- **M6-13 Recent files (done, Alt+E).** Modal with this root's recently opened files (persisted, up to 50) and a search field; empty query shows recents, typing searches the project through `/complete`. Keys: up/down, Enter, Esc; the previous file is preselected so Alt+E, Enter flips back (IntelliJ). File-type icons. The key listener lives in RecentFiles until M6-14's keymap takes it.
- **M6-14 Hotkeys (done).** One keymap module (no scattered listeners) that respects the Esc protocol and text fields (Alt combos work in fields, `/` does not); the `?` help lists every hotkey; a test per binding. Rulings (2026-10-26): Alt+Left/Right do not fire in a text field (Mac word jump); after the Package B review Option+letter/digit on a Mac fire outside text fields only (non-US layouts type `[ ] { } |` with Option), and behind a modal only Alt+E runs; Esc focuses the composer without consuming the key (it still stops a busy agent); the help is the composer's `?` tooltip, generated from the keymap.

## Package C: settings

- **M6-15 Settings tab (done, R-M6-4).** The gear opens one unique `settings` tab. Sections:
  - Windows: every running window (registry + `/info`), with folder, session title, port, uptime, tab connected or headless, busy, and actions open / restart agent / restart server / stop. Stop confirms and refuses the current window.
  - Storage: sizes of `attachments/` and `comments/`; "Clean unreferenced attachments" shows a dry-run count first and moves files to the trash rather than deleting.
  - Defaults: language; default permission mode for new projects.
  - About: version (git describe), state dir, log paths.
- Routes: `GET /system/windows`, `GET /system/storage`, `POST /system/storage/clean` (Origin-checked).
- Rulings (2026-10-26):
  - Cross-window control: window A's page asks A's server (`POST /system/windows/action`, Origin-checked), which relays to B's `POST /control/<action>` with the per-user token `<stateDir>/control-token` (mode 600). `/control/` refuses any request with an Origin and any without the token; a relay goes only to a registered window whose pid is alive and whose `/info` answers with the registered root. Never kills a pid directly. The current window's own actions stay in its header (409 here). (The first idea, a `POST /shutdown` per window, became this relay.)
  - Clean: attachments that no comments file mentions and older than 24 h (a draft may hold a fresh one; the server cannot see drafts) move to `<stateDir>/trash/attachments/<stamp>/`. Transcripts are not scanned: a replay re-creates any transcript image under the same content id.
  - No prototype port scan: the prototype is retired and no prototype window is left.
  - Logs: only the detached launcher's `$TMPDIR/nota-bene-PORT.log` is a file; a foreground window's log is its Claude Code task, said so in About.
  - The Settings tab is not saved with the file tabs.
  - After the security review: an action carries the row the user saw (root, pid, startedAt) and is refused (409) if the port's registry entry changed; a trashed attachment is restored on its next read and a reused one counts as fresh, so Clean is reversible; any action on a busy window asks first and the row's buttons are off while one is in flight; probe and relay never follow redirects; the token file appears atomically (tmp + link).
- **M6-16 e2e and smoke.** e2e for strips, tab overflow, Alt+E, hotkeys and the Settings tab (`e2e/workspace.spec.ts`, done). A smoke in the user's real window happens after the merge: the user reloads and they go through the list together (open).
