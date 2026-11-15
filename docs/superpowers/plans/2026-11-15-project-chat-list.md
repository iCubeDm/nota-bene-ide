# Projects as a chat list — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The header's project menu becomes a list of chats with one priority badge per project, sessions live under
their project (the Sessions button goes), a line above the chat names the window's session, worktrees open in their
own window, and the starter becomes an Open folder dialog.

**Architecture:** Windows stay separate processes (phase 1). Each window keeps a per-session "seen at" time and
reports `unseen` in `/info`; the page marks its session seen while it is visible and focused. The projects list
carries `last`, `unseen` and `pending` per window; the web groups windows by folder. Another window's sessions come
through this server's helper bearer; opening one rides on the login hand-off: the URL carries `&s=<id>` and the
target page switches after login.

**Tech Stack:** Node/TypeScript server (`server/src`), React + Redux web (`web/src`), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-project-chat-list-design.md`

## Global Constraints

- Every user-visible string goes through `web/src/i18n`, with real translations in en, ru, zh-CN, es, pt-BR, de.
- A control with a shortcut names it in its tooltip (`withKey`).
- Never log, echo or put in page state a login or token; the `#t=` URL lives only in a JSON answer and `nav.go`.
- Tests use ports 4790–4795 and a temporary `NOTA_BENE_HOME`; neutral fixtures.
- No protocol change (no new WebSocket message): `mobile/protocol` stays as is.
- Branch commits start with `gh-386:`.

## Review Focus

1. Compaction: `replies` can shrink; unseen must count replies after the seen time, never `replies - seen`.
2. A hand-off with `&s=` for a session the target cannot open (deleted, other provider): the page logs in and shows a
   note; no loop, no blank page.
3. The seen mark while the page is visible but unfocused (another app in front): not seen.
4. A folder with two windows: one row, the most urgent state, the summed badge, both windows' sessions.
5. Starter: a double click on a folder that vanished meanwhile; Tab completion with no match or several.

---

### Task 1: Seen times and `unseen` in `/info`

**Files:** Create `server/src/seen.ts`, `server/src/seen.test.ts`. Modify `server/src/hub.ts` (summary), `server/src/server.ts` (route + info), `server/src/hub.test.ts`, `server/src/auth.test.ts` (matrix).

**Interfaces — Produces:**
- `readSeen(dir?: string): Record<string, number>`; `markSeen(id: string, at: number, dir?: string): void` — `<stateDir>/seen-sessions.json`, at most 2000 ids (oldest `at` dropped), atomic write as in `archivedSessions.ts`; a later `at` only.
- `hub.summary(seenAt = 0)` adds `unseen: number` = final replies (`agent` + `e.t === 'message'`) with `ts > seenAt`.
- `POST /seen {session}` → 204; 400 for a bad id; 409 `not the open session` when it is not the current one. Cookie-tier like other page POSTs.
- `/info` gains `unseen` (via `summary(readSeen()[id] ?? 0)`).

- [ ] Tests: `markSeen` keeps the later time and caps; `summary(seenAt)` counts only replies after it and ignores replayed `ts 0`; route 204 / 400 / 409; `/info.unseen` drops to 0 after `POST /seen`; matrix row (POST `/seen` cookie alone: allowed like `/sessions/rename`).
- [ ] Run RED, implement, GREEN, commit `gh-386: windows keep when each session was last seen and report unseen replies`.

### Task 2: Projects list fields, another window's sessions, enter with a session, folder places

**Files:** Modify `server/src/projects.ts`, `server/src/projectRoutes.ts`, their tests, `server/src/remote/device.ts` (+test), `server/src/auth.test.ts`.

**Interfaces — Produces:**
- `RunningRow` adds `unseen: number; last: { role: 'user'|'assistant'; text: string; at?: number } | null` (from `/info`); `ProbedInfo` adds both. `pending` folds into `state` as today.
- `sessionsOf({provider, port, root}, fetchFn?)` → `{ sessions: SessionRow[] } | { error }` with the same registry/pid/proof/root checks as `enterUrl`; it GETs the window's `/sessions` with the helper bearer and keeps only sessions whose `cwd` equals `root` or lies inside it. `SessionRow = {id, title, at, archived?: true}`.
- `POST /system/projects/sessions {provider, port, root}` → 200 `{current, sessions}` / 404 / 409.
- `enterUrl` takes optional `session` (must pass `isSessionId`, else 400 at the route) and returns `…/#t=<64hex>&s=<id>`.
- `POST /system/folders` answer adds `places: {path, kind: 'home'|'desktop'|'recent'}[]`: home, Desktop if it is a folder, then parents of `readRecent` roots, deduplicated, at most five recent, never a path equal to home.
- `goodPath` also refuses `/system/projects/sessions` (already covered by the prefix — assert in test).

- [ ] Tests: list rows carry `unseen` and `last`; `sessionsOf` filters by root and refuses a wrong root before any bearer; enter with session appends `&s=`; bad session 400; places order and dedupe; matrix row refused for cookie alone.
- [ ] RED, implement, GREEN, commit `gh-386: projects carry unseen and last reply; another window's sessions; enter a session`.

### Task 3: The page follows `&s=` after login

**Files:** Modify `web/src/net/auth.ts` (+test), `web/src/main.tsx`, create `web/src/projects/landing.ts` (+test).

**Interfaces — Produces:**
- `FRAGMENT = /^#t=([0-9a-f]{64})(?:&s=([0-9A-Za-z_-]{1,128}))?$/`; `loginFromFragment` returns `{ ok: boolean; session: string | null }` (callers updated) and still drops the whole hash.
- `landOn(store, session)`: once the connection is open and the hello's session is known, if it differs, dispatch `switchSession(session, root)`; a refusal or a `server-error` with `where:'switch'` shows a toast `projLandFailed`. Runs once.

- [ ] Tests: fragment with and without `&s=`, a malformed `s` gives no login; `landOn` switches once, skips when already current, toasts on refusal.
- [ ] RED, implement, GREEN, commit.

### Task 4: The page marks its session seen

**Files:** Create `web/src/projects/useSeen.ts` (+test); mount in `App.tsx`.

**Interfaces:** `startSeen(store, doc, win, post)` — posts `/seen {session}` when the document is visible **and** focused, on `focus`/`visibilitychange`, and when `feed.turnSeq` changes while visible and focused; at most once per 2 s; never when the session is null.

- [ ] Tests: hidden → no post; visible but unfocused → none; focus → one; turn end while focused → one; throttle.
- [ ] RED, implement, GREEN, commit.

### Task 5: Folder rows, priority badge, header badge and tab title

**Files:** Modify `web/src/projects/api.ts` (+test file `api.test.ts`), `web/src/shell/Header.tsx`.

**Interfaces — Produces:**
- `type ProjectRow = { root; windows: RunningRow[]; state: ProjectState; unseen: number; last; current: boolean }`; `foldRows(running): ProjectRow[]` — state by urgency waiting > working > idle > silent > restarting; unseen summed; last = newest `at`; sorted waiting, then unseen > 0, then the rest, each by newest `last.at` desc, then folder name.
- `badgeOf(rows: {state, unseen, current}[]): '!' | number | null` over rows that are not current.
- Header: the trigger shows one badge from `badgeOf`; `document.title` = `(!) ` or `(N) ` + the existing title.

- [ ] Tests: fold two windows of one folder; order; badge priority; title prefix.
- [ ] RED, implement, GREEN, commit.

### Task 6: The chat-list menu with sessions; the session line; Sessions button goes

**Files:** Rewrite `web/src/projects/ProjectSwitcher.tsx` (+test); create `web/src/projects/ProjectSessions.tsx` (+test), `web/src/projects/SessionLine.tsx` (+test); modify `Header.tsx` (drop `<SessionPicker />`), `App.tsx` (SessionLine above `<Feed />`); move `ago`/`kb`/`menuGroups` users off `SessionPicker.tsx` into `web/src/controls/sessionsFormat.ts`, delete `SessionPicker.tsx` and its test after porting the cases that still apply to `ProjectSessions`.

**Behaviour:**
- Row: letter tile (two letters of the folder, colour from a hash of the root) with the state dot; folder name; time (`ago`); last message one line; below `session title · Agent` (several windows: the newest). One badge (`!`/N). Click: this folder → expands; another → `enterProject(newest window)`.
- Chevron expands: `ProjectSessions` for the folder. This window's sessions come from `/sessions` (filtered to the root) with rename, archive, delete, Archive (N), New session (the switch confirm as today); another window's from `/system/projects/sessions`, open only. Each session row: title, agent, `ago`, unseen badge for a window's current session. Open: this window → `switchSession`; another → `enterProject(window, sessionId)`.
- New session: one entry per installed agent (`/system/agents`); an agent with a window in the folder → new session there; without → `openFolder(root, agent)`.
- Recent: `recent` plus folders from this window's `/sessions` not running, newest first, ten; expanding one lists this window's sessions in it; opening a session → `openFolder` then `&s=` via `enterProject`-style navigation (`openFolder(root, provider, undefined, session)`).
- This project is expanded when the menu opens.
- `SessionLine`: `● <title or Untitled> ▾ · <Agent>` above the feed (not in subagent views); click opens the menu.

- [ ] Tests: row content and badge; two windows one row; expand shows sessions with agent marks; open another window's session posts enter with session; local switch confirm; rename/archive/delete still work (ported); New session per agent; recent from session history; SessionLine opens the menu; header has no `#sessBtn`.
- [ ] RED, implement, GREEN, commit.

### Task 7: Open a worktree

**Files:** `web/src/shell/GitBranch.tsx` (+test).

- [ ] Worktree rows get an `Open` button (pattern of `branchRow`), tooltip `vcsOpenTreeTip`; it calls `openFolder(s.dir, provider)`; a failure shows the reason inline. Test: clicking posts `/system/projects/open {dir, provider}`.
- [ ] RED, implement, GREEN, commit.

### Task 8: The starter as an Open folder dialog

**Files:** Rewrite `web/src/projects/Starter.tsx` (+test); `server/src/projectRoutes.ts` `validName` gains Windows rules (+test); `web/src/projects/api.ts` `validName` mirrors it; `openStarter(mode)` keeps its signature (`'new'` shows the new-folder row).

**Behaviour:** places column; breadcrumbs from the path (each segment a button); path field with Tab completion (unique prefix → complete; several → longest common prefix; none → nothing) over the listing of the typed parent; git folders first; single click selects, double click/Enter enters; Open opens the selection or the current folder; "New folder here" inline row (name, git checked, Create); reopen starts at the last folder with hidden off; a listing that arrives after a newer request is dropped.

- [ ] Tests: places render and browse; breadcrumb click browses; Tab completes; select vs enter; Open sends the selection; new-folder row creates; stale listing dropped; Windows names refused (server and web).
- [ ] RED, implement, GREEN, commit.

### Task 9: Words and docs

**Files:** six `web/src/i18n/*.ts` (all new keys, plus the wording fixes from #386), `docs/guide.md`, `docs/architecture.md` §2.4, `docs/agent-reference.md` (routes `/seen`, `/system/projects/sessions`, `places`, `seen-sessions.json`, `recent.json`), `CHANGELOG.md`.

- [ ] `i18n.test.ts` green; manual check for hard-coded strings in the new components; full `npm test`, `npx tsc -b`, `npm run build -w web`; commit.
