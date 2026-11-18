# Phone background connection and notifications Implementation Plan

**Goal:** The phone keeps its relay links while agents work (a foreground service), notifies about agent replies and waits, and checks every 15 minutes otherwise.

**Approach:** Event detection is pure Dart over the window lists the host already pushes, with its own persisted store beside Seen. A Dart `Background` controller drives a small native Kotlin layer (service, notifications, WorkManager) through one method channel, `nb/background`. The periodic worker asks the live main engine to check, or runs a headless Dart entry point when there is no activity.

**Spec:** `docs/superpowers/specs/2026-11-14-phone-background-design.md`. Issue/commit prefix `gh-378`.

## Decisions

- No change to relay, host, server or protocol. No notification or workmanager Flutter plugin: own Kotlin beside `MainActivity.kt`; AndroidX WorkManager (`androidx.work:work-runtime-ktx`) only.
- Service: `foregroundServiceType="remoteMessaging"`; manifest adds `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_REMOTE_MESSAGING`, `POST_NOTIFICATIONS`; minSdk 24 stays. It runs while any window of an online link is `busy` or `pending`, and 5 minutes after the last one.
- Periodic check: every 15 minutes, network required, first window list waited for at most 20 s per host.
- Channels: service minimum importance, no sound; events default importance, `VISIBILITY_PRIVATE` with a public version ("New reply in <project>" / "<project>: the agent waits for you"), no message text.
- Six languages for every string; never log message text, keys or host addresses; neutral fixtures.
- "Seen" counts only while the app is visible, so a chat left open under a locked screen still notifies.
- The worker and the app share one device key: with the activity alive the worker calls the main engine's `check`, never `connectChannel` (else our own worker would cause a 4409).
- A session pending across many checks notifies once. Activity destroyed while the service runs: service stops (`onDestroy`), `engineGone` makes `Background` stop and pause. Notifications refused: behave as today, no service start, no crash.

## Contracts

- Event detection (`lib/notify/events.dart`, `lib/store/notified.dart`): `Notified extends ChangeNotifier` (slot `nb.notified`, JSON `{host: {session: {"r": int, "w": bool}}}`, unreadable gives empty, `prune`, at most `Seen.maxPerHost` sessions per host); `sealed AgentEvent {hostId, port, root, session, project}` with `ReplyEvent(text?)` and `WaitEvent`, `key = '$hostId $session'` (notification tag); `detect(hostId, windows, seen, notified, {onScreen})` mutates `notified`, saves once; `projectOf(w)` is the title, else last segment of `root`. Rules: reply when `replies > max(seen, notified r)`; a session with no Seen entry is no reply event; `r` set after notifying and lowered when `replies` drops; wait when `pending` and `w` false then `w = true`, cleared when not pending; first-met pending notifies; `onScreen` gives no event but `r`/`w` still advance. `ReplyEvent.text` is `last.text` only for an assistant message, cut to 120 characters.
- Visibility (`lib/notify/visible.dart`): `AppVisible` (`AppLifecycleListener` show/hide; `chat` = the chat route on top, set on route init and cleared on dispose; a screen pushed over the chat keeps it); `onScreen` = visible and chat matches port and root. `ChatRoute._see` returns early when not visible and marks what arrived on show.
- Native channel `nb/background` (`lib/notify/platform.dart`, `BackgroundPlatform`, `ChannelBackground`, `FakeBackground` in `test/support/fakes.dart`): `permission()` (`granted|denied|ask`), `requestPermission`, `startService/updateService/stopService`, `notify({tag, title, text, publicTitle, hostId, port, root, channelName})`, `cancel(tag)`, `schedule(on)`, `openSettings`, `opened` stream (tapped notification, plus `takeLaunch()` once at start), `onCheck(check)`. Service via `startForegroundService` + `startForeground(..., TYPE_REMOTE_MESSAGING)` (API 29+, plain below); `ForegroundServiceStartNotAllowedException` is caught and answered as an error. Event notifications: tag = `key`, `PendingIntent` to `MainActivity` with `hostId`, `port`, `root` extras, auto-cancel, public version.
- `Background({links, seen, notified, visible, platform, strings, linger = 5 min, enabled})` (`lib/notify/background.dart`): on every links change `detect` per online link, `notify`/`cancel` (cancel when that session's chat opens). Busy/pending while visible and permission `ask`: explanation then `requestPermission`; granted starts the service; denied is remembered, not asked again. Service text "n agents working" / "waiting for you". Quiet for `linger` stops the service, then if hidden `links.pause()`. Hide with service off pauses links; show resumes and reloads `seen`/`notified` (replaces `home.dart`'s 10-minute pause timer). `check({wait = 20 s})` resumes paused links, waits until all are past `connecting` or `wait`, detects, pauses again unless visible or service runs. `schedule(true)` only when enabled, permission granted and a host paired.
- Periodic check: `PeriodicWorkRequest` 15 min, `NetworkType.CONNECTED`, unique `nb-check`, `KEEP` (`CheckWorker.kt`). Activity alive (static flag set in `onCreate`, cleared in `onDestroy`): invoke `check` on the main engine (60 s cap). Otherwise start a `FlutterEngine` with entry `backgroundCheck` (`lib/notify/headless.dart`, `runCheck({vault, connect, platform, strings, wait})`: load Identity, Hosts, Seen, Notified; per host connect, first window list or give up at `wait`, `Seen.observe`, `detect` with nothing on screen, post, close), wait for `done` (60 s cap), destroy the engine. Headless language: stored `LangChoice`, else system locale.
- Settings: switch stored in the vault (`nb.notify`, default on) calling `Background.setEnabled`; with permission denied a hint and a settings button. ARB keys `notifySetting`, `notifyHint`, `notifyDenied`, `notifyOpenSettings`, `notifyAsk`, `notifyChannelService`, `notifyChannelEvents`, `notifyServiceWorking`, `notifyServiceWaiting`, `notifyReplyPublic`, `notifyWaiting`. Docs: `mobile/README.md`, `docs/guide.md`, `CHANGELOG.md`.

## Files

`lib/notify/{events,visible,platform,background,headless}.dart`, `lib/store/notified.dart`, `lib/chat/chat_route.dart`, `lib/home.dart`, `lib/main.dart`, `lib/settings_screen.dart`, six ARB files; Kotlin `AgentService.kt`, `Notices.kt`, `CheckWorker.kt`, `MainActivity.kt`, `AndroidManifest.xml`, `build.gradle.kts`. Tests: `notify_events`, `chat_seen`, `notify_platform`, `background`, `headless`, `settings`.

## Device check

Signed APK from the branch via `gh workflow run mobile.yml`. User checks: long agent turn with phone locked 15+ minutes notifies; tap opens the chat; service line goes quiet 5 minutes after; after closing from recents a reply notifies within the next check. Fix what the device shows, then PR, CI, review.
