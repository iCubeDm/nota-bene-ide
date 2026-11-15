# Projects as a chat list (2.0.0)

Issue #386; follows phase 1 of the one-tab design (`2026-11-15-one-tab-projects-design.md`, #384).
Of the two mockups (A: the header menu as a chat list; B: a left column of projects) A is chosen.

## Why

With every project reachable from one tab, nothing tells the person that another project needs them or has
finished, until they open the switcher. The switcher becomes a list of chats, in the manner of a messenger: each
project shows what happened last and a badge for what is new. The header's Sessions menu goes: sessions become
the second level under their project.

## Goals

- One row per project (folder): the folder name, the time of the last event, the last reply on one line, the
  window's session and agent below, a dot for the state.
- One badge per row, by priority: `!` when the project waits for the person (a question or a permission),
  otherwise the number of replies they have not seen; none when both are zero.
- The header's project button carries one badge by the same rule over all other projects; so does the tab title
  (`(!) Nota Bene`, `(4) Nota Bene`).
- Rows sort: waiting first, then with unseen replies, then the rest; within a group, newest event first.
- A project expands to its sessions (all agents of that folder, each marked with its agent), "New session" and
  "Archive (N)". Rename, archive and delete live on a session row, on hover, as in today's Sessions menu.
- Choosing a session of this window switches it as today (with the confirm while the agent works). A session of
  another running window moves the tab there and that window opens the session. A session of a folder with no
  running window is not listed in this phase (the folder shows under Recent; its sessions appear once it runs).
- Above the chat, one line names the window's session (`● Fix the login form ▾ · Claude`); a click opens this
  project's sessions. It replaces the header's Sessions button.
- A worktree row in the branch menu gets "Open": it opens (or reaches) a window on that worktree, through the
  starter's open route.

## The folder browser (starter)

The starter becomes a familiar "Open folder" dialog, one mode instead of two:

- Places on the left: Home, the parent folders of recent projects (deduplicated, at most five), Desktop when it
  exists.
- The path on top as clickable breadcrumbs; a path field beside them completes the folder name with Tab and
  browses on Enter.
- The list puts git repositories first, then the other folders, each group by name. A single click selects a
  folder, a double click (or Enter) goes into it; Open opens the selected folder, or the current one when none is
  selected.
- "New folder here" replaces the separate New project mode: an inline row asks for the name and git init (on by
  default); confirming creates the folder and opens it, as the create route does today. The header menu's "New
  project…" opens the starter with that row already shown.
- A reopen starts from the last browsed folder, with hidden folders off; a late listing never replaces a newer one.
- Folder names Windows refuses (`:*?"<>|`, CON and the like, a trailing dot or space) are refused before sending.

## Non-goals

- The left column of projects (variant B): with phase 2.
- Renaming a project: the name is the folder's. A later issue.
- Listing sessions of a folder that has no running window.
- Browser system notifications.
- The phone's unread counts stay its own.

## Unseen replies

A window already reports, in `/info`, the number of replies of its current session and the last message
(`hub.summary()`). A reply is seen when a page shows that session while the page is visible and focused. The window
keeps, per session id, the time the session was last seen; unseen is the replies after it (a time, not a count: a
compaction drops replies). The marks persist in the state dir. Known limit: a reply replayed from the transcript has
no time, so replies that came before a restart of the window or the agent, or before a switch back to that session,
count as seen; replies after it count again. `/info` adds `unseen`. Only the current session of a window can gain
replies, so
its count is the row's count; a session left with unseen replies keeps its count in the session list.

## Folder rows over windows

Phase 1 lists windows. A folder with two windows (two agents) becomes one row: its state is the most urgent of
its windows, its badge the sum, its last event the newest. Expanding shows the sessions of both windows. A click
on the row goes to the window with the newest event, or to this one when it is in the folder.

## Calls made (correct if wrong)

- A project is a folder, not a window (the header names the folder).
- No avatars from the project icon in this phase: another window's icon needs that window's login; a coloured
  letter tile stands in.
- Sessions of another window come through this server, which asks that window with its helper bearer, as the
  projects list does.

## Left to the builder

The poll cadence (phase 1: 3 s open, 10 s closed), the socket message for visibility, the shape of the seen
store, the exact layout within the mockup's frame.
