# Projects as a chat list (2.0.0)

Issue #386; follows phase 1 of the one-tab design (`2026-11-15-one-tab-projects-design.md`, #384). Of two mockups (A: header menu as a chat list; B: left column of projects) A is chosen.

## Why

With every project in one tab, nothing says another project needs the person or has finished until they open the switcher. The switcher becomes a messenger-style list: each project shows what happened last and a badge for what is new. The header's Sessions menu goes; sessions become the second level under their project.

## Goals

- One row per project (folder): folder name, time of last event, last reply on one line, the window's session and agent below, a state dot.
- One badge per row by priority: `!` when it waits for the person (question or permission), else the count of unseen replies; none when both are zero.
- The header's project button carries one badge by the same rule over all other projects; so does the tab title (`(!) Nota Bene`, `(4) Nota Bene`).
- Sort: waiting first, then unseen replies, then the rest; newest event first within a group.
- A project expands to its sessions (all agents of that folder, each marked with its agent), "New session" and "Archive (N)". Rename, archive, delete on a session row on hover as in today's Sessions menu.
- A session of this window switches as today (confirm while the agent works). A session of another running window moves the tab there and that window opens it. A session of a folder with no running window is not listed in this phase (folder shows under Recent).
- Above the chat one line names the session (`● Fix the login form ▾ · Claude`); click opens this project's sessions. It replaces the header's Sessions button.
- A worktree row in the branch menu gets "Open": opens (or reaches) a window on that worktree through the starter's open route.

## The folder browser (starter)

The starter becomes a familiar "Open folder" dialog, one mode instead of two:
- Places left: Home, parent folders of recent projects (deduplicated, max five), Desktop if present.
- Path on top as clickable breadcrumbs; a path field completes the folder name with Tab and browses on Enter.
- List: git repositories first, then other folders, each by name. Single click selects, double click or Enter goes in; Open opens the selected folder or the current one.
- "New folder here" replaces the New project mode: an inline row asks name and git init (default on); confirming creates and opens it as the create route does. The header's "New project…" opens the starter with that row shown.
- A reopen starts from the last browsed folder, hidden folders off; a late listing never replaces a newer one. Names Windows refuses (`:*?"<>|`, CON and the like, trailing dot or space) are refused before sending.

## Non-goals

Left column of projects (variant B): with phase 2; renaming a project (name is the folder's; later); listing sessions of a folder with no running window; browser system notifications; the phone's unread counts stay its own.

## Unseen replies

A window already reports in `/info` the reply count of its current session and the last message (`hub.summary()`). A reply is seen when a page shows that session while visible and focused. The window keeps, per session id, the time it was last seen; unseen = replies after it (a time, not a count, because compaction drops replies), persisted in the state dir. Known limit: a reply replayed from the transcript has no time, so replies before a window/agent restart or a switch back count as seen; later ones count again. `/info` adds `unseen`. Only a window's current session can gain replies, so its count is the row's count; a session left with unseen replies keeps its count in the session list.

## Folder rows over windows

Phase 1 lists windows. A folder with two windows (two agents) is one row: state = most urgent, badge = sum, last event = newest; expanding shows sessions of both. A click goes to the window with the newest event, or this one if it is in the folder.

## Calls made (correct if wrong)

A project is a folder, not a window; no project-icon avatars this phase (another window's icon needs its login), a coloured letter tile stands in; sessions of another window come through this server, which asks that window with its helper bearer as the projects list does.

## Left to the builder

Poll cadence (phase 1: 3 s open, 10 s closed), the socket message for visibility, the seen store's shape, exact layout within the mockup's frame.
