# Remote: dictation on the phone (#92, part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a microphone button in the composer and the comment sheet turns speech into editable text with the phone's
own recognition (Android `SpeechRecognizer`, in the UI language).

**Architecture:** no new package. `MainActivity.kt` gets a `nb/speech` MethodChannel (`start`, `stop`, `cancel`) and an
`nb/speech/events` EventChannel, as `nb/frame` did for frames. Dart wraps them in `lib/dictation/dictation.dart`; a
`MicButton` (`lib/dictation/mic_button.dart`) writes the recognised text into a `TextEditingController`. Whisper on the
host is part B, a later plan.

**Tech Stack:** Flutter (mobile/app), Kotlin, `android.speech.SpeechRecognizer`.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` ("Dictation").

## Global Constraints

- All six app languages (en, ru, zh, es, pt, de) with real translations; new text only through the app's ARB.
- The agent gets text only: nothing is sent while dictating; the text lands in the field and is sent as typed text.
- Public repo: neutral fixtures, nothing personal. Tests never on ports 4777–4789.
- A control's tooltip names what it does (the mic button has one in both states).

## Review Focus

1. Text typed before dictation stays: the dictated words go in at the cursor, partial results replace only themselves.
2. Leaving the screen, closing the sheet or sending while listening cancels the recognizer; a late result is dropped.
3. A refused microphone permission, no recognition service, or nothing heard says so once and leaves the field as it was.
4. Two fields (composer under an open comment sheet) never listen at once.
5. The recognizer's language follows the app's UI language, not only the phone's.

---

### Task 1: the phone's recognizer behind a channel

**Files:** Modify `mobile/app/android/app/src/main/kotlin/dev/notabene/nb_app/MainActivity.kt`,
`mobile/app/android/app/src/main/AndroidManifest.xml`; Create `mobile/app/lib/dictation/dictation.dart`; Test
`mobile/app/test/dictation_test.dart`.

**Interfaces — Produces:**
- `const speechChannel = MethodChannel('nb/speech')`, `const speechEvents = EventChannel('nb/speech/events')`.
- `sealed class DictationEvent`: `DictationPartial(String text)`, `DictationFinal(String text)`,
  `DictationError(DictationFailure why)`, `DictationEnd()`. `enum DictationFailure { denied, unavailable, noMatch, failed }`.
- `abstract class Dictation { Stream<DictationEvent> listen(String languageTag); Future<void> stop(); Future<void> cancel(); }`
  — `listen` starts one session; its stream ends after `DictationFinal`/`DictationError`, then `DictationEnd`.
  `stop` asks for the final result; `cancel` ends without one.
- `class PlatformDictation implements Dictation` over the two channels; `Dictation dictation = PlatformDictation();`
  a top-level that tests replace (`@visibleForTesting` setter is fine).
- `String speechTag(String uiLang, Locale device)` — the device's tag when its language is the UI language
  (`ru` + `ru_RU` → `ru-RU`), else the UI language alone (`de` + `en_US` → `de`).

- [ ] Tests first (mock the method channel and the event channel as `test/frame_test.dart` does): `listen('ru-RU')`
  calls `start` with `{lang: 'ru-RU'}` and maps events `{type: partial|final, text}`, `{type: error, code: denied|
  unavailable|no_match|other}` → `DictationFailure.{denied, unavailable, noMatch, failed}`, `{type: end}`; `stop` and
  `cancel` call their methods; `speechTag` for the two examples above. See them fail.
- [ ] Dart side to pass.
- [ ] Kotlin: on `start` check `SpeechRecognizer.isRecognitionAvailable` (else event `error unavailable`); request
  `RECORD_AUDIO` at runtime when missing (`ActivityCompat.requestPermissions`, answer in
  `onRequestPermissionsResult`; refused → `error denied`); then one `SpeechRecognizer` with `RecognizerIntent`
  `ACTION_RECOGNIZE_SPEECH`, `LANGUAGE_MODEL_FREE_FORM`, `EXTRA_LANGUAGE` = lang, `EXTRA_PARTIAL_RESULTS` true.
  `onPartialResults` → partial (first candidate), `onResults` → final then end, `onError` → `ERROR_NO_MATCH` and
  `ERROR_SPEECH_TIMEOUT` → `no_match`, `ERROR_INSUFFICIENT_PERMISSIONS` → `denied`, others → `other`, then end. A new
  `start` while one runs cancels the old. `stop` → `stopListening`, `cancel` → `cancel` + `destroy`; destroy in `onDestroy`.
  All recognizer calls on the main thread.
- [ ] Manifest: `<uses-permission android:name="android.permission.RECORD_AUDIO"/>` and in `<queries>` an
  `<intent><action android:name="android.speech.RecognitionService"/></intent>` (Android 11+ package visibility).
- [ ] `flutter test test/dictation_test.dart`; `flutter build apk --debug` compiles the Kotlin.
- [ ] Commit `gh-92: the phone's speech recognizer behind a channel`.

### Task 2: the mic button in the composer and the comment sheet

**Files:** Create `mobile/app/lib/dictation/mic_button.dart`; Modify `mobile/app/lib/chat/composer.dart`,
`mobile/app/lib/comments/comment_sheet.dart`, `mobile/app/lib/l10n/app_*.arb` (all six); Test
`mobile/app/test/mic_button_test.dart`, add to `test/composer_test.dart`.

**Interfaces — Consumes:** Task 1's `dictation`, `DictationEvent`, `speechTag`.

- [ ] ARB keys (real translations in all six): `dictate` "Dictate", `dictateStop` "Stop dictation",
  `dictationDenied` "Microphone access is off for Nota Bene", `dictationUnavailable` "Speech recognition is not
  available on this phone", `dictationNoMatch` "Nothing was heard", `dictationFailed` "Dictation failed".
- [ ] `MicButton({required TextEditingController controller, bool enabled = true})`: an `IconButton`, `Icons.mic_none`
  with tooltip `dictate` when idle, `Icons.mic` in the theme's accent with tooltip `dictateStop` while listening. Tap
  idle → `dictation.listen(speechTag(uiLang, PlatformDispatcher.instance.locale))`; tap listening → `stop()`.
  Insertion: remember the text before and after the selection at start; each partial/final sets
  `before + sep + words + after` (`sep` a space when `before` is non-empty and does not end in whitespace), cursor
  after the words. Failure → one `SnackBar` with the matching key; `noMatch`/`denied`/`unavailable`/`failed` leave the
  field as it was before dictation. Dispose and `enabled` turning false while listening → `cancel()`, later events
  ignored. Only one `MicButton` listens at a time: starting one cancels another (a static "current" is fine).
- [ ] Composer: the button as the field's `suffixIcon`, enabled when the tab is open; `_send` cancels a running
  dictation before it reads the text. Comment sheet: the same `suffixIcon` on its field.
- [ ] Tests first, with a fake `Dictation` (a `StreamController` per `listen`, records calls): (1) tap → listening
  tooltip, partials then final land at the cursor after typed text `Fix ` → `Fix the header`; (2) tap again → `stop`
  called; (3) `denied` → `Microphone access is off for Nota Bene` snackbar, field unchanged; (4) leaving the widget
  while listening → `cancel` called and a later final does not throw or write; (5) the language tag passed is `en` for
  the English UI under a non-English device locale; (6) composer: send while listening cancels and sends the field's
  text; (7) the comment sheet shows the mic. Watch each fail.
- [ ] `flutter test`; `dart format lib test && flutter analyze`.
- [ ] Commit `gh-92: dictation in the composer and comments`.

### Task 3: Finish

- [ ] `mobile/README.md`: a short "Dictation" section (the phone's recognizer, `nb/speech`, the microphone permission
  asked on first use; Whisper on the host comes later).
- [ ] `dart format --set-exit-if-changed lib test`, `flutter analyze`, `flutter test` (app and channel),
  `flutter build apk --debug`, each gated on its exit code, one at a time.
- [ ] Commit `gh-92: docs for dictation on the phone`; push; draft PR into `remote`.
