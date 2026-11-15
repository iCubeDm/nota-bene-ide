# Phone: background connection and agent notifications (issue 378)

## Intent

Android freezes the app soon after it goes to the background, so its relay connections drop and the phone learns nothing
until it is opened again. The user hands a task to an agent, puts the phone away and wants to be told when the agent has
answered or waits for them (a permission, a question, a plan), without keeping the app on screen.

## Goals

- While any agent of a connected host works or waits for the user, and for 5 minutes after the last one goes quiet, the
  app keeps its relay connections in the background (an Android foreground service).
- A local notification when a session gets a new final reply, or starts waiting for the user. A tap opens that chat.
- While no agent works and the service is off, a periodic check (every 15 minutes, as Android allows) connects, looks,
  and notifies the same way.
- Nothing for the session whose chat is on screen.

## Non-goals

- Push through Google (FCM) or any server-side change: relay, host and protocol stay as they are. Decided with the user:
  later, when needed (likely with account management).
- Keeping the connection while nothing works: the user picked "while agents work, plus a few minutes" over "always".
- iOS.

## Anti-goals

- A loud permanent notification. The service's own notification is on a minimum-importance channel: no status-bar icon,
  no sound, folded at the bottom of the shade; on Android 13+ it can be swiped away and the service keeps running.
- Reply text on a locked screen: notifications are private (the lock screen shows "New reply in <project>").
- A notification for something the user has already seen on the phone or that happened before they paired.
- Draining the battery: the service ends by itself; the check is Android's periodic work, not an alarm loop.

## Approaches

- **A. Foreground service while agents work + periodic check (chosen by the user).** Instant while agents work, a quiet
  notification in the shade; otherwise 15 min to about an hour late (Doze). Needs nothing beyond the APK.
- B. FCM push, as Telegram does: instant, no service notification, but a Firebase project, push tokens and a key on the
  relay, a new host→relay message, and no Google services means no notifications.
- C. A first, B later: what was agreed in effect; B is not part of this work.

## Design

### What counts as an event

The host already sends each device the list of its windows every 5 s and on every change (`busy`, `pending`, `replies`,
`last`, `session`, `title`, `root`), and the app already keeps per host and session how many final replies it has shown
(`store/seen.dart`). An event, per (host, session):

- **Reply:** `replies` grew beyond what the app has notified or shown for that session. Text: the project's name (the
  window title or the folder's name) and the start of `last.text` when `last.role` is `assistant`.
- **Waits for you:** `pending` turned true. Text: "<project>: the agent waits for you".
- A session first met (no entry yet) is not an event: as Seen does today, it counts as seen up to its replies.
- Notified counts are kept apart from Seen's shown counts (a notification does not mark a reply as read; opening the
  chat does, as now) and persist, so the periodic check and the service never notify the same reply twice.
- One notification per session, replaced by the next event of that session; opening the chat cancels it.
- **Waits for you** is kept per session as "notified for this wait": set when notified, cleared when the session is seen
  not pending. So a wait notifies once, a later wait (after a reply) notifies again, and a session first met already
  waiting does notify (unlike replies: a wait is for the user now).
- **On screen** means the app is visible and that chat's route is on top. Today the open chat marks replies as seen
  whenever its link changes (`chat_route.dart`, `_see`), visible or not; this changes: it marks them only while the app is
  visible, and on show it marks what arrived meanwhile. Otherwise a chat left open under a locked screen would swallow
  every reply. (Builder check; my call.)

### The foreground service

- Started by the app while it is in the foreground (Android 12+ forbids starting one from the background) whenever some
  connected window is `busy` or `pending`. So it is already running when the user leaves the app.
- Type `remoteMessaging` (Android 14 requires a type; `dataSync` is limited to 6 h a day on Android 15).
- Its notification: "Nota Bene · <n> agents working" (or "waiting for you"), minimum importance, tap opens the app.
- Stops when no window has been `busy` or `pending` for 5 minutes, when the activity is destroyed (closed from the recent
  apps list, or by Android under memory pressure: its Flutter engine and the links go with it, and the periodic check
  takes over), or when all hosts are unpaired. The service owns no engine of its own. (My call: simpler than a cached
  engine; the cost is that a destroyed activity falls back to the 15-minute check.)
- The Dart side keeps running because the process stays alive; the existing 10-minute `links.pause` timer on hide is
  replaced: links pause on hide only when the service is not running, and the service's stop pauses them.

### The periodic check

- Android WorkManager, every 15 minutes, network required. It runs Dart in the background (a headless engine), opens
  each paired host's channel through the relay with the stored identity, waits for the first window list (bounded, e.g.
  20 s), posts notifications for events as above, closes. It does not start the service (not allowed from the
  background).
- Scheduled once notifications are allowed and a host is paired; cancelled when none is.
- One device key, one connection: the relay closes an older connection of the same device to a host with 4409, and the
  app's link stops on 4409. So the worker never opens its own connections while the main engine is alive. The native
  side knows whether `MainActivity` exists: if it does, the worker asks the main engine over its method channel to run
  the check (resume the paused links for up to 20 s, notify, pause again; nothing when the links are already running);
  only without an activity does the worker start a headless engine and connect itself. An app opened during a headless
  check connects normally and wins; the worker's connection ending early is fine. (My call.)
- The stores (Seen's shown counts, the notified state) are written by whichever engine checks; the main engine reads them
  again on show, so it never acts on stale counts written before a headless check.

### Permissions and settings

- `POST_NOTIFICATIONS` (Android 13+) is asked the first time the service would start, with a sentence before the system
  dialog. Refused: no notifications and no service; the app works as today.
- Settings: a **Notifications** switch (on by default once allowed) that turns off the service, the check and the
  notifications together; shown with a hint and a button to the system settings when Android refuses them.
- Battery optimisation: not asked for in this change. If the service turns out to lose its network in Doze on the
  user's phone, a follow-up adds the "ignore battery optimisations" request.

### Native code

- In `android/app` beside `MainActivity.kt`, which already holds the app's channels: a `Service` subclass, notification
  channels (service: minimum importance; replies: default importance, private visibility), and a method channel to
  start, update and stop the service and to post and cancel event notifications. A notification's tap opens
  `MainActivity` with the host id, port and root; the app opens that chat as it opens the last chat at start.

### Strings

New strings (notification texts, channel names, the permission sentence, the setting and its hint) in all six app
languages (`lib/l10n/app_*.arb`). The channel names and notification texts the native side shows are passed in from Dart
in the current language.

- Distribution: the APK is installed by hand (CI artifact), not through Google Play, so the `remoteMessaging` type
  needs no store declaration. Manifest: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_REMOTE_MESSAGING`,
  `POST_NOTIFICATIONS`.

## Left to the builder

- Plugins or own code for WorkManager's headless Dart (the `workmanager` package is the usual way) and for notifications
  (own Kotlin through the method channel is preferred over a large plugin; the project already does its native work so).
- Where the event detection lives (likely next to Seen, fed by the links' window lists), its names, and its tests.
- The exact wording of strings.

## Must be checked on the user's phone

The service keeps the socket alive with the screen off for at least 15 minutes; notifications arrive while the phone is
locked; the periodic check fires after the app was closed from recents.
