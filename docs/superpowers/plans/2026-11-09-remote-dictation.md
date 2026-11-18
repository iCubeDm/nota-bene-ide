# Remote: dictation on the phone (#92, part A) Implementation Plan

**Goal:** A microphone button in the composer and the comment sheet turns speech into editable text with the phone's own recognition (Android `SpeechRecognizer`, in the UI language). Whisper on the host is part B, a later plan.

**Approach:** No new package. `MainActivity.kt` gets a `nb/speech` MethodChannel (`start`, `stop`, `cancel`) and a `nb/speech/events` EventChannel, as `nb/frame` did for frames. Dart wraps them in `lib/dictation/dictation.dart`; `MicButton` (`lib/dictation/mic_button.dart`) writes recognised text into a `TextEditingController`.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` ("Dictation").

## Decisions

- Six app languages with real translations, through the app's ARB. Neutral fixtures; tests never on ports 4777-4789.
- The agent gets text only: nothing is sent while dictating; the text lands in the field and is sent as typed.
- Recognizer language follows the app's UI language: `speechTag(uiLang, deviceLocale)` returns the device's tag when its language is the UI language (`ru` + `ru_RU` gives `ru-RU`), else the UI language alone (`de` + `en_US` gives `de`).
- Dictated words go in at the cursor, text typed before stays, partials replace only themselves (`before + sep + words + after`, `sep` a space when `before` is non-empty and does not end in whitespace).
- Leaving the screen, closing the sheet or sending while listening cancels the recognizer and drops a late result. Only one `MicButton` listens at a time (starting one cancels another). Failure shows one snackbar and leaves the field as it was.
- The tooltip names the action in both states (`dictate`, `dictateStop`).

## Contract

- Channels `nb/speech`, `nb/speech/events` with events `{type: partial|final, text}`, `{type: error, code: denied|unavailable|no_match|other}`, `{type: end}`.
- `sealed class DictationEvent`: `DictationPartial`, `DictationFinal`, `DictationError(DictationFailure)`, `DictationEnd`; `enum DictationFailure {denied, unavailable, noMatch, failed}`.
- `abstract class Dictation { Stream<DictationEvent> listen(String languageTag); Future<void> stop(); Future<void> cancel(); }`; the stream ends after final/error, then `DictationEnd`. `PlatformDictation` implements it; a top-level `dictation` is replaceable in tests.
- Kotlin: check `SpeechRecognizer.isRecognitionAvailable` (else `unavailable`); request `RECORD_AUDIO` at runtime (refused is `denied`); `RecognizerIntent` `ACTION_RECOGNIZE_SPEECH`, `LANGUAGE_MODEL_FREE_FORM`, partial results on. `ERROR_NO_MATCH`/`ERROR_SPEECH_TIMEOUT` map to `no_match`, `ERROR_INSUFFICIENT_PERMISSIONS` to `denied`, others `other`. A new `start` cancels the old; destroy in `onDestroy`; all calls on the main thread.
- Manifest: `RECORD_AUDIO` permission and a `<queries>` intent for `android.speech.RecognitionService` (Android 11+ package visibility).
- ARB keys: `dictate`, `dictateStop`, `dictationDenied`, `dictationUnavailable`, `dictationNoMatch`, `dictationFailed`.

## Result

`MicButton({controller, enabled})` is the composer's `suffixIcon` (enabled when the tab is open; `_send` cancels dictation before reading text) and the comment sheet field's. `mobile/README.md` gets a short "Dictation" section. Files: `MainActivity.kt`, `AndroidManifest.xml`, `lib/dictation/{dictation,mic_button}.dart`, `lib/chat/composer.dart`, `lib/comments/comment_sheet.dart`, six ARB files; tests `dictation_test`, `mic_button_test`, `composer_test`. Commits `gh-92: ...`; draft PR into `remote`.
