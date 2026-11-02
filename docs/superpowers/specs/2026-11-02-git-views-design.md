# Git views

Reading git from the window: which branch am I looking at, what changed, how did it get here. It matters
most when agents work in several worktrees at once, so the answer has to be one click away and must not
disturb them.

Non-goals: checkout, commit, stage, revert, push, or any other write. New hotkeys. Inline review threads.

Anti-goal: an open window that slows an agent down or makes its git commands fail.

## What the user sees

**Branch picker.** The `(branch ✔/✗)` chip in the header opens a popover with a search box, then "This
folder", "Worktrees" and "Branches", each row with `↑N` commits over its base, `✗` when it has
uncommitted work and a pulsing dot when an agent is at work there. Picking a row changes what the window shows: the tree, the Changes view and the log.
It never changes the checkout or the agent's folder (a live window may be running from that checkout). While
another source is shown, the chip is tinted, says "viewing", and its tooltip says where the window and the agent
really are. It replaces the Source selector above the tree. Without a repository there is no chip.

"An agent is at work" means a Nota Bene window on this machine is busy with its root in that folder (the deepest
folder wins, since worktrees often sit inside the project). A plain terminal agent and a subagent in its own worktree are
not visible to the server, so they get no dot. The dot takes the working colour of the favicon, `--nb-accent`.

**Changes.** A tool window on the left strip, sharing the slot with Files, and a tab that shows one file at a
time, with `‹ ›` and "N of M". One column or two; the choice is remembered. The tool window has the "Show"
selector, totals, the commits the range covers, a filter and the file list.

"Show" decides the range:

| Choice | Range | Offered for |
|---|---|---|
| Uncommitted (default) | `HEAD` to the working tree, untracked files included | a folder: this one, a worktree |
| Whole branch from X (default where nothing else exists) | fork point with X to the tip; to the working tree in a folder | every source that has a base |
| A named branch | fork point with that branch, same end | every other local branch |

The choice is remembered per source and per project.

Git keeps no parent branch, so X is: the branch named by the `branch: Created from X` reflog record when that is
a local branch other than the default one; otherwise the default branch (`origin/HEAD`, else `main`, else
`master`). The default branch itself has no base. No guessing by nearest branch: it gave wrong answers in the spike.

**Git log.** A tab with the commit graph (all branches, or only the shown source), a filter over subject,
author and hash, and refs as chips; a chip of a known source switches the view to it. Picking a commit opens a card
with its message and files (its width can be dragged) and the diff of one of them. At most 400 commits; the
view says so when there are more.

**Comments.** Selecting text in a diff works as in a file: the comment is on `path`, or on `path @ ref` when
another source or a commit is shown, and the agent gets that. Marks are drawn on the diff too. A click on a
comment jumps: a file comment opens the file as before, a comment on a commit opens the log on that commit and file.
A comment on a removed line has no place in the current file: the jump finds nothing there, as with any orphan.

**No repository.** The Changes and Log buttons are not shown.

## Server

`server/src/vcs.ts`, read-only, GET routes in `fileRoutes.ts`. Response types live in `shared/`.

| Route | Answers |
|---|---|
| `/vcs-diff?src&base` | range, detected base, commits, file list. No contents: this is polled |
| `/vcs-file?src&base&path&old` | one file's patch |
| `/vcs-branches` | for the picker: base, ahead, dirty, busy |
| `/vcs-log?src&all` | commits with parents and refs |
| `/vcs-commit?sha` | message, author, files |
| `/vcs-commit-file?sha&path&old` | one file of a commit |

Rules:

- Every git call runs with `--no-optional-locks` and `core.fsmonitor=false`. Polling a repository must never take
  `index.lock` while an agent commits there.
- `--no-ext-diff --no-textconv`: a repository's config does not get to run programs through these views.
- Paths travel NUL-separated (`-z`) and are matched with `--literal-pathspecs`. The list row is the source of a file's
  name; the patch never is, so spaces and Cyrillic names need no unquoting.
- `base` is only ever a member of the local branch list, or the word `BASE`. `sha` is hex. A path is relative,
  without `..`.
- `HIDDEN` segments, the state folders and `.nota-bene` are dropped from every list, and `/vcs-file` and
  `/vcs-commit-file` refuse them with 403. The state guard fails closed, as everywhere else.
- A failed or timed-out git command is an error (503), never an empty result: "no changes" must be true.
- No common ancestor: the answer says so and the view shows it; it does not fall back to a different range.
- Limits: 3000 files, 3 MB per patch, 512 KB per untracked file (larger counts as binary), 8 s per git call,
  40 sources in `/vcs-branches`. Cut results say so.
- A repository without commits: untracked files are listed, no error.
- Untracked files are read with `lstat`, so a symlink shows no target's content.

## Web

`web/src/vcs/`. State lives in an external store, as `files/sources.ts` does: the tool window and the tab share one
fetch. Keyed by project root: a session switch to another folder shows nothing of the old one.

- `parse.ts`: patch text to hunks and rows. The path comes from the list row.
- `store.ts`, `useLiveDiff.ts`: the list and the open patch refresh every 4 s (log: 6 s) while their view is visible and
  the page is visible; one request at a time, and an unchanged answer does not re-render.
- `DiffBody.tsx`: one file. No syntax highlighting above 1500 rows, a "show" button above 3000.
  Line numbers are pseudo-elements, so they stay out of the text a comment anchors to.
- `ChangesPanel.tsx`, `ChangesView.tsx`, `LogView.tsx`, `graph.ts`: as described above.
- `shell/GitBranch.tsx`: the picker. `/vcs-branches` is polled while the popover is open, and slowly while another source is shown (the chip's `✗`).

`HighlightLayer` learns a diff pane: the root is the element carrying `data-file-path` inside the pane, not the pane.

Tabs `changes` and `log` are one each and not saved, like Settings and Usage.

Every string goes through `web/src/i18n` in all of `LANGS`.

## Docs

`docs/guide.md` gets a section on the views and loses the Source selector. `docs/architecture.md` gets the routes.

## Calls made while writing this

- A branch without a folder defaults to the whole branch: it has nothing uncommitted.
- A clean worktree defaults to "no changes" rather than falling through to the branch diff: the default stays predictable.
- Comments keep the existing anchor format, so old comments, the panel and sending need no change.
- Polling stays: other agents' worktrees change without a turn of this window.
