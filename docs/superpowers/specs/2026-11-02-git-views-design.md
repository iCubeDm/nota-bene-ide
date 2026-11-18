# Git views

Read git from the window: which branch am I looking at, what changed, how did it get here. It matters when agents work in several worktrees at once, so the answer must be one click away and must not disturb them.

Non-goals: checkout, commit, stage, revert, push or any write; new hotkeys; inline review threads. Anti-goal: an open window that slows an agent or makes its git commands fail.

## What the user sees

**Branch picker.** The `(branch ✔/✗)` header chip opens a popover with search and groups "This folder", "Worktrees", "Branches"; rows show `↑N` commits over base, `✗` for uncommitted work, a pulsing dot when an agent works there. Picking a row changes what the window shows (tree, Changes, log), never the checkout or the agent's folder (a live window may run from it). While another source is shown the chip is tinted, says "viewing", and its tooltip says where the window and agent really are. It replaces the Source selector above the tree. No repository, no chip.

"Agent at work" = a Nota Bene window on this machine is busy with its root in that folder (deepest folder wins; worktrees often sit inside the project). Plain terminal agents and subagents in their own worktree are invisible to the server and get no dot. The dot uses `--nb-accent`.

**Changes.** A left-strip tool window sharing the slot with Files, plus a tab showing one file at a time with `‹ ›` and "N of M"; one or two columns, remembered. The tool window has the "Show" selector, totals, the commits in range, a filter, the file list.

| "Show" | Range | Offered for |
|---|---|---|
| Uncommitted (default) | `HEAD` to working tree, untracked included | a folder (this one, a worktree) |
| Whole branch from X (default where nothing else exists) | fork point with X to the tip; to the working tree in a folder | every source with a base |
| A named branch | fork point with it, same end | every other local branch |

Remembered per source and project. Git keeps no parent branch, so X is the branch named by the `branch: Created from X` reflog record when it is a local branch other than the default; otherwise the default (`origin/HEAD`, else `main`, else `master`). The default branch has no base. No nearest-branch guessing (wrong in the spike).

**Git log.** A tab with the commit graph (all branches or the shown source), a filter over subject/author/hash, refs as chips (a known source's chip switches the view). A commit opens a card (draggable width) with message, files and one file's diff. At most 400 commits; says so when more.

**Comments.** Selecting diff text works as in a file: the comment is on `path`, or `path @ ref` for another source or a commit; marks are drawn on the diff. Click jumps: a file comment opens the file; a commit comment opens the log on that commit and file. A comment on a removed line finds nothing, like any orphan.

**No repository:** Changes and Log buttons are hidden.

## Server

`server/src/vcs.ts`, read-only, GET routes in `fileRoutes.ts`, response types in `shared/`.

| Route | Answers |
|---|---|
| `/vcs-diff?src&base` | range, detected base, commits, file list (no contents: polled) |
| `/vcs-file?src&base&path&old` | one file's patch |
| `/vcs-branches` | picker: base, ahead, dirty, busy |
| `/vcs-log?src&all` | commits with parents and refs |
| `/vcs-commit?sha` | message, author, files |
| `/vcs-commit-file?sha&path&old` | one file of a commit |

Rules:
- Every git call uses `--no-optional-locks` and `core.fsmonitor=false`: polling must never take `index.lock` while an agent commits.
- `--no-ext-diff --no-textconv`: repo config must not run programs through these views.
- Paths travel NUL-separated (`-z`), matched with `--literal-pathspecs`; the list row is the source of a file's name, never the patch (spaces, Cyrillic need no unquoting).
- `base` is only a member of the local branch list or `BASE`; `sha` is hex; a path is relative without `..`.
- `HIDDEN` segments, state folders and `.nota-bene` are dropped from lists; `/vcs-file` and `/vcs-commit-file` refuse them with 403 (state guard fails closed).
- A failed or timed-out git command is 503, never empty: "no changes" must be true. No common ancestor: say so, never fall back to another range.
- Limits: 3000 files, 3 MB per patch, 512 KB per untracked file (larger = binary), 8 s per git call, 40 sources in `/vcs-branches`; cut results say so.
- No commits yet: untracked files listed, no error. Untracked files read with `lstat` (a symlink shows no target content).

## Web

`web/src/vcs/`. State in an external store like `files/sources.ts` (tool window and tab share one fetch), keyed by project root so a session switch shows nothing of the old folder.

- `parse.ts`: patch to hunks/rows; path from the list row.
- `store.ts`, `useLiveDiff.ts`: list and open patch refresh every 4 s (log 6 s) while the view and page are visible; one request at a time; an unchanged answer does not re-render.
- `DiffBody.tsx`: no highlighting above 1500 rows, a "show" button above 3000; line numbers are pseudo-elements so they stay out of anchored text.
- `ChangesPanel.tsx`, `ChangesView.tsx`, `LogView.tsx`, `graph.ts`; `shell/GitBranch.tsx` (polls `/vcs-branches` while open, slowly while another source is shown).
- `HighlightLayer` learns a diff pane: root is the element with `data-file-path` inside the pane.
- Tabs `changes` and `log`: one each, not saved. All strings through `web/src/i18n` in every language.
- Docs: `docs/guide.md` gains a section and loses the Source selector; `docs/architecture.md` gains the routes.

## Calls made while writing

- A branch without a folder defaults to the whole branch (nothing uncommitted).
- A clean worktree defaults to "no changes", not the branch diff, so the default stays predictable.
- Comments keep the existing anchor format; no change to old comments, panel or sending.
- Polling stays: other agents' worktrees change without a turn of this window.
