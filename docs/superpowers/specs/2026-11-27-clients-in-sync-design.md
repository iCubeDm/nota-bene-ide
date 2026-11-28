# A window on every client at once (issue 174): design

Status: agreed (architect and critic, two rounds). Scope: the three open items of #174. Comment ops (epic 259) are done and stay as they are.

User decisions (binding): the phone's protocol floor may go to 41, and **the draft is kept per session**.

## 1. What the user sees

- **Every client of a window is live at once:** the browser tabs on this computer, the phone, and another computer's
  tab. None is parked and none is kicked out. A send, an answer, Stop, or a mode or model change shows on all of them.
- **Gone:** the "already open in another tab" / "Open in another tab" overlay and **Work here**, on the web and the
  phone. The `?tab=` / `?passive=1` rules and close code 4001 go with them.
- **Shared draft, per session (as Telegram's per chat):** the composer's text and its uploaded images are the draft of
  the open session, kept by the server.
  - Type on the computer, open the phone: the text is there.
  - Switching to another session shows that session's draft; switching back brings the first one back.
  - The last edit wins; there is no character-level merging.
  - A send from any client clears the draft everywhere.
  - The draft survives a reload, a server restart, an update and a fresh launch, since it is kept by session id.
- **Shared read state:** a reply seen on one client is seen on all of them. The phone's list badge and its
  notification, the web's Inbox "Done, unread", the switcher rows and the favicon's done dot all read one server mark.

## 2. Server: no owner

In `server/src/agent.ts` (the WSS section, about lines 460–860):

- **What goes:** `owner`, `takeover()`, `role` (pending/occupied/owner), `ownerGone`, the grace (`TAKEOVER_GRACE_MS`,
  `takeoverGraceMs`), `passive` and `tab` handling, the `oneTab` option (also in `server.ts` `ServerOptions`) and the
  `hub.ts` stamp-list entries for `occupied`/`taken-over`.
- **What every connection runs:** today's `attachOwner` (renamed `attach`) and `handleOwner` (renamed `handle`). That is
  exactly the `oneTab: false` path, which the tests already exercise.
- **Heartbeat per socket:** one interval pings every socket in `wss.clients`, and terminates one whose last ping got no
  pong (the same 30 s). Otherwise a dead socket would inflate `clients()` (update hand-over, fold) and `askers`
  (a restart pending forever).
- **Per-socket flags stay per socket:** `asksInPause` (`pause=1`), `holds` (`held=1`) and `follows` (`go=1`).
- **`open-agent`:**
  - `shownSince()` is the newest attach order among this agent's open `go=1` sockets.
  - `show(id)` sends `open-agent` to that one socket only.
  - `owned()` and its branch in `server.ts` `showIn` go.
- **Attach:** the replay and the state frames as now, plus `draft` and `seen`; `hello` stays last.
- **Counting:** `/info.clients` and `tabs()` count every socket.

**Interleaving.** The server already behaves this way with several sockets:

- **Two sends:** they go in arrival order. A mid-turn send queues as the next turn.
- **Two answers to one ask:** `manager.answer` takes the first. The losing socket alone gets
  `server-error {where:'permission'}` "already answered", as the HTTP route's 409. A silent deny must not lose to an
  allow without a word. Everyone gets `permission-done`, and the web card and the phone's sheet settle on it already.
- **Stop, interrupt, `task-stop`, mode, model, compact, compact-cancel, restart, switch:** any client may send them.
  Mode and model keep their `ack`.
- **`! cmd`:** a second run while one runs gets `shell-refused running` on its socket only. The text comes back into
  the draft.
- **Restart in a pause (gh-422):** the first `pause=1` page to reach its pause asks for it. This is a conscious
  narrowing of gh-422: another page's upload in flight then fails with its usual toast, and the phone never asked
  anyway (`server.ts:177`). The restart keeps every page.

## 3. Shared draft (per session)

**Shape** (`shared/src/protocol.ts`):

```ts
type DraftImage = { id: string; mediaType: ImageType };      // an uploaded attachment (ImageEntry)
// client; sessionId: the session the draft belongs to, null = the current one before it has an id (as comment-op)
| { type: 'draft'; id: string; sessionId: string | null; text: string; images?: DraftImage[] }
// server, never stored in history; ack: the write it applied
| { kind: 'draft'; sessionId: string | null; text: string; images?: DraftImage[]; ack?: string }
export const DRAFT_MAX = 256 * 1024; // text chars
```

**Server store**, a new `server/src/drafts.ts` (`DraftStore`):

- One file per session, `<stateDir>/drafts/<sessionId>.json` (`SAFE_SESSION_ID`, `writeJsonAtomic`, mode 0600), as
  comments do.
  - Rejected: one `drafts.json`. Every server of a provider shares `stateDir`, so a single file would need a merging
    read-modify-write on every debounced flush.
  - Per-session files need no cap, and an empty draft removes its file.
- Values are held in memory, and each session's file is written debounced by 1 s. A switch and `close()` flush it.
- **The null session** (a new conversation before its id) lives in memory. It is adopted in `onSessionId` when
  `prev === null`, and dropped in `onSwitch` when `!restart`: the same hooks and rules as comments and prompts
  (`agent.ts:200-217`). A `/clear` or a fork carries no draft: the old session keeps its own.
- `forgetDeleted` (the session delete route) also calls `drafts.forget(id)`.

**`case 'draft'`** in `agent.ts`:

- Validate the write and store it under `msg.sessionId ?? current`.
- If that is the current session and no switch is running, broadcast
  `{kind:'draft', sessionId: current, ...d, ack: msg.id}` (`store:false`).
- Otherwise store it and answer nothing. The writer has already moved on; see "scope change" below.
- `broadcastDraft()` (the current session's draft, no ack) runs on attach and in the `onSwitch` and `onSessionId`
  hooks, beside `broadcastComments()`.
- A switch that fails (`switchFailed`) also broadcasts the current draft. A `draft` event with no `ack` clears a
  client's `pending`, so a write that reached the server during someone else's failed switch does not leave that
  client deaf to others' drafts.

**Client rule: last write wins, in server arrival order, with no revision** (a socket's frames are ordered). The client
keeps:

- `scope`: the `sessionId` of the last `draft` event it took. Its writes are tagged with it.
- `pending`: the id of its last write that has not been acked.
- `dirty`: local edits since that write.
- `typedInSwitch`: set by an edit made while `controls.switching`. Writes are held while a switch runs, because the
  server would store them in the old session.

Writing:

- A local edit sets `dirty`.
- Writes are throttled, leading and trailing, at most one every 300 ms.
- They are flushed at once on send, blur, `pagehide` and `visibilitychange` hidden, and on the phone's app pause.
- A write sets `pending = id` and clears `dirty`.

Receiving a `draft` event. The receive side is never feature-gated: the event itself proves support (B2).

- **`ack === pending`** is this client's own echo. Clear `pending` and ignore the text, so the typing client's caret
  never moves.
- **`sessionId === scope`** (or `scope` is unset, the first one): apply it only when `!pending && !dirty`. Otherwise this
  client's next write wins, and the clients converge on the server's last write.
- **`scope === null`**, and the event names an id: retag (`scope = id`). This is an adoption (the new conversation got
  its id), or a switch out of a conversation that never had one. Apply the text if clean. A dirty text carries over
  only when the event's draft is empty (an adoption's always is); otherwise the event's draft wins. One rule, with no
  300 ms timing.
- **Scope change**, an identified `scope` to another session (a switch, a `/clear` or a fork, from any client):
  1. If `dirty && !typedInSwitch`, write once, tagged with the old `scope`. It lands there; no echo comes back.
  2. Set `pending = null` and `scope = sessionId`.
  3. If `typedInSwitch`, keep the local text and write it to the new session. That is today's "the draft waits for the
     new session" (`Composer.tsx:35`). Otherwise apply the event.

Attach (B2):

- The attach `draft` arrives before `hello` and is applied by the rule above.
- **Reconcile at `hello`:** if `dirty || pending` and `has(protocol, 'draft')`, flush. A `pending` write is lost with
  a dropped socket, so `connState` closed turns `pending` into `dirty`.
- Only the sending side is gated: an older server keeps today's local draft.

**Caret on a foreign apply.**

- Web: `EditorField` (`EditorField.tsx` `value` effect, about l.108) dispatches the minimal change (the common prefix
  and suffix cut off) and lets CodeMirror map the selection. The caret goes to the end only when the document was
  empty.
- Phone: the same diff on the `TextEditingController`.

**Clearing.**

- A send's existing `draftGone` (it keeps the tail typed since) and `removeImage` are local edits, flushed at once.
- A refused send's put-back (`refused.ts`) is a local edit too, so the text comes back everywhere.
- The server never clears on `send`, so an old client cannot erase a shared draft.

**What the draft holds.**

- **In it:** the text (a `! cmd` draft included) and the uploaded image refs. Pending comments are already shared, and
  an attachment-anchored comment is "detached" on the other client while its image lives in one composer only.
- **Not in it:** uploads in flight, a recording, the recall walk, the pickers.

**Web** (`plugins/composer/draftSync.ts`, a listener): it watches `setDraft`, `addImage`/`removeImage`, `draft`,
`hello`, `connState` and `controls.switching`.

- A foreign apply dispatches `draftApplied` (composer slice) and `imagesApplied` (the `message` slice; it clears
  `marking` when that image went), so the listener does not take it for a local edit.
- The update pause (`plugin.ts` `pause`) counts the draft only while it is unsynced, since a synced draft now survives
  the reload.

## 4. Shared read state

**What "read" is:** the server's existing per-session mark (`server/src/seen.ts`, `seen-sessions.json`). `/info.unseen`
is the number of final replies after it (`hub.summary`).

**Why it changes:** the page POSTs `/seen` (throttled to 2 s) and the phone keeps a local count (`store/seen.dart`).
The two never agree, and a notification races the POST against the host stream's 5 s poll.

**Presence:** a client message `{ type: 'looking'; on: boolean }`, sent on change and again at each `hello`, gated by
`has(protocol, 'looking')`.

- Web: `!document.hidden && document.hasFocus()`, with the triggers of `plugins/projects/seen.ts`, renamed `looking.ts`.
- Phone: the app is visible and `AppVisible.chat` is this window.

**Server:**

- A `lookers` set of sockets; a closed socket is removed from it.
- While the set is not empty and the session has an id, the server marks the session seen:
  - when a socket turns `on`;
  - synchronously, in a `hub.tap`, on each event `hub.summary` counts as a final reply, so no later `/info` shows it
    unseen;
  - on `onSessionId` and on a switch.
- Each mark broadcasts `{ kind: 'seen'; at: number }` (`store:false`), and attach sends it too. Receiving it is not
  gated.
- The page's throttled `POST /seen` goes. An old page left open across a restart then marks nothing until it is reloaded;
  this is accepted and written down here.
- `POST /seen {session}` stays for the phone's **Mark read** (PR 4): an explicit mark is a user action, not the
  throttled presence POST that raced the poll. It marks the open session and broadcasts `seen`.

**Host stream:** `unseen` is added to `HostWindow` and `HOST_WINDOW_INFO` (`shared/src/host.ts`). `projects.ts` (about
l.130) uses `w.unseen ?? 0` for another computer's rows instead of 0.

**Consumers:**

- The web's Inbox and switcher are unchanged (they read `/info.unseen`).
- The Favicon clears its done/error dot when a `seen` arrives with `at` ≥ the last turn's end (`controls.seenAt`).
- Phone list badge: `w.unseen`. The chat the phone just left shows 0 until a host list with higher `replies` arrives
  (held in memory), so the 5 s poll does not flash a stale badge.
- Phone notifications (`notify/events.dart` `detect`):
  - A reply notifies only when `replies` grew and `w.unseen` is absent or above 0.
  - A session whose `unseen` drops to 0 has its notification cancelled (`platform.cancel('$host $session')`).
  - The local `Seen` store goes; `Notified` stays.

**Known limit:** omp/ACP replays carry `ts` 0 (`agent/acp/session.ts:43`), so after a server restart an omp window's
unread count clears. The phone's local count used to keep it. Fix the stale comment at `hub.ts:182` with this change.

## 5. Protocol and compatibility

**Protocol per PR:**

- **PR 1** → protocol 39, with no FEATURES entry: nothing gates on it.
- **PR 2** → 40, `draft: 40`.
- **PR 3** → 41, `looking: 41`.
- **PR 4:** `taken-over`, `takeover` and `TAKEN_OVER_CODE` leave `shared/`. `occupied` stays, documented as "a server
  before 39", for the web's notice below.
- Each PR runs `npm run gen:protocol`.

**Mixed versions:**

- **An old page or old phone with a new server:** it is never told `occupied`, so it is always attached and works. It
  keeps a local draft and ignores `draft`/`seen` (the reducers' `default`, Dart's `ServerEventUnknown`). The old
  phone keeps its local unread count.
- **A new page with an older server** (the dev loop's rebuild before "Restart the server"): on `occupied` the page
  shows a toast, "This window's server is older than the page: restart the server". That is one string in every LANG,
  with no takeover. It never answers `takeover`: two new tabs would kick each other in a loop.
- **A new phone with a server before 41:** the floor is `Feature.looking`. The window is not opened, and the chat says
  to update the computer (`hostTooOld`, #722).
- **Another computer's tab:** the host's own page on the host's server, so their versions always match. It gets
  `unseen` through the host stream.

## 6. Phone (PR 4)

- **`agent_connection.dart`:**
  - drop `TabState.occupied` and `taken`, `takenOverCode`, `_passive`, `_takeoverWanted`, `takeOver()` and `tab=`;
  - the URL becomes `/ws?held=1`;
  - `floor = Feature.looking`.
- **Covers and strings:** `one_tab.dart` keeps only the gone-window cover. `session_state.dart` loses its occupied/taken
  branch, and the `occupiedTitle`, `takenTitle` and `workHere` strings leave all six ARBs.
- **Draft:**
  - A `DraftSync` lives in `WindowTab`. `ChatRoute` owns the tab, so in memory the draft goes with the route; it
    outlives it on the server, where the last write is flushed as the route goes.
  - It follows the rule in §3, and its writes are flushed on send and on app pause.
  - A draft image from another client renders from the window's attachment URL.
  - Send refuses a draft that starts with `!` (but not `![`): the phone has no shell run, and that text must not reach
    the agent as a prompt. This adds one string.
- **Looking:** `WindowTab` sends `looking` when `AppVisible` changes and at `hello`.
- **Unread:** `store/seen.dart` and `watchSeen` are deleted, and `Seen` leaves `AppStores`, `home.dart`,
  `notify/headless.dart` and `notify/background.dart`. The badges and notifications work as in §4.

## 7. Edge cases

- **Concurrent edits on two clients:** the last write to arrive wins. A sender's `''` can lose to the other client's
  later edit, which brings the sent text back as a draft. That is Telegram's behaviour, and it is accepted.
- **Images in the same write:** text and images are one last-write-wins object. A photo added on the phone within one
  throttle window of the computer's edit can be dropped. This is rare (one person, two devices, within 300 ms).
- **Sending at the same moment:** two clients can send the same draft at once, with the pending comments riding along
  twice (`markSent`). Accepted; the odds are low.
- **Typing in a switch made elsewhere:** a client that did not start the switch does not know it is running. Its last
  edit lands in the old session, and its field then shows the new session's draft. Nothing is lost: the text is in
  the old session.
- **Typing offline:** the edits stay `dirty` and are flushed at `hello`. They win over edits made elsewhere meanwhile;
  the order is arrival, not edit time.
- **Draft over `DRAFT_MAX`:** it stays local and is not synced, and the parser refuses one.
- **Zombie socket:** one that stays `looking` marks replies seen until the heartbeat ends it (≤ 60 s). The phone sends
  `on:false` when it hides.
- **Losing an ask:** the losing client's half-filled structured answer is dropped when `permission-done` arrives.

## 8. Tests (behaviours)

**Server:**

- **Clients:**
  - every socket gets the replay and the state;
  - a live event reaches every socket;
  - any socket may send;
  - `tab` and `passive` are ignored;
  - a silent socket is terminated while the others stay;
  - `clients` counts every socket;
  - two answers to one ask reach the agent once, and the loser hears "already answered";
  - `open-agent` reaches only the newest `go=1` socket.
- **Drafts:**
  - attach carries the current session's draft;
  - a write is broadcast with its ack;
  - a write tagged with the previous session after a switch lands there and is not shown;
  - a switch sends the new session's draft;
  - the null session's draft is adopted under its first id and dropped by a switch;
  - a deleted session's draft goes;
  - the draft survives a server restart;
  - an invalid or oversized draft is refused;
  - drafts and `looking` are not audited (`audit.ts:117` early return).
- **Read state:**
  - a looker plus a final reply leaves `unseen` at 0, and with no looker it is 1;
  - turning `on` marks the session;
  - a closed looker stops marking;
  - `seen` is broadcast;
  - host rows carry `unseen`.

**Web:**

- no `taken` or `occupied` states, and no `tab`/`passive` parameters;
- `occupied` from an old server shows the notice;
- the §3 draft rule: echo, foreign draft when clean or dirty, scope change, typing in a switch, adoption;
- reconcile at `hello`, including when the attach `draft` arrives before `hello`;
- a send flushes `''`;
- writes are not sent below 40;
- an outside change keeps the caret in place;
- `looking` follows focus and visibility, and is sent again at `hello`;
- `seen` clears the favicon dot;
- `i18n.test` passes.

**Phone:**

- no occupied or taken states, and floor 41;
- the same draft rule;
- a `!` draft is refused;
- no notification when `unseen` is 0, and the notification is cancelled when it drops;
- the badge comes from `unseen`.

**E2E** (`e2e/clients.spec.ts` replaces `onetab.spec.ts`; two pages on one window):

- both pages are live, and a send from either shows in both;
- a draft typed in A appears in B; sending from B clears A; a reload keeps it; switching sessions shows each session's
  own draft;
- an ask answered in A is resolved in B.

`OneTab.test.tsx` and `onetab.test.ts` are deleted, and `oneTab: false` leaves about 12 test files.

## 9. Pull requests (in order, each green on main)

1. **gh-A: every client is attached; Work here is gone (server, web, docs).**
   - Server: §2.
   - Web:
     - delete `OneTab.tsx`;
     - `ConnState` loses `occupied` and `taken`;
     - `takeOver` leaves connection, store and sdk;
     - `socket.ts` drops the 4001 branch and the takeover-only send;
     - the `tab` and `passive` URL parameters go;
     - `App.tsx`, `keymap.ts`, `Favicon.ts`, `repository.ts` (`DOWN`) and `feed.ts` follow;
     - the three strings go and the older-server notice comes in, in every LANG.
   - Docs: `guide.md` l.88–90, 594, 630 and 641; `architecture.md` l.154, 221 and 566–577; `agent-reference.md`
     l.103, 292 and 347; CHANGELOG.
   - The phone is untouched: against a new server it is always open.
2. **gh-B: the shared draft, per session (server, shared, web).** §3. The phone keeps its local draft until PR 4.
3. **gh-C: shared read state (server, shared, web, host stream).** §4.
4. **gh-D: the phone joins (mobile, shared).** §6, plus the removal of the old shapes in §5.

PRs 2 and 3 are independent of each other, and PR 4 needs all three.

## 10. Open questions

None. Both earlier questions were answered: the floor goes to 41, and the draft is per session.
