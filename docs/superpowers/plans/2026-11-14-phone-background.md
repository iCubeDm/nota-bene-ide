# Phone background connection and notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone keeps its relay links while agents work (a foreground service), notifies about agent replies and
waits, and checks every 15 minutes otherwise.

**Architecture:** Event detection is pure Dart over the window lists the host already pushes, with its own persisted
store beside Seen. A Dart `Background` controller drives a small native layer in Kotlin (service, notifications,
WorkManager) through one method channel, `nb/background`. The periodic worker asks the live main engine to check, or
runs a headless Dart entry point when there is no activity.

**Tech Stack:** Flutter (Dart 3.8), Kotlin in `android/app`, AndroidX WorkManager, `flutter_test`.

**Spec:** `docs/superpowers/specs/2026-11-14-phone-background-design.md`

## Global Constraints

- No change to relay, host, server or protocol.
- Service: `foregroundServiceType="remoteMessaging"`; manifest adds `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_REMOTE_MESSAGING`, `POST_NOTIFICATIONS`. minSdk stays 24.
- Service keeps running while any window of an online link is `busy` or `pending`, and 5 minutes after the last one.
- Periodic check: every 15 minutes, network required, first window list waited for at most 20 s per host.
- Service channel: minimum importance, no sound. Event channel: default importance, `VISIBILITY_PRIVATE` with a public
  version "New reply in <project>" / "<project>: the agent waits for you" (no message text).
- Every user-visible string in all six `lib/l10n/app_*.arb` (en, de, es, pt, ru, zh), real translations.
- Never log message text, keys or hosts' addresses.
- Native work in own Kotlin beside `MainActivity.kt` (no notification or workmanager Flutter plugin).
- Public repo: neutral fixtures.

## Review Focus

1. A chat left open under a locked screen: replies must still notify (Task 2 test: hidden app, open chat, new reply →
   not seen, event emitted).
2. The worker and the app with one device key: the app's link must never get a 4409 from our own worker (Task 5 test:
   activity alive → the worker calls the main engine's `check`, never `connectChannel`).
3. A long wait: a session pending across many checks notifies once (Task 1 test).
4. The phone restarted or the activity destroyed while the service runs: the service stops, no stale "agents working"
   (Task 3 native `onDestroy` → stop; Task 4 test: `engineGone` → `Background` stops and pauses).
5. Notifications refused: the app behaves as today, no service start, no crash (Task 4 test with `permission: denied`).

---

### Task 1: Event detection and the notified store

**Files:**
- Create: `mobile/app/lib/notify/events.dart`
- Create: `mobile/app/lib/store/notified.dart`
- Test: `mobile/app/test/notify_events_test.dart`

**Interfaces:**
- Produces:
  - `class Notified extends ChangeNotifier` — `static Future<Notified> load(Vault v)` (slot `nb.notified`, JSON
    `{host: {session: {"r": int, "w": bool}}}`, unreadable → empty, as Seen), `Future<void> reload()`,
    `void prune(Set<String> hostIds)`, at most `Seen.maxPerHost` sessions per host.
  - `sealed class AgentEvent { String hostId; int port; String root; String session; String project; }` with
    `ReplyEvent(... , String? text)` and `WaitEvent(...)`. `String get key => '$hostId $session'` (notification tag).
  - `List<AgentEvent> detect(String hostId, List<HostWindow> windows, Seen seen, Notified notified, {bool Function(String hostId, HostWindow w)? onScreen})`
    — mutates `notified`, saves once when changed.
  - `String projectOf(HostWindow w)` — the title, else the last segment of `root`.

Rules (from the spec): reply when `replies > max(seen.seenOf, notified r)`; a session with no Seen entry is no reply
event (Seen.observe records it); `r` is set to `replies` after notifying and lowered when `replies` drops; wait when
`pending` and `w` false → event, `w = true`; `pending` false → `w = false`; first-met pending notifies; `onScreen` true
→ no event, and `r`/`w` still advance so leaving the chat does not notify old things. `ReplyEvent.text` is `last.text`
only when `last.role == 'assistant'`, cut to 120 characters.

- [ ] **Step 1: Write the failing tests** in `notify_events_test.dart` (MemoryVault; Seen fed with `observe` first, as
  the app does):
  - `a reply beyond the seen count is one event, the same list again is none`
  - `a reply already seen on the phone is no event`
  - `a session first met is no reply event`
  - `a wait notifies once over many lists, again after it ended`
  - `a session first met already waiting notifies`
  - `the session on screen gives no event and does not notify later`
  - `a lower reply count (new history) notifies the next reply again`
  - `the reply text is the assistant's, cut to 120 characters; a user last message gives none`
  - `notified state survives reload; an unreadable slot starts empty`
- [ ] **Step 2: Run** `cd mobile/app && flutter test test/notify_events_test.dart` — FAIL (files missing).
- [ ] **Step 3: Implement** `Notified` (shaped like `store/seen.dart`) and `detect`/`projectOf`.
- [ ] **Step 4: Run** the test and `flutter analyze --fatal-infos` — PASS, no issues.
- [ ] **Step 5: Commit** `gh-378: detect agent replies and waits for notifications`.

### Task 2: "Seen" only while the app is visible

**Files:**
- Create: `mobile/app/lib/notify/visible.dart`
- Modify: `mobile/app/lib/chat/chat_route.dart` (`_see`, init/dispose), `mobile/app/lib/main.dart` (one `AppVisible`),
  wherever `ChatRoute` is built (pass it down as the Seen is)
- Test: `mobile/app/test/chat_seen_test.dart`

**Interfaces:**
- Produces: `class AppVisible extends ChangeNotifier { bool get visible; ({String hostId, int port, String root})? get chat; void open(String hostId, int port, String root); void close(String hostId, int port, String root); }`
  — `visible` from an `AppLifecycleListener` (`onShow`/`onHide`); `chat` is the chat route on top (set in the route's
  init, cleared in dispose; a pushed screen over the chat keeps it, as the chat's tab is still the one in use).
  `bool onScreen(String hostId, HostWindow w)` = visible and `chat` matches port and root — the `detect` callback.
- Consumes: Seen (unchanged API).

- [ ] **Step 1: Failing tests** in `chat_seen_test.dart`:
  - `a hidden app's open chat does not see a new reply; showing it does` (drive `AppVisible` directly through a test
    constructor `AppVisible.test(visible: false)`).
  - existing `an open chat sees every new reply of its window` still passes.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: `_see` returns early when `!visible.visible`; the route listens to `visible` too, so show
  marks what arrived; the route registers itself with `open`/`close`.
- [ ] **Step 4: Run** `flutter test test/chat_seen_test.dart test/chat_screen_test.dart` — PASS.
- [ ] **Step 5: Commit** `gh-378: an open chat counts replies as seen only while the app is visible`.

### Task 3: Native service, notifications and channel

**Files:**
- Create: `mobile/app/android/app/src/main/kotlin/dev/notabene/nb_app/AgentService.kt`
- Create: `mobile/app/android/app/src/main/kotlin/dev/notabene/nb_app/Notices.kt`
- Modify: `MainActivity.kt` (channel registration in `configureFlutterEngine`, tap intents in `onCreate`/`onNewIntent`,
  stop service in `onDestroy`), `AndroidManifest.xml` (permissions, `<service android:foregroundServiceType="remoteMessaging" android:exported="false">`)
- Create: `mobile/app/lib/notify/platform.dart`
- Test: `mobile/app/test/notify_platform_test.dart`

**Interfaces:**
- Produces (Dart, `platform.dart`), over `MethodChannel('nb/background')`:
  - `abstract class BackgroundPlatform` with `Future<String> permission()` (`granted|denied|ask`),
    `Future<bool> requestPermission()`, `Future<void> startService(String title, String text, String channelName)`,
    `Future<void> updateService(String title, String text)`, `Future<void> stopService()`,
    `Future<void> notify({required String tag, required String title, String? text, required String publicTitle, required String hostId, required int port, required String root, required String channelName})`,
    `Future<void> cancel(String tag)`, `Future<void> schedule(bool on)`, `Future<void> openSettings()`,
    `Stream<({String hostId, int port, String root})> get opened` (a tapped notification, also the one that started the
    activity: Dart asks `takeLaunch()` once at start), `void onCheck(Future<void> Function() check)` (native → Dart call
    `check`, answered when done), `ChannelBackground` implementing it, `FakeBackground` in `test/support/fakes.dart`.
- Native: the service is started with `startForegroundService` + `startForeground(id, n, FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)`
  (API 29+ form, plain `startForeground` below); `ForegroundServiceStartNotAllowedException` is caught and answered
  as an error, not a crash. Event notifications: tag = `AgentEvent.key`, a `PendingIntent` to `MainActivity` with
  extras `hostId`, `port`, `root`, `setAutoCancel(true)`, `setPublicVersion(...)`.

- [ ] **Step 1: Failing Dart tests** with `TestDefaultBinaryMessengerBinding` mocking `nb/background`: each method
  sends its name and arguments as listed; a native `opened` call reaches the stream; a native `check` call runs the
  registered check and answers after it.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `platform.dart`, then the Kotlin side and manifest.
- [ ] **Step 4: Run** the test, `flutter analyze --fatal-infos`, `flutter build apk --debug` — PASS, builds.
- [ ] **Step 5: Commit** `gh-378: native foreground service and notifications for the phone`.

### Task 4: The Background controller

**Files:**
- Create: `mobile/app/lib/notify/background.dart`
- Modify: `mobile/app/lib/home.dart` (the 10-minute pause timer goes; hide/show go to `Background`),
  `mobile/app/lib/main.dart` (build `Notified`, `AppVisible`, `Background`; open a tapped chat as `_openLast` does)
- Test: `mobile/app/test/background_test.dart`

**Interfaces:**
- Consumes: `Links`, `Seen`, `Notified`, `detect`, `AppVisible`, `BackgroundPlatform`, `AppLocalizations`.
- Produces: `class Background { Background({required Links links, required Seen seen, required Notified notified, required AppVisible visible, required BackgroundPlatform platform, required AppLocalizations Function() strings, Duration linger = const Duration(minutes: 5), bool enabled = true}); void dispose(); bool get serviceOn; Future<void> setEnabled(bool on); Future<void> check({Duration wait = const Duration(seconds: 20)}); }`
  - On every links change: `detect` per online link → `notify`/`cancel` (`cancel` when the chat of that session opens).
  - Some window `busy || pending` and visible → permission `ask`: show the explanation dialog (a `BuildContext`
    callback passed in, or a `ValueNotifier<bool> askPermission` the Home shows) then `requestPermission`; granted →
    `startService`; denied → nothing, remember not to ask again.
  - Service text: `n` working → "Nota Bene · n agents working", any waiting → "… waiting for you".
  - Quiet for `linger` → `stopService`; then, if hidden, `links.pause()`.
  - Hide with the service off → `links.pause()`; show → `links.resume()`, `seen`/`notified` reload.
  - `check()`: when links are paused, `resume`, wait until every link is past `connecting` or `wait`, detect, `pause`
    again unless visible or the service runs.
  - `schedule(true)` while enabled, permission granted and a host paired; `schedule(false)` otherwise.

- [ ] **Step 1: Failing tests** (`FakeBackground`, fake `Links` from `host_link_test.dart`'s helpers, `fakeAsync` for
  `linger`):
  - `a busy window while visible starts the service; quiet for 5 minutes stops it and pauses hidden links`
  - `hiding with no agent working pauses the links; showing resumes them`
  - `a reply on a hidden phone posts one notification with the project and text; opening that chat cancels it`
  - `notifications denied: no service start, no notification, the links behave as before`
  - `check while paused resumes, notifies, and pauses again`
  - `the setting off stops the service, cancels the schedule and posts nothing`
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `Background`; wire it in `main.dart` and `home.dart`; route `opened` to the chat.
- [ ] **Step 4: Run** `flutter test` (whole app) and `flutter analyze --fatal-infos` — PASS.
- [ ] **Step 5: Commit** `gh-378: keep the links while agents work and notify about replies and waits`.

### Task 5: The periodic check

**Files:**
- Create: `mobile/app/android/app/src/main/kotlin/dev/notabene/nb_app/CheckWorker.kt`
- Create: `mobile/app/lib/notify/headless.dart`
- Modify: `mobile/app/android/app/build.gradle.kts` (`androidx.work:work-runtime-ktx`), `Notices.kt`/`MainActivity.kt`
  (`schedule`, a static "activity alive" flag set in `onCreate`, cleared in `onDestroy`)
- Test: `mobile/app/test/headless_test.dart`

**Interfaces:**
- Produces: `@pragma('vm:entry-point') Future<void> backgroundCheck()` in `headless.dart` (the engine's entry point),
  built on a testable `Future<void> runCheck({required Vault vault, required ConnectChannel connect, required BackgroundPlatform platform, required AppLocalizations strings, Duration wait = const Duration(seconds: 20)})`:
  loads Identity, Hosts, Seen, Notified; per host connects, takes the first window list or gives up at `wait`, runs
  `Seen.observe` then `detect` (nothing is on screen), posts, closes the channel.
- Native: a `PeriodicWorkRequest` of 15 min with `NetworkType.CONNECTED`, unique name `nb-check`, `KEEP`. Worker: if
  the activity is alive → invoke `check` on the main engine's `nb/background` channel and wait for its answer (60 s cap);
  else start a `FlutterEngine(context)` with `DartEntrypoint(..., "backgroundCheck")`, wait for its `done` call on
  `nb/background` (60 s cap), destroy the engine.
- The language of the headless strings: the stored `LangChoice`, else the system locale.

- [ ] **Step 1: Failing tests** for `runCheck` (fake connect from `test/support/fakes.dart`): a host with a new
  reply → one notification; an unreachable host → none, no throw, under `wait`; every channel closed after.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `headless.dart`, the worker and scheduling.
- [ ] **Step 4: Run** tests, analyze, `flutter build apk --debug` — PASS.
- [ ] **Step 5: Commit** `gh-378: check every 15 minutes while the app is away`.

### Task 6: Settings, strings and docs

**Files:**
- Modify: `mobile/app/lib/settings_screen.dart`, `mobile/app/lib/l10n/app_{en,de,es,pt,ru,zh}.arb`,
  `mobile/README.md`, `docs/guide.md` (phone section), `CHANGELOG.md` (Unreleased)
- Test: `mobile/app/test/settings_test.dart`, `mobile/app/test/l10n_test.dart` (existing key check)

**Interfaces:**
- Consumes: `Background.setEnabled`, `BackgroundPlatform.permission/openSettings`.
- Strings (keys): `notifySetting`, `notifyHint`, `notifyDenied`, `notifyOpenSettings`, `notifyAsk` (the sentence
  before the system dialog), `notifyChannelService`, `notifyChannelEvents`, `notifyServiceWorking` (`{n}`),
  `notifyServiceWaiting`, `notifyReplyPublic` (`{project}`), `notifyWaiting` (`{project}`). The setting is stored in
  the vault (`nb.notify`, default on).

- [ ] **Step 1: Failing tests**: the switch is shown and calls `setEnabled`; with permission denied the hint and the
  settings button show.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the setting, all strings in six languages, docs.
- [ ] **Step 4: Run** `flutter test`, `flutter analyze --fatal-infos`, `flutter gen-l10n` clean.
- [ ] **Step 5: Commit** `gh-378: notification setting and strings`.

### Task 7: Device check

- [ ] **Step 1:** Signed APK from the branch (`gh workflow run mobile.yml --ref <branch>`) into `~/Downloads`.
- [ ] **Step 2:** The user checks: a long agent turn, phone locked 15+ minutes → notification arrives; tap opens the
  chat; the service line is quiet and disappears 5 minutes after; after closing from recents a reply notifies within
  the next check.
- [ ] **Step 3:** Fix what the device shows, then PR, CI, review.
