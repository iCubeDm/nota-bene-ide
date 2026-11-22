---
name: nb
description: Open Nota Bene — the browser window over Claude Code with inline margin comments, file tree and media viewer — on the current folder. `/nb` resumes the window's last session for this folder (or starts one); `/nb new` starts fresh; `/nb fork` carries this conversation over.
argument-hint: "[new | fork]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/open.mjs" *), Bash(node */nb/open.mjs* *), Bash(node */bin/nota-bene.mjs* *)
---

# Nota Bene

!`node "${CLAUDE_SKILL_DIR}/open.mjs" --data '${CLAUDE_PLUGIN_DATA}' --plan "$ARGUMENTS" "${CLAUDE_SESSION_ID}"`

## Your task

The output above comes from the launcher's planner. It is either one `NB:` line, or an `NB-RUN:` line and, on a first install only, an `NB-NOTE:` line.

- **`NB-RUN:` is there** — open the folder:
  1. If there is an `NB-NOTE:` line, tell the user its text in one short line first (the first run installs the package, which takes a few minutes).
  2. Run the `NB-RUN` command exactly as given (verbatim: do not re-quote or edit it) with the Bash tool in the foreground, with `timeout` set to 600000. It prints one `NB:` line.
  3. If it says `NB: opened …` or `NB: already open …`: reply with one short line containing the URL, in the user's language. The URL is plain: the browser is already open and logged in (the launcher opened it); never add or look for a token. If it says *resumed*, mention which session continues. If it says *forked*, add that the browser window continues this conversation as a separate branch, so further messages here and there no longer see each other. Add once that Nota Bene keeps running after this session ends; ⏻ in its header stops it.
  4. If it reports an error: relay it in one or two lines. Do not retry.
- **Only an `NB:` line** — it brought an open window to front, or reports an error or a refusal: reply in one short line with the URL, or relay the error in one or two lines with the fix it names. Do not retry, and do not start the server yourself.

Do nothing else.
