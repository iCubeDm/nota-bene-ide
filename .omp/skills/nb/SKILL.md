---
name: nb
description: Open Nota Bene on this project from omp — a browser window with inline review comments, files and media. Use for nb, nb new, or nb fork.
---

# Nota Bene for omp (this checkout)

This is the project-level entry for the omp skill that ships in `omp/skills/nb/`. It runs that checkout's own helper, so there is one copy of the code.

Run `node "<this-skill-directory>/../../../omp/skills/nb/open.mjs" [new|fork]` with the bash tool in the project directory. Omit `[new|fork]` for a normal launch.

- No argument: resume the folder's last Nota Bene omp session, or start one. `new`: start fresh. `fork`: continue this omp conversation as a separate branch (the helper reads `PI_SESSION_ID`; if it is missing, stop and explain, never guess).
- The command prints one `opened URL` or `already-open URL` line. Reply with that plain URL in one short line. Never add or look for a token, and never call `nota-bene --url`.
- An already open omp window is brought forward; a requested `new` or `fork` is then not applied. Relay the helper's explanation.
- The window runs detached; Stop in the window ends it.

Relay launch errors in one or two lines and do not retry.
