# Voice messages and the phone composer (#163, #164)

## Why

Dictation into the field was a first step; in practice the phone is used like a messenger: speak, let go, words go. The field showed dictation hints in a cramped pill. Telegram's voice messages are the wanted interaction: intuitive, voice stays visible as voice, its text readable at once. The desktop gets the same, instead of #155's dictation into the field.

## Goals

- A voice message is a message of its own: audio goes to the host, which stores and transcribes it; the agent gets the transcript; all feeds show a voice bubble with the transcript open under it.
- Release sends; slide left cancels; slide up locks (locked: stop, listen, then send or delete). As Telegram for Android: the recording takes the whole row, "‹ Slide to cancel" in the middle, lock floats above the big button.
- Sent means delivered: once released it no longer depends on the phone; the host transcribes and queues even if the phone goes offline.
- While the agent works, a voice message waits its turn like a typed "after" message.
- Comments get voice clips (several, listen, delete one, re-record); the agent's comment text carries clip transcripts after the typed text.
- Phone composer like Telegram's: full-width growing field; paperclip moves to the field's top once text wraps; one round button is mic when nothing to send, Send otherwise.
- Desktop records voice messages and clips and plays every voice bubble and clip.

## Non-goals

No video messages, speed control or voice-to-voice (the agent never hears audio). No compression: stored audio is the recorder's 16 kHz 16-bit mono WAV (~1.9 MB/min); Settings → Storage → Clean covers it like images. No editing a sent transcript (fix by stopping the agent and re-recording). `/dictation/transcribe` stays on the server for older phones; no client uses it any more.

## Anti-goals

A voice message reaching the agent empty, as audio, or twice; a release silently losing the recording (a failure stays visible on the bubble with a retry); pending comments or a typed draft leaving with a voice message (a voice message is only the voice).

## Decided with the user

Audio is stored on the host beside attachments (the guide's "the recording is not stored" changes); desktop shows voice bubbles with the same play button; when the agent is busy a voice message waits in the queue; the comment sheet offers clips, not dictation into the field; gesture hints exactly as Telegram; Telegram's sizes and behaviour come from public apps/screenshots, never its code or assets (GPL); icons and code are ours.

## Design

### Protocol 14

```ts
/** id = sha256 hex of the stored WAV; ms = its length; wave = 48 bars, each 0..31, loudest = 31 */
export type Voice = { id: string; ms: number; wave: number[] };
export type VoiceClip = Voice & { text: string };
```

- `send` gains `voice?: Voice` and `lang?: string` (ISO 639, UI language, Whisper's language). A send with `voice` has `text: ''` and no `images`/`commentIds`; the server refuses other combinations.
- `user` event gains `voice?: Voice`; `text` is `''` until the transcript arrives; on replay of a resumed session it is the transcript.
- New stored event `{ kind: 'voice-text'; id; text?; error?: 'off'|'empty'|'failed'; ts }` carries the transcript of user message `id` or why none; the feed puts the text into that message.
- `Comment` gains `voice?: VoiceClip[]`, max 10; the agent batch has clip texts after the typed text, one per line (web `comments/send.ts` and the phone's port).
- Clients offer voice only to servers announcing protocol >= 14 and `capabilities.dictation === 'whisper'`; without Whisper the mic opens its install.

### Server

- `POST /voice`: `audio/wav` body, 16 kHz mono 16-bit (`pcmFromWav` checks), <= 10 min 2 s and <= 20 MiB. Stored in the attachment store as `<sha256>.wav` (so Clean and restore-on-read cover it). Answers `{ id, ms, wave }`; wave = peak of each of 48 equal slices scaled so the loudest is 31 (silence = zeros).
- `GET /voice/<id>`: WAV with `Range` support (browser `<audio>` seeks) and the same headers as `/attach/<id>`.
- `POST /voice/<id>/text?lang=xx`: transcribes a stored WAV, answers `{ text }`; used by comment clips; 503 while Whisper is off.
- Transcription: split like the phone's `wav_parts.dart` (ported to TS with tests); each part goes through the single Whisper queue used by `/dictation/transcribe`; texts joined with spaces; a failed part is retried once, then the whole fails. Dart `wav_parts.dart` and `host_dictation.dart` are deleted with their tests once unused.
- `send` with `voice`: emits the `user` event at once (`text: ''`, `voice`); records message id -> `voice` in a small index under the state dir so replay restores the bubble; queues the hand-over, which awaits transcription before giving the text to the agent; later sends wait behind it. On success emits `voice-text {text}` and the agent gets the text; on failure emits `voice-text {error}` and ends the turn like a failed send (`failTurn`); nothing reaches the agent. `empty` = Whisper heard nothing; `off` = Whisper switched off meanwhile.
- A switch or close during transcription drops it (generation moved), as a queued send is dropped.
- History `user` events (`backend.history`) get `voice` from the index by message id. When the id is unknown (omp renames messages on resume), match the transcript saved at success: a user event takes the voice of the first not-yet-used entry whose transcript equals its text (trimmed, without the leading zero-width space added before a slash). An entry serves one event per replay; id matches are used first.

### The voice bubble (web and phone)

Telegram's layout, our colours, inside the user's bubble: round play/pause (40 px phone, 36 px web, primary colour); 48-bar wave (2 px bars, 1 px gaps, rounded; played part primary, rest muted; tap/drag seeks); length `0:12` (position while playing) under the wave; transcript under all, open by default, an "Aa" toggle at the wave's right folds it (per bubble, local, not stored). Until the transcript arrives: "Transcribing…" with a pulsing dot. On `error`: matching text ("Whisper is off on the computer", "Nothing was recognised", "Could not transcribe") plus Retry, which sends the same `voice` as a new message; a failed bubble is hidden once a later message carries the same voice id. One voice plays at a time across bubbles and clips.

### The phone composer

- Full-width bar; field is a rounded rectangle (radius 22), `minLines 1` growing to 6 then scrolling. Paperclip at the right inside the field while one line; once text wraps it moves to the top-right corner and text uses the full width below.
- Right of the field one round 48 px button: mic when nothing to send (no text, images or pending comments), else Send; animated scale-and-fade.
- While the agent works a 40 px round Stop sits left of it. A voice message is like a text message: the "send now or after" dialog asks too (release, locked Send, preview Send). After queues; Now sends `force` (server transcribes first, then interrupts the running turn and hands over the text). A dismissed dialog leaves the recording in the preview. A retry never asks and goes after.
- Recording as Telegram: hold the mic, after 150 ms recording starts with a light haptic; the mic grows into a 96 px primary circle under the finger with a halo swelling with input level; the field row is replaced by a red dot blinking every 500 ms, timer `0:03,4` (tenths) and centred "‹ Slide to cancel" that follows the finger left and fades near the cancel distance; a lock pill (lock over chevron) floats above the circle, sliding up 80 px closes the lock; release sends; sliding left 96 px cancels with a medium haptic and the row sliding back.
- Locked: the big circle becomes Send (paper plane); the middle shows "Cancel" in capitals; the pill becomes a Stop square. Stop ends into a preview row: trash, play, wave, length, Send on the right. Send in either state sends; Delete/Cancel drops.
- A short tap shows Telegram's hint as a small dark tooltip above the button, "Hold to record, release to send", fading after 2 s (not a snack bar).
- The recorder's 10-minute cap ends a recording as a release (sent; in locked mode, to the preview). Timer turns accent colour from 9:50.

### The phone comment sheet

The sheet's mic records a clip with the same gestures; release adds the clip under the text, it does not save the comment; locked mode and preview work as above. Each clip is a row: play, wave, length, transcript (or "Transcribing…", or error with Retry), delete; up to 10. Save waits for every transcript (disabled with a spinner). A comment can be clips only.

### The desktop

- Composer gets a mic button left of Send (tooltip with Alt+R). Click starts a locked recording at once: the textarea's place shows red dot, timer, live wave, ✕ Cancel, ■ Stop (to preview), ➤ Send. Press-and-hold (> 300 ms) records while held and sends on release. Esc cancels; Enter or Alt+R sends.
- Recorded with `getUserMedia` and an `AudioContext`, resampled to 16 kHz 16-bit mono and written as WAV in the page; stops at 10 min; a denied microphone says so in the composer's status line. Without Whisper the mic opens Settings → Dictation.
- The web comment editor gets the clip row and its mic (click to record, click to stop; no hold). Comment cards and the "N comments" list of a user bubble show clips with play and transcript.

### Text

All new strings in all six languages with real translations, web and phone. `docs/guide.md` and `mobile/README.md` describe voice messages, clips and audio storage; the phone UX spec's dictation lines point here.

## Left to the builder

Index file format/name under the state dir (append-only JSONL is enough); animation curves/durations within Telegram's feel (~150–250 ms); phone player: a small native `MediaPlayer` channel (`nb/play`) playing a cached WAV, no new packages; web recorder wiring (ScriptProcessor or AudioWorklet) within the page CSP; PR split: server and protocol first, then web and phone.
