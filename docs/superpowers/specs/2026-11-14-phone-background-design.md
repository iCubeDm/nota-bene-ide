# Phone: background connection and agent notifications (issue 378)

## Intent

Android freezes the app soon after it goes to the background, dropping relay connections, so the phone learns nothing until reopened. The user hands a task to an agent, puts the phone away and wants to be told when the agent has answered or waits (permission, question, plan) without keeping the app on screen.

## Goals

- While any agent of a connected host works or waits, and 5 minutes after the last goes quiet, the app keeps relay connections in the background (Android foreground service).
- A local notification when a session gets a new final reply or starts waiting; a tap opens that chat.
- While no agent works and the service is off, a periodic check (every 15 min, as Android allows) connects, looks and notifies the same way.
- Nothing for the session whose chat is on screen.

Non-goals: push through Google (FCM) or any server-side change (relay, host, protocol unchanged; later, likely with account management); keeping the connection while nothing works (user picked "while agents work, plus a few minutes" over "always"); iOS.

Anti-goals: a loud permanent notification (the service's notification is on a minimum-importance channel: no status-bar icon, no sound, folded at the bottom; on Android 13+ swipeable while the service keeps running); reply text on a locked screen (private: "New reply in <project>"); notifying what the user already saw or what happened before pairing; draining the battery (service ends by itself; the check is Android periodic work, not an alarm loop).

## Approaches

- **A. Foreground service while agents work + periodic check (chosen by the user).** Instant while agents work with a quiet notification; otherwise 15 min to about an hour late (Doze). Needs nothing beyond the APK.
- B. FCM push as Telegram: instant, no service notification, but needs a Firebase project, push tokens and a key on the relay, a new host-to-relay message, and no Google services means no notifications.
- C. A first, B later (agreed in effect); B is not part of this work.

## Design

### What counts as an event

The host already sends each device its windows list every 5 s and on change (`busy`, `pending`, `replies`, `last`, `session`, `title`, `root`), and the app keeps per host and session how many final replies it has shown (`store/seen.dart`). Per (host, session):

- Reply: `replies` grew beyond what was notified or shown. Text: project name (window title or folder) and the start of `last.text` when `last.role` is `assistant`.
- Waits for you: `pending` turned true. Text "<project>: the agent waits for you".
- A session first met (no entry) is not a reply event: it counts as seen up to its replies.
- Notified counts are separate from Seen's shown counts (a notification does not mark read; opening the chat does) and persist, so the check and the service never notify one reply twice.
- One notification per session, replaced by the next event; opening the chat cancels it.
- "Waits for you" is kept as "notified for this wait": set when notified, cleared when seen not pending. A wait notifies once, a later wait notifies again, and a session first met already waiting does notify (a wait is for the user now).
- "On screen" = app visible and that chat's route on top. Today the open chat marks replies seen whenever its link changes (`chat_route.dart`, `_see`), visible or not; change: mark only while the app is visible, and on show mark what arrived meanwhile, else a chat left open under a locked screen would swallow every reply (builder check; my call).

### The foreground service

- Started by the app while in the foreground (Android 12+ forbids background start) whenever a connected window is `busy` or `pending`, so it already runs when the user leaves.
- Type `remoteMessaging` (Android 14 requires a type; `dataSync` is limited to 6 h/day on Android 15).
- Notification: "Nota Bene · <n> agents working" (or "waiting for you"), minimum importance, tap opens the app.
- Stops when no window was `busy`/`pending` for 5 min, when the activity is destroyed (recents or memory pressure: the Flutter engine and links go with it and the periodic check takes over), or when all hosts are unpaired. The service owns no engine (my call: simpler than a cached engine; a destroyed activity falls back to the 15-min check).
- Dart keeps running as the process stays alive; the existing 10-minute `links.pause` on hide is replaced: links pause on hide only when the service is not running, and the service's stop pauses them.

### The periodic check

- WorkManager every 15 min, network required; runs Dart in a headless engine, opens each paired host's channel with the stored identity, waits for the first window list (bounded, ~20 s), posts notifications, closes. It does not start the service (not allowed from background). Scheduled once notifications are allowed and a host is paired; cancelled when none is.
- One device key, one connection: the relay closes an older connection of the same device with 4409 and the app's link stops on 4409, so the worker never opens its own connection while the main engine is alive. Native code knows whether `MainActivity` exists: if so the worker asks the main engine over its method channel to run the check (resume paused links up to 20 s, notify, pause again; nothing if links already run); only without an activity does it start a headless engine and connect. An app opened during a headless check connects normally and wins; the worker's connection ending early is fine (my call).
- The stores (Seen counts, notified state) are written by whichever engine checks; the main engine re-reads them on show so it never acts on stale counts.

### Permissions and settings

- `POST_NOTIFICATIONS` (Android 13+) asked the first time the service would start, with a sentence before the system dialog. Refused: no notifications and no service; the app works as today.
- Settings: a **Notifications** switch (on by default once allowed) turning off service, check and notifications together, with a hint and a button to system settings when Android refuses them.
- Battery optimisation not asked for in this change; if the service loses its network in Doze on the user's phone, a follow-up adds the "ignore battery optimisations" request.

### Native code and strings

- In `android/app` beside `MainActivity.kt` (which holds the app's channels): a `Service` subclass, notification channels (service: minimum importance; replies: default importance, private visibility), and a method channel to start/update/stop the service and post/cancel event notifications. A tap opens `MainActivity` with host id, port and root; the app opens that chat as it opens the last chat at start.
- New strings (texts, channel names, permission sentence, setting and hint) in all six languages (`lib/l10n/app_*.arb`); channel names and notification texts shown natively are passed from Dart in the current language.
- The APK is installed by hand (CI artifact), not via Google Play, so `remoteMessaging` needs no store declaration. Manifest: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_REMOTE_MESSAGING`, `POST_NOTIFICATIONS`.

## Left to the builder

Plugins or own code for WorkManager's headless Dart (`workmanager` is usual) and notifications (own Kotlin through the method channel preferred over a large plugin, as the project does natively); where event detection lives (likely next to Seen, fed by the links' window lists), its names and tests; string wording.

## Must be checked on the user's phone

The service keeps the socket alive with the screen off for at least 15 min; notifications arrive while locked; the periodic check fires after the app was closed from recents.
