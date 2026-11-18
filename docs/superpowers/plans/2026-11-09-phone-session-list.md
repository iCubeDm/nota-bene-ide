# Phone session list (#147) Implementation Plan

**Goal:** The phone's session list reads like Telegram's chat list: per host, each window with its agent avatar, session title, last message and time, a working dot, a "!" when an approval waits, an unread count; long-press for Open and Mark read.

**Approach:** The host stream already lists windows every 5 s from each window's `/control/info` (`server/src/server.ts`, filtered by `INFO_FIELDS` in `server/src/remote/device.ts`). The window adds `pending`, `last`, `replies` to its info; the connector passes them; the Dart channel parses them; the phone stores per session the reply count it has seen and computes unread.

**Spec:** `docs/superpowers/specs/2026-11-09-phone-ux-design.md` ("Session list", "Older servers"). Global constraints of `2026-11-09-phone-layout.md` apply.

## Decisions

- An older connector or window sends none of the new fields: rows simply lack them (no count, no "!", no preview).
- `last.text` is one plain line: Markdown markers kept, newlines and whitespace runs collapsed to one space, cut to 120 characters with an ellipsis, on the server.
- Unread is the session's own: `max(0, replies - seen)`, keyed by host id and session id, so a window restart (new port, same session) does not reset it and a session switch uses that session's count. First sight of a session counts as seen up to its current `replies` (no flood of old unread). Mark read while offline is stored and applied later.
- Server tests use ports 4790-4795 and a temporary `NOTA_BENE_HOME`; never touch a running window or `~/.nota-bene`. The worktree has no `node_modules`: symlink the main checkout's, trash the links after, never install.

## Contract

Window info gains:
- `pending: boolean`: a permission or interaction prompt awaits an answer.
- `last: { role: 'user' | 'assistant'; text: string; at: number } | null`: latest user message or final assistant reply of the current session; `at` ms since epoch.
- `replies: number`: count of final assistant replies in the current session (the desktop's reply numbering).

`INFO_FIELDS` adds all three; `server/src/remote/CHANNEL.md` is updated. Dart `HostWindow` (`mobile/channel/lib/src/channel.dart`) gains `bool pending` (default false), `LastMessage? last`, `int? replies`; `LastMessage {role, text, DateTime at}`.

## Phone side

- `Seen` (`mobile/app/lib/store/seen.dart`, `ChangeNotifier`): `seenOf`, `see(host, session, replies)`, `unread(host, window)` (0 when session or replies null); persisted like `lib/store/hosts.dart` under its own key. `chat_route.dart` calls `see` on every `replies` change while the chat is open.
- Rows (`hosts/hosts_screen.dart`): 44 px avatar (provider letter and colour as the header's) with an accent dot while busy. Line 1: title (or `untitled`) and time of `last.at` (`HH:mm` today, short weekday this week, else `d.MM`). Line 2: `last.text`, prefixed "You: " (`youPrefix`) for a user message; right side an accent "!" badge when `pending`, else a primary unread count. Line 3: folder and model, monospace muted. Offline host's rows at 50% opacity, header shows "last seen". Long-press menu: Open, Mark read (`markRead`).

## Review focus

- A session with no messages: `last` null, row shows folder and model only.
- Restart keeps the seen count; switch uses the new session's count.

## Files

`server/src/server.ts`, `server/src/remote/{device.ts,CHANNEL.md}`, `mobile/channel/lib/src/channel.dart`, `mobile/app/lib/store/seen.dart`, `mobile/app/lib/chat/chat_route.dart`, `mobile/app/lib/hosts/hosts_screen.dart`, six ARB files, with tests (server/device, channel `dart test`, `seen_test`, `hosts_screen_test`).

Final check: `npx tsc -b`, serialized `npm test`, `dart test` in `mobile/channel`, the Flutter checks, `flutter build apk --release`.
