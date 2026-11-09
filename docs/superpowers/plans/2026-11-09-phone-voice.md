# Phone voice (#145) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voice input that keeps every word: Telegram's hold-to-record with slide-left cancel and slide-up lock, transcribed by Whisper on the host when it is on, otherwise by the phone's recognizer running continuously through pauses; the same in the composer and the comment sheet.

**Architecture:** The recognition back ends exist (`PlatformDictation` over `nb/speech`, `HostDictation` over `nb/record` + `POST /dictation/transcribe`, both behind the `Dictation` interface). The phone recognizer stops at the first pause because Android ends a `SpeechRecognizer` session on silence and `MainActivity.kt` never restarts it. The fix keeps the native side thin: it restarts itself and reports each finished segment; Dart accumulates segments into one text. A new `VoiceButton` widget replaces the tap-toggle `MicButton` with the hold/lock/cancel gestures and a recording bar, using whichever `Dictation` the field's chooser picks.

**Tech Stack:** Kotlin (MainActivity method/event channels), Flutter 3.47.9, flutter_test.

**Spec:** `docs/superpowers/specs/2026-11-09-phone-ux-design.md` ("Voice").

## Global Constraints

- The Global Constraints of `docs/superpowers/plans/2026-11-09-phone-layout.md` apply, with `gh-145:` commits.
- No new packages; Android permissions unchanged (RECORD_AUDIO is declared).
- The agent receives text only; voice never leaves as audio to the agent.
- Recording through the host is capped at 120 s (`MAX_PCM`); at the cap it is stopped and transcribed, never dropped (existing `capped` path).
- Branch `gh-145-voice`, cut from `gh-144-chat-comments`, in `/Users/icubedm/Documents/Projects/ai-ide-phone`.
- Kotlin changes cannot run in CI tests: keep logic that needs testing in Dart; the Kotlin part is small and described exactly below.

## Review Focus

- A pause of 5 s in the middle of dictation: the words before and after both land in the field, in order, once each.
- The recognizer reports `no_match` or `speech_timeout` during a long pause: the session continues, no error is shown.
- Release while the host is still transcribing, then type: the transcript inserts at the place the recording started, not over the typed text.
- Slide left past the threshold: nothing is inserted, nothing is sent to the host.
- The app goes to the background while recording or locked: the recording is cancelled (as `MicButton` does today).

---

### Task 1: The phone recognizer runs through pauses

**Files:**
- Modify: `mobile/app/android/app/src/main/kotlin/dev/notabene/nb_app/MainActivity.kt` (`listenSpeech`, its listener, `nb/speech` `start`/`stop`)
- Modify: `mobile/app/lib/dictation/dictation.dart` (`PlatformDictation`, `_decode`)
- Test: `mobile/app/test/dictation_test.dart`

**Interfaces:**
- Native events on `nb/speech/events` (new): `{type: "segment", text}` — a finished stretch of speech while the session continues; `{type: "level", value}` — the input level 0..1, at most every 100 ms. Existing `partial`, `final`, `error`, `end` keep their meaning.
- Native behaviour: `start` begins a session flagged continuous. On `onResults` with text → emit `segment`, then `startListening` again on a fresh recognizer (destroy the old one after the callback, as `release` does). On `onResults` empty, or `onError` with `ERROR_NO_MATCH` / `ERROR_SPEECH_TIMEOUT` → restart silently. Other errors → `error` + `end` as now. `stop` → set the session to finishing and call `stopListening()`; the next `onResults` (or no_match/timeout) emits `final` with that segment's text (possibly empty) and `end`. Intent extras added: `EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS` 4000, `EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS` 4000, `EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS` 15000 (hints; devices may ignore them, the restart is what guarantees continuity). `onRmsChanged` → `level` from rmsdB mapped linearly from [-2, 10] to [0, 1], throttled.
- Dart: `PlatformDictation.listen` accumulates: `segments` joined with a single space; a `partial` is surfaced as `DictationPartial(accumulated + ' ' + partial)` (no leading space when nothing accumulated); `final` as `DictationFinal(accumulated + ' ' + text)` trimmed; a `segment` updates the accumulation and surfaces a `DictationPartial` of it. New event `DictationLevel(double value)` in `dictation.dart`, passed through.

- [ ] **Step 1: Failing Dart tests** (mock the event channel as `dictation_test.dart` already does): segment "hello", partial "wor", segment "world", final "again" → partials `hello`, `hello wor`, `hello world`, final `hello world again`; a `final` with empty text after segments → final = the segments; `level` events become `DictationLevel`; an `error` after a segment still ends with `DictationError` (the field keeps the partial, as `MicButton` handles errors today).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** Dart, then Kotlin as specified; `flutter build apk --debug` must compile.
- [ ] **Step 4: Run tests, expect PASS; build exit 0.**
- [ ] **Step 5: Commit** `gh-145: the phone's recognizer keeps listening through pauses`.

### Task 2: The recorder reports its level

**Files:**
- Modify: `MainActivity.kt` (the `nb/record` loop), `mobile/app/lib/dictation/host_dictation.dart`
- Test: `mobile/app/test/host_dictation_test.dart`

**Interfaces:**
- Native: while recording, call `recordChannel.invokeMethod("level", value)` at most every 100 ms, value = RMS of the last buffer / 32768, clamped 0..1, posted on the main thread.
- Dart: `HostDictation` handles `level` calls by emitting `DictationLevel(value)` while recording.

- [ ] **Step 1: Failing test:** a `level` call from the mocked channel during recording yields `DictationLevel(0.5)`; after `stop` none are emitted.
- [ ] **Step 2: Run, expect FAIL.** - [ ] **Step 3: Implement.** - [ ] **Step 4: PASS; debug build compiles.**
- [ ] **Step 5: Commit** `gh-145: the recorder reports its input level`.

### Task 3: Hold, lock, cancel

**Files:**
- Create: `mobile/app/lib/dictation/voice_button.dart`, `mobile/app/lib/dictation/record_bar.dart`
- Modify: `mobile/app/lib/chat/composer.dart` (use `VoiceButton` in the pill; while recording the pill shows the record bar), the six ARB files
- Test: `mobile/app/test/voice_button_test.dart`

**Interfaces:**
- Produces: `class VoiceButton extends StatefulWidget { const VoiceButton({super.key, required this.controller, this.enabled = true, this.chooser, this.onState}); }` with `enum VoiceState { idle, recording, locked, working }` reported through `onState(VoiceState)` so the host widget swaps in the `RecordBar`; `static void cancelRunning()` as `MicButton.cancelRunning`. `class RecordBar extends StatelessWidget` (red dot, `m:ss` timer, level waveform from `DictationLevel`, "◀ slide to cancel" while holding, "Cancel" + a stop button when locked, "Transcribing…" while working).
- Gesture rules: press and hold ≥ 200 ms starts; a shorter tap shows a hint ("Hold to record", snackbar) and does nothing else; move left ≥ 96 px cancels (haptic); move up ≥ 80 px locks (haptic); release while holding stops; in locked state the stop button stops and Cancel cancels.
- Text: the result inserts at the cursor position captured at the start, with a space before when the text before does not end in whitespace — the rule `MicButton` uses today (reuse its code, do not fork it). Partials show in the field live, as now.
- Host cap: from 110 s the timer turns `accent`; at 120 s the host path's `capped` stops and transcribes (existing).
- ARB keys: `voiceHold` ("Hold to record"), `voiceSlideCancel` ("Slide to cancel"), `voiceCancel` ("Cancel"), `voiceTranscribing` ("Transcribing…"), `voiceStop` ("Stop").
- `MicButton` is deleted when nothing uses it after Task 4 (its tests move to `voice_button_test.dart` where they still apply).

- [ ] **Step 1: Failing tests** with a fake `Dictation` (the pattern of `mic_button_test.dart`): hold 300 ms then release → listen and stop called, final text inserted; tap 100 ms → hint, no listen; hold and drag left 120 px → cancel called, field unchanged; hold, drag up 100 px, release → still recording (locked), stop button stops; `onState` sequence idle→recording→working→idle; partials appear live; text typed before the start is kept and the result goes at the captured cursor; app hidden while locked → cancel.
- [ ] **Step 2: Run, expect FAIL.** - [ ] **Step 3: Implement.** - [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `gh-145: hold to record, slide to cancel, slide up to lock`.

### Task 4: The comment sheet uses the same voice

**Files:**
- Modify: `mobile/app/lib/comments/comment_sheet.dart` (`VoiceButton` with the composer's chooser: host Whisper when `capabilities.dictation == 'whisper'` and not `hostWhisperOff`), callers of `showCommentSheet` (pass the tab or the chooser)
- Test: `mobile/app/test/comment_sheet_test.dart`

- [ ] **Step 1: Failing test:** with a whisper-capable tab, holding the sheet's mic uses `HostDictation` (the record channel gets `start`); without it, the phone recognizer.
- [ ] **Step 2: FAIL.** - [ ] **Step 3: Implement**; remove `MicButton` if unused. - [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `gh-145: the comment sheet's voice uses the host's Whisper too`.

### Task 5: Whole-app check and APK

- [ ] The three Flutter checks → exit 0; `flutter build apk --release`.
