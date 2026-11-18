# Projects as a chat list: Implementation Plan

**Goal:** The header's project menu becomes a list of chats with one priority badge per project; sessions live under their project (the Sessions button goes); a line above the chat names the window's session; worktrees open in their own window; the starter becomes an Open folder dialog.

**Approach:** Windows stay separate processes (phase 1). Each window keeps a per-session "seen at" time and reports `unseen` in `/info`; the page marks its session seen while visible and focused. The projects list carries `last`, `unseen` and `pending` per window; the web groups windows by folder. Another window's sessions come through this server's helper bearer; opening one rides on the login hand-off: the URL carries `&s=<id>` and the target page switches after login.

**Spec:** `docs/superpowers/specs/2026-11-15-project-chat-list-design.md`. Commits `gh-386: ...`.

## Constraints

- All text through `web/src/i18n`, six languages. A control with a shortcut names it in its tooltip (`withKey`).
- Never log, echo or keep in page state a login or token; the `#t=` URL lives only in a JSON answer and `nav.go`.
- Tests on ports 4790-4795 with a temporary `NOTA_BENE_HOME`; neutral fixtures. No protocol change: `mobile/protocol` stays.

## Decisions and contracts

### Server

- Seen (`server/src/seen.ts`): `readSeen(dir?)`, `markSeen(id, at, dir?)` in `<stateDir>/seen-sessions.json`, at most 2000 ids (oldest dropped), atomic write as in `archivedSessions.ts`, only a later `at` wins. `hub.summary(seenAt = 0)` adds `unseen` = final replies (`agent` + `message`) with `ts > seenAt`; counting by time, not `replies - seen`, because compaction can shrink `replies`; replayed `ts 0` ignored. `POST /seen {session}`: 204; 400 bad id; 409 `not the open session`; cookie tier like `/sessions/rename`. `/info` gains `unseen`.
- Projects (`server/src/projects.ts`, `projectRoutes.ts`): `RunningRow` and `ProbedInfo` gain `unseen` and `last {role, text, at?} | null`; `pending` folds into `state`. `sessionsOf({provider, port, root}, fetchFn?)` returns `{sessions}` or `{error}` with the same registry/pid/proof/root checks as `enterUrl`, GETs the window's `/sessions` with the helper bearer, keeps sessions whose `cwd` is the root or inside it (`SessionRow {id, title, at, archived?}`); refuses a wrong root before using any bearer. `POST /system/projects/sessions {provider, port, root}` returns `{current, sessions}` / 404 / 409 and is refused to a cookie alone and by `goodPath`. `enterUrl` takes an optional `session` (must pass `isSessionId`, else 400) and returns `...#t=<64hex>&s=<id>`. `POST /system/folders` adds `places: {path, kind: 'home'|'desktop'|'recent'}[]`: home, Desktop if a folder, then parents of `readRecent` roots, deduplicated, at most five recent, never equal to home.
- Starter: `validName` gains Windows rules on server and web.

### Web

- Landing: `FRAGMENT = /^#t=([0-9a-f]{64})(?:&s=([0-9A-Za-z_-]{1,128}))?$/`; `loginFromFragment` returns `{ok, session}` and still drops the whole hash; a malformed `s` gives no login. `landOn(store, session)` (`web/src/projects/landing.ts`) runs once: when the connection is open and the hello's session known and different, dispatch `switchSession(session, root)`; a refusal or `server-error` with `where:'switch'` toasts `projLandFailed` (a session the target cannot open must not loop or leave a blank page).
- Seen: `startSeen(store, doc, win, post)` (`web/src/projects/useSeen.ts`, mounted in `App.tsx`) posts `/seen` only when the document is visible AND focused, on `focus`/`visibilitychange` and when `feed.turnSeq` changes; at most once per 2 s; never with a null session.
- Rows (`web/src/projects/api.ts`): `ProjectRow {root, windows, state, unseen, last, current}`; `foldRows(running)`: state by urgency waiting > working > idle > silent > restarting, unseen summed, last = newest `at`; sorted waiting first, then unseen > 0, then the rest, each by newest `last.at` then folder name. `badgeOf(rows)` returns `'!' | number | null` over non-current rows. The header trigger shows one badge; `document.title` gets `(!) ` or `(N) `.
- Menu (`ProjectSwitcher.tsx` rewritten, `ProjectSessions.tsx`, `SessionLine.tsx`): a row has a letter tile (two letters, colour hashed from the root) with the state dot, folder name, `ago`, last message line, `session title · Agent` (several windows: newest), one badge. Click: this folder expands; another folder runs `enterProject(newest window)`. Expanded: this window's sessions from `/sessions` filtered to the root (rename, archive, delete, Archive (N), New session with the usual confirm); another window's from `/system/projects/sessions`, open only; each session shows title, agent, `ago`, unseen badge for a window's current session; open switches locally or `enterProject(window, sessionId)`. New session: one entry per installed agent (`/system/agents`): a window of that agent in the folder starts a session there, else `openFolder(root, agent)`. Recent: `recent` plus folders from this window's `/sessions` not running, newest first, ten; opening a session there uses `openFolder(root, provider, undefined, session)`. This project is expanded on open. `SessionLine` (`● title or Untitled ▾ · Agent`) sits above the feed, not in subagent views, and opens the menu. `Header.tsx` drops `<SessionPicker />`; `ago`/`kb`/`menuGroups` move to `web/src/controls/sessionsFormat.ts`; `SessionPicker.tsx` and its test are deleted after porting cases that still apply.
- Worktrees (`web/src/shell/GitBranch.tsx`): worktree rows get an `Open` button (tooltip `vcsOpenTreeTip`) calling `openFolder(s.dir, provider)` (`POST /system/projects/open {dir, provider}`); failure shown inline.
- Starter (`Starter.tsx` rewritten; `openStarter(mode)` signature kept, `'new'` shows the new-folder row): places column; breadcrumbs (each segment a button); path field with Tab completion (unique prefix completes, several give the longest common prefix, none does nothing) over the typed parent's listing; git folders first; single click selects, double click/Enter enters; Open opens the selection or current folder; inline "New folder here" (name, git checked, Create); reopen starts at the last folder with hidden off; a listing arriving after a newer request is dropped.

## Review focus

- Compaction never makes unseen negative or wrong. Unfocused-but-visible page is not "seen". A folder with two windows is one row with the most urgent state, summed badge, both windows' sessions. A starter double click on a vanished folder fails gracefully.

Docs: six i18n files (new keys plus #386 wording fixes), `docs/guide.md`, `docs/architecture.md` section 2.4, `docs/agent-reference.md` (`/seen`, `/system/projects/sessions`, `places`, `seen-sessions.json`, `recent.json`), `CHANGELOG.md`. Checks: `i18n.test.ts`, hand check for hard-coded strings, `npm test`, `npx tsc -b`, `npm run build -w web`.
