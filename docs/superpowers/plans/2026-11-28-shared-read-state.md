# Shared read state (issue 174, PR 3 of 4): plan

Spec: `docs/superpowers/specs/2026-11-27-clients-in-sync-design.md` §4, the read-state parts of §5, §7 and §8.

## 1. Shared protocol (protocol 41)

- `shared/src/protocol.ts`: client `{ type: 'looking'; on: boolean }` (parsed, `on` must be a boolean); server
  `{ kind: 'seen'; at: number }` (never stored, no ts); `PROTOCOL = 41`.
- `shared/src/features.ts`: `looking: 41` (only the client's `looking` is gated; `seen` is not).
- `shared/src/host.ts`: `HostWindow.unseen?: integer`, `unseen` in `HOST_WINDOW_INFO`.
- Fixtures (`shared/fixtures/protocol.json`), schema and Dart (`npm run gen:protocol`); pin in `scripts/protocol/dart.test.ts`.
- `mobile/channel` `HostWindow.withIcon` keeps `unseen`.
- Tests: `protocol.test.ts` "issue 174: looking parses with a boolean on, anything else is refused".

## 2. Server

- `server/src/seen.ts`: `markSeen(id, at, dir): number` returns the session's mark after the write (the later one).
- `server/src/agent.ts`: a `lookers` set; `markLooked(at = Date.now())` marks the current session (lowercased id) while
  the set is not empty and broadcasts `seen` with the stored mark. Callers: a `looking` `on` (off removes), a closed
  socket is removed, a `hub.tap` on a final reply and on a turn's end (marked at the event's ts, so the favicon's
  "at ≥ the turn's end" holds), `onSessionId`, `onSwitch`. Attach sends the current mark before `hello`.
- `server/src/hub.ts`: `seen` is not stamped; the comment at `summary` says which replays carry real times.
- `POST /seen` and `seenRoute` go (`sessions.ts`, `agent.ts`, `routes.seen`, their tests, the auth table).
- `server/src/audit.ts`: `looking` is not logged (early return).
- `server/src/projects.ts` `remoteRows`: `unseen` from the host row (number, else 0).
- Tests (`server/src/seen.test.ts`, `server/src/looking.test.ts`, `audit.test.ts`, `remote/device.test.ts`,
  `projects.test.ts`, `stateLayout.test.ts`):
  - a looker plus a final reply leaves `unseen` at 0, with no looker it is 1;
  - turning `on` marks the session and broadcasts `seen` to every socket;
  - a closed looker (and one that turned off) stops marking;
  - attach sends the current mark before `hello`;
  - host rows carry `unseen`; another computer's rows use it.

## 3. Web

- `web/src/plugins/projects/seen.ts` → `looking.ts`: `startLooking(conn, doc, win)` sends `looking` on a change of
  `!document.hidden && document.hasFocus()` (focus, blur, visibilitychange) and again at each `hello`, only to a server
  with `looking`. The `Seen` slot becomes `Looking`.
- `web/src/core/store/controls.ts`: `seenAt` from `seen`; `feed.ts` ignores `seen`.
- `web/src/core/shell/Favicon.ts`: the done/error dot clears when `controls.seenAt` ≥ the last turn's end.
- Tests: `looking.test.ts` (follows focus and visibility; sent again at `hello`; nothing below 41), `Favicon.test.tsx`
  ("a seen at or after the turn's end clears the dot, an earlier one does not").

## 4. E2E, docs

- `e2e/clients.spec.ts`: a reply finished while a page looks leaves `/info.unseen` 0; with no page looking it is 1.
- `docs/guide.md`, `docs/architecture.md`, `server/src/remote/CHANNEL.md`, CHANGELOG `## Unreleased`.
- Known limits: omp/ACP unread clears after a restart (replays carry ts 0); an old page left open across a restart marks
  nothing until reloaded; a zombie socket stays looking ≤ 60 s.
