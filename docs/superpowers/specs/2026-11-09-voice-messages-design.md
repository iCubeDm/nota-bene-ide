# Voice messages and the phone composer (#163, #164)

## Why

Dictation into the field was the first step. In practice the phone is used like a messenger. You speak, let go, and the
words go. The field showed the dictation's hints in a cramped pill. Telegram's voice messages are the interaction the
user wants to copy: they are intuitive, the voice stays visible as voice, and its text is readable at once. The desktop
gets the same, instead of #155's dictation into the field.

## Goals

- A voice message is a message of its own. The audio goes to the host, the host stores and transcribes it, and the
  agent gets the transcript. Feeds on every client show a voice bubble with the transcript open under it.
- Releasing the mic sends the recording. Sliding left cancels it. Sliding up locks it. A locked recording can be
  stopped, listened to and then sent or deleted. All of this works as in Telegram for Android: the recording takes the
  whole row, "‹ Slide to cancel" sits in the middle, and the lock floats above the big button.
- Sent means delivered. Once released, the message no longer depends on the phone: the host transcribes and queues it
  even if the phone goes offline.
- A voice message while the agent works waits for its turn, as a typed message sent "after" does.
- Comments get voice clips: record several, listen to each, delete one, record again. The comment's text for the
  agent carries the clips' transcripts after what was typed.
- The phone composer looks like Telegram's: a full-width field that grows; the paperclip moves to the top of the field
  once the text wraps; one round button on the right is the mic when there is nothing to send, Send otherwise.
- The desktop records voice messages and comment clips, and plays every voice bubble and clip.

## Non-goals

- No video messages, no speed control, no voice-to-voice (the agent never hears the audio).
- No compression: the stored audio is the recorder's 16 kHz 16-bit mono WAV, about 1.9 MB a minute. Settings →
  Storage → Clean covers it as it covers images.
- No editing a sent transcript. A wrong one is fixed by stopping the agent and recording again, as the user said.
- Dictation into the field (`/dictation/transcribe`) stays on the server for older phones. No client uses it any more.

## Anti-goals

- A voice message must never reach the agent as an empty message, as audio, or twice.
- A release must never silently lose the recording. A failure must stay visible on the bubble, with a retry.
- Pending comments and a typed draft must never leave with a voice message. A voice message is only the voice.

## Decided with the user

- The audio is stored on the host, beside the attachments. The guide's "the recording is not stored" changes.
- The desktop shows voice bubbles with the same play button.
- When the agent is busy, a voice message waits in the queue.
- The comment sheet offers clips (listen, delete, record again, several), not dictation into the field.
- The gesture hints are exactly as in Telegram.
- We take Telegram's sizes and behaviour from its public apps and screenshots, never its code or assets (GPL). Icons and
  code are our own.

## The design

### Protocol 14

```ts
/** id = sha256 hex of the stored WAV; ms = its length; wave = 48 bars, each 0..31, loudest = 31 */
export type Voice = { id: string; ms: number; wave: number[] };
export type VoiceClip = Voice & { text: string };
```

- `send` gains `voice?: Voice` and `lang?: string` (ISO 639, the UI language: Whisper's language). A send with `voice`
  has `text: ''`, and no `images` or `commentIds`. The server refuses any other combination.
- The `user` event gains `voice?: Voice`. Its `text` is `''` until the transcript is in. On a replay of a resumed
  session it is the transcript.
- A new stored event, `{ kind: 'voice-text'; id: string; text?: string; error?: 'off' | 'empty' | 'failed'; ts: number }`,
  carries the transcript of the user message `id`, or why there is none. The feed puts the text into that message.
- `Comment` gains `voice?: VoiceClip[]`, at most 10 per comment. The batch for the agent has the clips' texts after the
  comment's typed text, each on its own line (web `comments/send.ts`, and the phone's port of it).
- Clients offer voice only to a server that announced protocol ≥ 14 and `capabilities.dictation === 'whisper'`. Without
  Whisper the mic opens its install, as the phone does now.

### Server

- `POST /voice`: a WAV body, `audio/wav`, 16 kHz mono 16-bit (`pcmFromWav` checks it). It must be at most 10 min 2 s
  long and at most 20 MiB. The server stores it in the attachment store as `<sha256>.wav`, so Clean and its
  restore-on-read cover it. It answers `{ id, ms, wave }`. The wave is the peak of each of 48 equal slices, scaled so the
  loudest slice is 31. A silent recording is all zeros.
- `GET /voice/<id>`: serves the WAV with `Range` support (the browser's `<audio>` seeks with it) and the same headers as
  `/attach/<id>`.
- `POST /voice/<id>/text?lang=xx`: transcribes a stored WAV and answers `{ text }`. Comment clips use it. It answers
  503 while Whisper is off.
- Transcribing a stored WAV: the server splits it the way the phone's `wav_parts.dart` does now (port it to TS, with
  its tests). Each part goes through the one Whisper queue that `/dictation/transcribe` uses, and the texts are joined
  with spaces. A failed part is tried once more, then the whole transcription fails. The Dart `wav_parts.dart` and
  `host_dictation.dart` are deleted with their tests once the phone no longer uses them.
- `send` with `voice`: the server emits the `user` event at once (`text: ''`, `voice`). It records the message id →
  `voice` in a small index under the state dir, so a resumed session's replay gives the bubble its voice back. Then it
  queues the hand-over. The queue awaits the transcription before handing the text to the agent. Sends after it wait
  behind it, as the queue already orders them. On success the server emits `voice-text {text}` and the agent gets the
  text. On failure the server emits `voice-text {error}` and ends the turn the way a failed send does (`failTurn`).
  Nothing reaches the agent. `empty` means Whisper heard nothing. `off` means Whisper was switched off meanwhile.
- A switch or a close while a transcription runs drops it, as a queued send is dropped now. Its generation moved.
- `user` events from the agent's history (`backend.history`) get their `voice` from the index by message id.
  When the id is unknown (omp names its messages anew on a resume), the transcript saved in the index when it succeeded
  is matched instead: a user event gets the voice of the first not-yet-used entry whose transcript equals its text
  (trimmed, without the leading zero-width space the server adds before a slash). An entry serves one event per replay,
  and entries matched by id are used up first.

### The voice bubble (web and phone)

Telegram's layout, our colours, inside the user's bubble:

- a round play/pause button (40 px phone, 36 px web) in the primary colour;
- the 48-bar wave beside it, bars 2 px wide with 1 px gaps, rounded; the played part is in the primary colour, the rest
  muted; tapping or dragging on the wave seeks;
- under the wave, the length (`0:12`), or the position while playing;
- the transcript under all of it, open by default. A small "Aa" toggle at the right of the wave folds it, as
  Telegram's transcribe button does. Folding is per bubble, local, and not stored.
- While the transcript is not in: "Transcribing…" with a pulsing dot. On `error`, the matching text ("Whisper is off on
  the computer", "Nothing was recognised", "Could not transcribe"). A Retry button sends the same `voice` again as a
  new message. A failed voice bubble is hidden from the feed once a later message carries the same voice id.
- One voice plays at a time, across bubbles and clips. Playing another stops the first.

### The phone composer

Telegram's Android layout, in our theme:

- The bar is full width. Its field is a rounded rectangle (radius 22) with the text inside, `minLines 1`, growing to 6
  lines, then scrolling. The paperclip sits at the right inside the field while the text is one line. Once the text
  wraps, the paperclip moves to the field's top-right corner, and the text uses the full width below it.
- Right of the field is one round 48 px button. It shows the mic when there is nothing to send: no text, no images, no
  pending comments. Otherwise it shows Send. The switch is animated with a scale-and-fade, as in Telegram.
- While the agent works, a 40 px round Stop sits left of that button. A voice message is exactly like a text
  message: while the agent works, the "send now or after" dialog asks for it too. "Now" sends `force`; the server
  transcribes first, then interrupts the running turn and hands the text over.
- Recording, as in Telegram:
  - Hold the mic. After 150 ms the recording starts with a light haptic.
  - The mic grows into a 96 px circle in the primary colour under the finger. It has a halo that swells with the input
    level.
  - The field's row is replaced by a red dot that blinks every 500 ms, the timer `0:03,4` (tenths), and a centred
    "‹ Slide to cancel". That label follows the finger left and fades as it nears the cancel distance.
  - Above the big circle floats a lock pill (a lock over a chevron). Sliding up 80 px closes the lock.
  - Releasing sends. Sliding left 96 px cancels, with a medium haptic and the row sliding back.
- Locked: the big circle becomes Send (a paper plane). The middle shows "Cancel" in capitals and the pill becomes a
  Stop square. Stop ends the recording into a preview row: a delete (trash) button, play, the wave and the length, and
  Send on the right. Send in either state sends the message. Delete or Cancel drops it.
- A short tap on the mic shows Telegram's hint as a small dark tooltip above the button: "Hold to record, release to
  send". It fades after 2 s. It is not a snack bar.
- The recorder's 10-minute cap ends a recording as a release does: it is sent. In locked mode it goes to the preview.
  The timer turns the accent colour from 9:50.

### The phone comment sheet

- The mic in the sheet records a clip with the same gestures and hints. Releasing adds the clip under the text; it
  does not save the comment. Locked mode and its preview work as above.
- Each clip shows as a row: play, the wave, the length, its transcript (or "Transcribing…", or the error with Retry),
  and a delete button. Up to 10 clips.
- Save waits for every clip's transcript. It is disabled with a spinner meanwhile. A comment can be clips only, with no
  typed text.

### The desktop

- The composer gets a mic button left of Send (tooltip with Alt+R). Click starts a locked recording at once: the
  textarea's place shows the red dot, the timer, the live wave, ✕ Cancel, ■ Stop (to the preview) and ➤ Send.
  Press-and-hold (over 300 ms) records while held and sends on release. Esc cancels. Enter or Alt+R sends.
- The browser records with `getUserMedia` and an `AudioContext`. The audio is resampled to 16 kHz, 16-bit mono, and
  written as a WAV in the page. The recording stops at 10 minutes, as the phone's does. A denied microphone says so in
  the composer's status line.
- Without Whisper the mic opens Settings → Dictation.
- The web comment editor gets the clip row and its mic (click to record, click to stop; no hold on desktop). The
  comment cards and the "N comments" list of a user bubble show the clips with play and transcript.
- Voice bubbles render in the feed as described above.

### Text

All new strings in all six languages, with real translations, web and phone. The guide (`docs/guide.md`) and
`mobile/README.md` describe voice messages, clips and the storage of audio. The phone UX spec's dictation lines point
here.

## Left to the builder

- The index file's format and name under the state dir (append-only JSONL is enough).
- The exact animation curves and durations, within Telegram's feel (fast, about 150–250 ms).
- The phone's player: a small native `MediaPlayer` channel (`nb/play`) playing a cached WAV file. No new packages.
- How the web's recorder is wired (a ScriptProcessor or an AudioWorklet), within the page's CSP.
- Splitting this into pull requests: server and protocol first, then the web and the phone.
