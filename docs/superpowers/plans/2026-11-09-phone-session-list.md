# Phone session list (#147) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone's session list reads like Telegram's chat list: per host, each window with its agent avatar, session title, the last message and its time, a working dot, a "!" when an approval waits, an unread count; long-press for Open and Mark read.

**Architecture:** The host stream already lists windows every 5 s from each window's `/control/info` (`server/src/server.ts` ~318, filtered by `INFO_FIELDS` in `server/src/remote/device.ts`). The window adds three fields to its info: `pending`, `last`, `replies`; the connector passes them; the Dart channel parses them; the phone stores per session the reply count it has seen and computes unread.

**Tech Stack:** TypeScript (Node server, Vitest), Dart (`mobile/channel`, `dart test`), Flutter 3.47.9.

**Spec:** `docs/superpowers/specs/2026-11-09-phone-ux-design.md` ("Session list", "Older servers").

## Global Constraints

- The Global Constraints of `docs/superpowers/plans/2026-11-09-phone-layout.md` apply, with `gh-147:` commits.
- Server tests use only ports 4790–4795 and a temporary `NOTA_BENE_HOME`; never touch a running window or `~/.nota-bene`.
- `server/src/remote/CHANNEL.md` documents the host stream's fields: update it.
- An older connector or window sends none of the new fields: rows simply lack them (no count, no "!", no preview).
- Branch `gh-147-session-list`, cut from `gh-146-images`, in `/Users/icubedm/Documents/Projects/ai-ide-phone`.
- The worktree has no `node_modules`: symlink the main checkout's for checks, trash the links after, never install.

## Review Focus

- A window with a session that has no messages yet: `last` null, row shows the folder and model only.
- `last.text` with Markdown and newlines: one plain line, cut to 120 characters on the server.
- A restart of the window (new port, same session id): the seen count follows the session id, the unread count does not reset to everything.
- A session switch in a window (new session id): its unread is that session's own.
- Mark read while the window is offline: stored, applied when it comes back.

---

### Task 1: The window tells its state

**Files:**
- Modify: `server/src/server.ts` (the `/control/info` answer), `server/src/remote/device.ts` (`INFO_FIELDS`), `server/src/remote/CHANNEL.md`
- Test: the existing server and device tests (find them with `ls server/src server/src/remote | grep test`)

**Interfaces:**
- Info gains: `pending: boolean` — a permission or interaction prompt awaits an answer in this window (find where the session manager keeps pending permissions); `last: { role: 'user' | 'assistant'; text: string; at: number } | null` — the latest user message or final assistant reply of the current session, text as plain one line (Markdown markers kept as typed; newlines and runs of whitespace collapsed to one space), cut to 120 characters with `…`, `at` in ms since epoch; `replies: number` — the count of final assistant replies in the current session (the same count the desktop's reply numbering uses).
- `INFO_FIELDS` adds `pending`, `last`, `replies`.

- [ ] **Step 1: Failing tests:** info of a fresh window: `pending false`, `last null`, `replies 0`; after a scripted turn with the test agent (as existing server tests drive one) `last` is the reply and `replies 1`; a long multi-line reply is one line ≤ 121 characters; a pending permission sets `pending true`; the device's host stream passes the three fields.
- [ ] **Step 2: FAIL** (`npx vitest run server/src/<files>`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS; `npx tsc -b` exit 0.**
- [ ] **Step 5: Commit** `gh-147: a window tells the phone its last message, replies and waiting approval`.

### Task 2: The channel parses them

**Files:**
- Modify: `mobile/channel/lib/src/channel.dart` (`HostWindow`)
- Test: `mobile/channel/test/` (the HostWindow parsing test, or a new one)

**Interfaces:**
- `HostWindow` gains `final bool pending;` (default false), `final LastMessage? last;`, `final int? replies;`; `class LastMessage { final String role, text; final DateTime at; }`.

- [ ] **Step 1: Failing tests:** full JSON parses all three; JSON without them gives defaults (false, null, null).
- [ ] **Step 2: FAIL** (`dart test` in `mobile/channel`). - [ ] **Step 3: Implement.** - [ ] **Step 4: PASS; `dart analyze`, `dart format --set-exit-if-changed .` exit 0.**
- [ ] **Step 5: Commit** `gh-147: the channel reads the windows' new fields`.

### Task 3: Seen replies

**Files:**
- Create: `mobile/app/lib/store/seen.dart`
- Modify: `mobile/app/lib/chat/chat_route.dart` (mark seen while the chat is open)
- Test: `mobile/app/test/seen_test.dart`

**Interfaces:**
- `class Seen extends ChangeNotifier { int seenOf(String hostId, String session); void see(String hostId, String session, int replies); int unread(String hostId, HostWindow w); }` persisted the way `lib/store/hosts.dart` persists (same storage, its own key), keyed by host id and session id. `unread` = `max(0, (w.replies ?? 0) - seenOf(...))`, 0 when `w.session` or `w.replies` is null. First sight of a session (no stored value) counts as seen up to its current `replies` (no flood of old unread).
- While a chat route is open and its tab is open, every change of the window's `replies` (from the host stream for that port) calls `see`.

- [ ] **Step 1: Failing tests:** unread after replies grow; persistence across a new `Seen` instance; first sight is not unread; a different session id has its own count; `see` while open keeps unread 0.
- [ ] **Step 2: FAIL.** - [ ] **Step 3: Implement.** - [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `gh-147: the phone remembers which replies it has seen`.

### Task 4: The rows

**Files:**
- Modify: `mobile/app/lib/hosts/hosts_screen.dart`, the six ARB files
- Test: `mobile/app/test/hosts_screen_test.dart`

**Interfaces:**
- Consumes: `HostWindow.pending/last/replies`, `Seen`, `providerLetter` (`lib/chat/chat_header.dart`).
- Row: 44 px avatar (provider letter and colour as the header's), a small accent dot on it while `busy`; first line: session title (or `untitled`), time of `last.at` at the right (`HH:mm` today, short weekday this week, else `d.MM`); second line: `last.text` (prefixed with the web's `srcMine`-style "You: " — ARB `youPrefix` — when `role` is user), at the right an accent "!" badge when `pending`, else a primary count badge when unread > 0; third line: folder name and model in monospace muted. An offline host's rows at 50% opacity, its header shows "last seen …" (existing string).
- Long-press a row: a vertical menu Open, Mark read (`Seen.see` with the current `replies`). ARB: `markRead`.

- [ ] **Step 1: Failing tests:** a window with all fields renders title, time, text, count; `pending` shows "!" instead of the count; user `last` gets the prefix; missing fields render without them; long-press → Mark read clears the count; offline host rows are dimmed.
- [ ] **Step 2: FAIL.** - [ ] **Step 3: Implement.** - [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `gh-147: session rows with the last message, time, waiting and unread`.

### Task 5: Whole check and APK

- [ ] `npx tsc -b`, `npm test` (the whole suite, serialized, nothing else running on 4790–4795), `dart test` in `mobile/channel`, the three Flutter checks, `flutter build apk --release` → all exit 0.
