# Phone voice (#145) Implementation Plan

**Goal:** Voice input that keeps every word: Telegram's hold-to-record with slide-left cancel and slide-up lock, transcribed by Whisper on the host when it is on, otherwise by the phone's recognizer running continuously through pauses; the same in the composer and the comment sheet.

**Problem:** The back ends exist (`PlatformDictation` over `nb/speech`, `HostDictation` over `nb/record` + `POST /dictation/transcribe`, behind the `Dictation` interface). The phone recognizer stops at the first pause because Android ends a `SpeechRecognizer` session on silence and `MainActivity.kt` never restarts it.

**Approach:** The native side stays thin: it restarts itself and reports each finished segment; Dart accumulates segments into one text. A new `VoiceButton` replaces the tap-toggle `MicButton` with hold/lock/cancel gestures and a recording bar, using whichever `Dictation` the field's chooser picks.

**Spec:** `docs/superpowers/specs/2026-11-09-phone-ux-design.md` ("Voice"). Global constraints of `2026-11-09-phone-layout.md` apply.

## Decisions

- No new packages, permissions unchanged. The agent receives text only, never audio.
- Host recording is capped at 120 s (`MAX_PCM`); at the cap it is stopped and transcribed, never dropped (existing `capped` path). The timer turns `accent` from 110 s.
- Kotlin cannot run in CI tests, so testable logic stays in Dart and the Kotlin part is small.
- The transcript inserts at the cursor position captured at the start (with a space before when the preceding text does not end in whitespace), reusing `MicButton`'s rule, not forking it. Partials show live in the field.
- Backgrounding the app while recording or locked cancels the recording (as today).

## Native contract

`nb/speech/events` gains `{type: "segment", text}` (a finished stretch while the session continues) and `{type: "level", value}` (0..1, at most every 100 ms; from `onRmsChanged`, rmsdB mapped linearly from [-2, 10]). `partial`, `final`, `error`, `end` keep their meaning.

- `start` begins a continuous session. `onResults` with text: emit `segment`, then start a fresh recognizer (destroy the old after the callback). Empty results, or `ERROR_NO_MATCH` / `ERROR_SPEECH_TIMEOUT`: restart silently. Other errors: `error` + `end`.
- `stop` marks the session finishing and calls `stopListening()`; the next result (or no_match/timeout) emits `final` with that segment's text (maybe empty) and `end`.
- Intent hints: complete and possibly-complete silence 4000 ms, minimum length 15000 ms (devices may ignore them; the restart guarantees continuity).
- `nb/record` loop calls `recordChannel.invokeMethod("level", value)` at most every 100 ms, value = RMS of last buffer / 32768 clamped, posted on the main thread. `HostDictation` turns it into `DictationLevel`.

## Dart contract

- `PlatformDictation.listen` joins segments with one space; a `partial` surfaces as `DictationPartial(accumulated + ' ' + partial)`; `final` as `DictationFinal(accumulated + ' ' + text)` trimmed (an empty final yields the segments); a `segment` surfaces a partial of the accumulation. An `error` after segments still ends with `DictationError` and the field keeps the partial. New event `DictationLevel(double)` in `dictation.dart`.
- `VoiceButton({controller, enabled, chooser, onState})` in `lib/dictation/voice_button.dart`, `enum VoiceState {idle, recording, locked, working}` via `onState` so the host widget swaps in `RecordBar` (`record_bar.dart`: red dot, `m:ss` timer, level waveform, "slide to cancel" while holding, Cancel + stop when locked, "Transcribing..." while working). `static cancelRunning()` as on `MicButton`.
- Gestures: hold >= 200 ms starts; a shorter tap shows a "Hold to record" snackbar only; drag left >= 96 px cancels (haptic); drag up >= 80 px locks (haptic); release while holding stops.
- ARB keys: `voiceHold`, `voiceSlideCancel`, `voiceCancel`, `voiceTranscribing`, `voiceStop`.
- Comment sheet uses `VoiceButton` with the composer's chooser (host Whisper when `capabilities.dictation == 'whisper'` and not `hostWhisperOff`); callers of `showCommentSheet` pass the tab or chooser. `MicButton` is deleted once unused, its applicable tests moved to `voice_button_test.dart`.

## Review focus

- A 5 s pause mid-dictation: words before and after land in order, once each; `no_match`/`speech_timeout` during a long pause shows no error.
- Release while the host transcribes, then type: transcript inserts where the recording started, not over typed text.
- Slide left past the threshold: nothing inserted, nothing sent to the host.

## Files

`MainActivity.kt`, `lib/dictation/{dictation,host_dictation,voice_button,record_bar}.dart`, `lib/chat/composer.dart`, `lib/comments/comment_sheet.dart`, six ARB files. Tests: `dictation`, `host_dictation`, `voice_button`, `comment_sheet`.

Final check: the Flutter checks and `flutter build apk --release`.
