# Voice messages and the phone composer (#163, #164) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telegram-like voice messages: the client uploads a WAV, the host stores and transcribes it, and the agent gets
the text. Every feed shows a voice bubble. Comments carry voice clips. The phone's composer is Telegram's.

**Architecture:** Protocol 14 adds `Voice`, `send.voice`, `user.voice`, `Comment.voice` and the stored `voice-text`
event. The server stores the WAV in the attachment store, splits it as the phone does today, and transcribes it in the
send queue before the hand-over. Clients only record, upload, send and play.

**Tech Stack:** TypeScript (Node, Vitest), React/Redux (web), Flutter 3.47.9 + Kotlin (phone), `dart test`.

**Spec:** `docs/superpowers/specs/2026-11-09-voice-messages-design.md`.

## Global Constraints

- Commits `gh-163: …` (server, web, phone voice) or `gh-164: …` (phone composer), with the trailer
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Server and web tests use ports 4790–4795 only, with a temporary `NOTA_BENE_HOME`. Never touch `~/.nota-bene` or a
  running window. Never run two full suites at once. Gate on exit codes.
- The worktrees have no `node_modules` of their own. Symlink the main checkout's
  (`/Users/icubedm/Documents/Projects/ai-ide/node_modules`, and `web/node_modules`, `server/node_modules`,
  `shared/node_modules` where they exist). Trash the links when done. Never install anything.
- No new npm or pub packages. No new Android permissions (RECORD_AUDIO is already there).
- Every user-visible string goes through i18n (web `web/src/i18n`, phone ARB files), with real translations in en, ru,
  zh, es, pt, de.
- Public repo: neutral fixtures, no personal paths or names.
- Use `trash`, never `rm`. Never `git stash`. Never push.

## Review Focus

- A send with `voice` plus text, images or commentIds: refused by the parser. A reused id: refused with no side effects.
- A switch while a voice message transcribes: no hand-over to the new session, no stray `voice-text` in the new feed.
- Two voice messages and a typed one queued: the agent gets them in send order. The second transcription starts only
  after the first.
- A 10-minute recording: under the relay's 32 MB body cap; parts within 30–60 s; the server's memory holds one part's
  PCM at a time beyond the file.
- The phone goes offline right after release: the message still reaches the agent (the upload finished before
  `send`). If the upload itself fails, the bubble stays local with Retry and is never lost silently.

---

## Part A: server and protocol (branch `gh-163-voice-server`, worktree `/Users/icubedm/Documents/Projects/ai-ide-voice`)

### Task A1: Protocol 14

**Files:** `shared/src/protocol.ts`, `shared/src/protocol.test.ts`, generated `mobile/protocol/` (`npm run gen:protocol`).

**Produces:** `Voice`, `VoiceClip`, `VOICE_BARS = 48`, `VOICE_MAX_CLIPS = 10`, `send.voice`/`send.lang`, `user.voice`,
`Comment.voice`, the `voice-text` event, `PROTOCOL = 14` (with a doc line), `isVoice` exported for the server.

- [ ] Tests first: `send` with `voice` and `text: ''` parses (unknown keys dropped); with text, images or commentIds it
  is an error; `lang` must match `/^[a-z]{2,3}$/`; `wave` must be 48 ints 0..31, `ms` a positive integer ≤ 602000, and
  `id` 64 hex. A comment with 10 clips parses, and one with 11 is refused. A clip needs `text: string` (≤ 20000 chars).
- [ ] Implement, `npx vitest run shared` green, then `npm run gen:protocol`, then `npx tsc -b`.
- [ ] Commit `gh-163: protocol 14: voice messages, voice clips, voice-text`.

### Task A2: Parts and wave

**Files:** create `server/src/voice/parts.ts`, `server/src/voice/wave.ts`, tests beside them.

**Produces:** `splitWav(wav: Buffer): Buffer[]` (a faithful port of `mobile/app/lib/dictation/wav_parts.dart`, its six
tests ported); `waveOf(pcm: Int16Array | Buffer after header): number[]` (48 slice peaks scaled to 0..31, all zeros
for silence, a shorter recording still 48 bars); `msOf(wav: Buffer): number`.

- [ ] Tests (the Dart ones, plus: wave of silence, wave of a ramp is non-decreasing, length 48 for 0.5 s).
- [ ] Implement; `npx vitest run server/src/voice` green. Commit `gh-163: the server splits and draws a recording`.

### Task A3: Store and routes

**Files:** `server/src/attachments.ts` (the store takes `audio/wav` → `.wav` besides images; `/attach` still takes
images only; `get` callers that hand images to the agent ignore audio), `server/src/session/images.ts` (refuse a
non-image), create `server/src/voice/routes.ts` + test, `server/src/dictation/routes.ts` (export the Whisper queue as a
shared `transcribeQueued(pcm, lang)`), `server/src/server.ts` (mount).

**Produces:** `POST /voice` → `{id, ms, wave}`. Errors: 415 when not `audio/wav`, 400 for a bad WAV (WavError), 413
over 20 MiB or over 602 s. `GET`/`HEAD /voice/<id>` with `Range` (206, `content-range`, `accept-ranges: bytes`; 416
when out of range). `POST /voice/<id>/text?lang=` → `{text}`, 404 for an unknown id, 503 while Whisper is off.
`transcribeVoice(store, id, lang, run): Promise<string>` (split, one part at a time through the shared queue, one
retry per part) is exported for A4.

- [ ] Tests first (a fake transcriber, as `dictation/routes.test.ts` does). Implement. Green. `npx tsc -b`.
- [ ] Commit `gh-163: the host stores, serves and transcribes a recording`.

### Task A4: Voice sends

**Files:** `server/src/session.ts`, `server/src/session/sendQueue.ts` (+ tests), `server/src/session/types.ts`, create
`server/src/voice/index.ts` (the message id → Voice index, JSONL under the state dir, loaded lazily), the history
path in `session.ts` `load()` (enrich historic `user` events from the index), `server/src/audit.ts` (the new event),
the `send` handler in `server.ts` if it validates fields.

**Interfaces:** `SendQueue.push` takes `text: string | (() => Promise<string>)`. A function is awaited inside the chain,
then the generation is checked again. A rejection goes to `fail` (a `VoiceError` with `why`). `session.send` takes
`voice?` and `lang?`. It emits `user` with `text: ''` and `voice`, records the index entry, and pushes a text function.
That function calls `transcribeVoice`, then emits `voice-text {id, text}` (or `{id, error}`) before returning. An empty
text is the error `empty`. Whisper off is `off`. Anything else is `failed`.

- [ ] Tests first: a voice send emits `user` then `voice-text`, and the fake agent receives the transcript. A typed
  send after it reaches the agent after it. A failing transcription emits `voice-text {error:'failed'}` and a failure
  event, and the agent receives nothing. A switch during the transcription drops it. A resumed history gets `voice`
  back. The existing characterization suite stays green.
- [ ] Commit `gh-163: a voice message is transcribed on the host before the agent gets it`.

## Part B: web (branch `gh-163-voice-web`, from Part A)

### Task B1: Voice in the feed

**Files:** `web/src/store/feed.ts` (user `voice`, `voiceText`/`voiceError`, the `voice-text` reducer, the hidden
retried rule), create `web/src/voice/VoiceBubble.tsx`, `web/src/voice/player.ts` (one audio at a time, `<audio>` on
`/voice/<id>`), `web/src/feed/UserMessage.tsx`.

- [ ] Tests: the reducer patches by id (also when `voice-text` comes in the replay). A failed bubble shows Retry, and
  Retry dispatches a `send` with the same voice and a new id. A failed bubble is hidden once a later user item has the
  same voice id. Play/pause toggles, and starting a second stops the first. The transcript toggle folds the text.
- [ ] Commit `gh-163: voice bubbles in the desktop feed`.

### Task B2: Recording in the composer

**Files:** create `web/src/voice/recorder.ts` (getUserMedia → 16 kHz mono 16-bit WAV, a level callback, a 10-minute
cap), `web/src/voice/RecordBar.tsx`, `web/src/voice/upload.ts` (POST /voice), `web/src/composer/Composer.tsx` (the mic,
the bar in the textarea's place), `web/src/shell/keymap.ts` (`hk_voice`, Alt+R, in fields too), the i18n files.

- [ ] Tests with a fake recorder: a click starts a locked recording and Send uploads and dispatches `send` with
  `voice`, `lang` and `text: ''`; Esc cancels and uploads nothing; a hold and release sends; no Whisper opens Settings
  → Dictation; a protocol 13 server gets no mic; a denied mic shows the status note. Unit-test the WAV writer and the
  resampler (a 48 kHz sine → 16 kHz, its length, its header).
- [ ] Commit `gh-163: record a voice message on the desktop`.

### Task B3: Clips in comments

**Files:** `web/src/comments/CommentPopup.tsx` (mic, clip rows, Save waits), `web/src/comments/CommentCard.tsx`,
`web/src/feed/UserMessage.tsx` (the sent comments' clips), `web/src/comments/compose.ts` (the clips' texts after the
typed text), create `web/src/voice/ClipRow.tsx`.

- [ ] Tests: compose puts the clip texts after the typed text, each on its own line, in order. A clips-only comment
  composes too. Delete removes a clip. Save stays disabled while a clip transcribes.
- [ ] Commit `gh-163: voice clips in comments on the desktop`.

### Task B4: Docs

- [ ] `docs/guide.md` (voice messages, clips, where the audio is kept, Clean), `docs/architecture.md` if it lists the
  routes, and the spec link. Commit `gh-163: the guide describes voice messages`.

## Part C: phone (branch `gh-164-phone-voice`, from Part A, worktree `/Users/icubedm/Documents/Projects/ai-ide-phone`)

### Task C1: The player and the voice view

**Files:** `MainActivity.kt` (`nb/play`: `play {path}`, `pause`, `seek {ms}`, `stop`; callbacks `position {ms}`,
`done`), create `lib/voice/player.dart` (one at a time; it fetches `/voice/<id>` through `windowHttp`, caches the file
in the app's cache dir by id), `lib/voice/voice_view.dart` (play button, the wave painter with the played part, seek by
tap/drag, the length/position).

- [ ] Tests with a mocked channel: play fetches once and plays the cached path; a second play stops the first; the
  view draws 48 bars and seeks on tap. `flutter build apk --debug` exit 0.
- [ ] Commit `gh-163: the phone plays voice messages`.

### Task C2: Voice bubbles

**Files:** `lib/chat/feed.dart` (UserItem `voice`, `voiceText`, `voiceError`; the `voice-text` event; hide retried),
`lib/chat/chat_screen.dart` (the bubble: VoiceView, the transcript under it with the fold toggle, Transcribing…, the
errors with Retry), the ARB files.

- [ ] Tests mirroring B1. Commit `gh-163: voice bubbles on the phone`.

### Task C3: The recorder

**Files:** create `lib/voice/recorder.dart` (on `nb/record`: start, levels, stop → WAV, cancel, capped),
`lib/voice/record_button.dart` (Telegram's gestures: hold 150 ms, the 96 px circle with the level halo, slide left
96 px cancels, slide up 80 px locks, the lock pill, the hint tooltip on a short tap), `lib/voice/record_row.dart` (the
blinking dot, the `0:03,4` timer, "‹ Slide to cancel" following the finger, locked: CANCEL, Stop → preview: delete,
play, wave, Send), `lib/voice/upload.dart` (POST /voice → Voice).
Delete `lib/dictation/voice_button.dart`, `record_bar.dart`, `host_dictation.dart`, `wav_parts.dart`, `dictation.dart`
and their tests once nothing imports them. Keep `whisper_sheet.dart`.

**Produces:** `RecordButton({required onRecorded: (Uint8List wav, Duration length) → void, required enabled, onUnavailable, onState})`
and `RecordRow`, both reused by the composer and the comment sheet.

- [ ] Tests (gestures with a mocked channel): a hold then release calls `onRecorded`; slide left cancels and calls
  nothing; slide up locks, then Send calls it; Stop leads to the preview and Delete drops it; a short tap shows the
  tooltip; the cap sends (unlocked) or previews (locked); the timer shows tenths.
- [ ] Commit `gh-163: Telegram's recorder on the phone`.

### Task C4: The composer

**Files:** `lib/chat/composer.dart` (Telegram's layout; the round button: mic or Send; Stop while busy; recording
takes the row; a recording is uploaded, then sent as `ClientMessageSend(text: '', voice:, lang:)`, never with the
dialog; an upload failure keeps a local pending bubble with Retry), the tests `composer_test.dart` and
`composer_attach_test.dart` updated.

- [ ] Tests: the mic shows only with nothing to send; typing swaps it to Send; the paperclip moves to the top once the
  text wraps (find it above the text's first line); a recording sends the voice send; busy shows Stop and voice goes
  without a dialog.
- [ ] Commit `gh-164: the phone composer as in Telegram`.

### Task C5: Clips in the comment sheet

**Files:** `lib/comments/comment_sheet.dart`, `lib/comments/comments.dart` (`composeSend` adds the clip texts after
the typed text, as B3), `lib/comments/` card views showing clips.

- [ ] Tests mirroring B3. Commit `gh-163: voice clips in comments on the phone`.

### Task C6: Whole check

- [ ] `mobile/README.md`, the phone UX spec's dictation lines. `flutter analyze`, `flutter test`,
  `dart format --set-exit-if-changed lib test` exit 0. `flutter build apk --release` exit 0.
