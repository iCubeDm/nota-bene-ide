# The phone joins (issue 174, PR 4 of 4): plan

Spec: [clients in sync](../specs/2026-11-27-clients-in-sync-design.md) §5, §6, the phone parts of §3, §4, §7, §8.

## 1. shared: the old one-tab shapes go

- `shared/src/protocol.ts`: `TAKEN_OVER_CODE`, `{ kind: 'taken-over' }`, `{ type: 'takeover' }` and its parser case go;
  `occupied` stays, documented as "a server before 39". `features.ts` comment follows.
- `server/src/agent.ts`: the `takeover` early return goes (a stray one is an invalid message now). `hub.ts` stamp list
  loses `occupied`/`taken-over`. `web/src/core/store/feed.ts` loses `case 'taken-over'`.
- Tests: `clients.test.ts` "a takeover is ignored" goes; `auth.test.ts` reproduction sends no takeover.
- `npm run gen:protocol`; the protocol stays 41.

## 2. The connection: every tab is live, floor 41

- `agent_connection.dart`: `TabState { connecting, open, gone, offline, old }`; no `takenOverCode`, `_passive`,
  `_takeoverWanted`, `takeOver()`, `tabId`; URL `/ws?held=1`; `floor = Feature.looking`.
- `one_tab.dart`: the gone-window cover, and the text-only cover of an old window. `session_state.dart` loses the
  occupied/taken line; ARB `occupiedTitle`, `takenTitle`, `workHere`, `stateOtherTab` leave all six.
- Tests: `agent_connection_test` "the url is /ws?held=1", "below floor 41 is old"; occupied/taken tests go. Test hellos
  speak `floor.protocol`.

## 3. The draft: `chat/draft_sync.dart`

```dart
const draftMax = 256 * 1024; // DRAFT_MAX
class DraftPicture { Uint8List? bytes; ImageRef? ref; bool failed; bool get pending; }
class DraftSync extends ChangeNotifier {
  DraftSync({required bool Function(ClientMessage) send, required bool Function(Feature) has, Duration throttle});
  final TextEditingController text; List<DraftPicture> get images;
  void add(DraftPicture p); void remove(DraftPicture p); void uploaded(DraftPicture p); // local edits
  void received(ServerEventDraft e); void hello(); void closed(); void flush(); void dispose();
}
```

Rule (web `draftSync.ts` `received`, without a switch of its own: the phone sends no `switch`): own echo; the same
session (or the first, or an id-less scope: adoption) applied only while clean; a scope change writes a dirty text to
the old session first (kept when it cannot go: over `draftMax`); an event without ack ends a wait. Writes throttled
300 ms leading and trailing, gated by `has(Feature.draft)`, flushed at hello, on send, on app pause and when the tab
goes. A foreign text is applied as the minimal diff, the caret kept. A foreign image renders from `/attach/<id>`.

- `WindowTab.draft`, fed `draft`/`hello`/new socket; `ChatRoute` and `Composer` use its controller and pictures.
- `Composer._send`: a `! cmd` draft (web's `isShellDraft`) is refused with `shellOnComputer`, one string in six ARBs.
- Tests `draft_sync_test.dart`: echo keeps text; foreign applies when clean, not when dirty/pending; no-ack ends wait;
  scope change writes the owed text to the old session; adoption keeps keystrokes; reconcile at hello; closed socket
  turns pending into dirty; no write before hello; oversized stays local; foreign diff keeps the caret. Composer:
  "a ! draft is refused", "a foreign draft image shows from /attach", "a send writes the emptied draft".

## 4. Looking

- `WindowTab(visible: AppVisible?)`: `looking {on}` = app visible and `visible.chat` is this window; sent once open and
  speaking `looking` (at hello/replay), on each change; hidden sends `on:false` and flushes the draft.
- Test `window_tab_test`: "looking follows the app and is sent again on a new socket".

## 5. Unread

- `store/seen.dart`, `watchSeen`, `seen_test`, `chat_seen_test` go; Mark read posts the window's `POST /seen {session}`; `AppStores.unread` (`hosts/unread.dart`, in memory):
  `of(hostId, w)` = `w.unseen`, 0 for a chat left or marked read here while `replies` is unchanged; `read(hostId, w)`.
- `notify/events.dart` `detect(hostId, windows, notified, {onScreen})`: a reply notifies when `replies` grew and
  `unseen` is absent or > 0; `ReadEvent` when `unseen` drops to 0 (the notified record keeps the last `unseen`), posted
  as `platform.cancel`. `Notified.maxPerHost`.
- Tests: notify_events "unseen 0 gives no reply", "unseen dropping to 0 cancels"; hosts_screen "the badge is unseen",
  "a chat just left shows 0 until a new reply".

## 6. Docs and checks

guide (phone), architecture (phone paragraph), mobile/README (notifications), CHANGELOG. `npx tsc -b`, `npm test`,
dart/flutter analyze and test, the full suite.
