---
name: nb
description: Open Nota Bene on the current project from omp — a browser window with inline review comments, files and media. Use for nb, nb new, or nb fork.
---

# Nota Bene for omp

Run `node "<this-skill-directory>/open.mjs" [new|fork]` with the bash tool in the user's project directory. Resolve the script relative to this SKILL.md (in bash the directory is `skill://nb`); pass arguments as separate shell words. Omit `[new|fork]` for a normal launch. The helper needs an installed `nota-bene-ide` launcher (`nota-bene` on PATH) unless the skill sits inside a Nota Bene checkout or package.

- No argument: resume the folder's last Nota Bene omp session, or start one. `new`: start fresh. `fork`: continue this omp conversation as a separate branch. The helper reads `PI_SESSION_ID`, which omp sets for every bash call, or accepts `--source` with a session id. If neither is available, stop and explain; never guess the source from other sessions.
- The command prints one `opened URL` or `already-open URL` line. Reply with that plain URL in one short line. Never add or look for a token, and never call `nota-bene --url`.
- An already open omp window is brought forward; a requested `new` or `fork` is then not applied to its conversation. Relay the helper's explanation.
- The window runs detached: it survives the end of this turn. Stop window in the window's ↻ menu ends it.

Relay launch errors in one or two lines and do not retry. Do not modify global skills or install global packages during invocation.

Invocation in omp: `/skill:nb`, `/skill:nb new`, `/skill:nb fork`. Install from a checkout with `ln -sfn "$PWD/omp/skills/nb" ~/.omp/agent/skills/nb`.
