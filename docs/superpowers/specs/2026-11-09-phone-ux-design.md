# Phone UX: a Telegram-like Android app with comments in the chat

The remote prototype (#63, `2026-11-07-remote-prototype-design.md`) works end to end: pairing, the chat, Stop,
usage statistics, offline and reconnect. A real test on a phone showed what keeps it from being the place to work:

- there is no way to set the permission mode, so approvals cannot even be tried;
- text can be commented only in Markdown files, not in the chat, and commenting the chat was the main story;
- dictation loses words and stops at the first pause.

This document redesigns the app around Telegram's interaction model, adapted to Nota Bene, and fills those gaps.
The reference is a set of reviewed HTML mockups (Darcula); they are local review material and are not tracked.

## Intent

The author is away from the laptop with an Android phone and wants to keep working with an agent the way they
chat in Telegram: read the reply, mark what is wrong in it, say the rest by voice, attach a screenshot, send.
Success: a review-and-steer loop on the phone (read, comment passages, dictate, send) feels as quick as replying
to a message in Telegram, and nothing the desktop can do in that loop is missing.

## Goals, non-goals, anti-goals

Goals:

- Telegram's look and gestures: floating header and composer, bubbles for the user's messages, long-press menus,
  hold-to-record voice.
- Comments on chat messages, with the desktop's anchors, labels and batch text.
- Window settings on the phone: permission mode, model and effort, plan limits, compact, clear, restart, stats.
- Voice that keeps every word: recorded and transcribed by Whisper on the host when it is on, otherwise the
  phone's recognition without stopping on a pause.
- Images in the chat: attach from camera, gallery or files; see them in bubbles; open, mark up and comment on
  images and video frames from the chat.
- A session list that shows, per host, which windows work, wait for an approval or have unread replies.

Non-goals (later): closed sessions and history (opening one needs starting a window on the host remotely); a file
tree of the project on the phone (images and video open from the chat and the session's files list, as today);
stopping or restarting a window from the session list (it needs a window connection without taking the tab);
sending video or audio files to the agent (agents take images and text); push notifications; iOS.

Anti-goals: a second comment flow whose anchors, labels or batch text differ from the desktop's; a voice message
the agent receives as audio (it gets text, the user sees and edits it first); a recording that silently loses its
end; a desktop feature changed by this work.

## Constraints

- The prototype's constraints stand: `main` rules, six UI languages for every new string (ARB files, or the
  strings generator for web-owned texts), tests on 4790–4795, public repository hygiene.
- The phone speaks the window's protocol as an ordinary tab. A protocol change bumps `PROTOCOL` and regenerates
  the Dart types (`npm run gen:protocol`); the app degrades on an older server, as it does today for `models`.
- Icons match the web UI's: the same glyphs (the web draws its own lucide-style stroke SVGs) for compact
  (`minimize-2`), clear (`eraser`), restart (rotate-cw arrow), usage (bar chart), comments and send.
- Relay and channel limits as documented in `relay/PROTOCOL.md` and `server/src/remote/CHANNEL.md`.
- New Flutter packages are dependencies: each one is named in its PR and agreed before it is added.

## Decisions

### Look and layout

- **Header:** a floating round back button, a pill with the agent's avatar, the session title (as the window's tab
  on the host names it, e.g. "Nota Bene IDE") and a subtitle `model · mode · limits` with two mini bars (five-hour
  and weekly, from `stats`), and a round "⋮" button. Tapping the pill opens the window settings sheet. The "⋮" menu
  keeps the session's files list.
- **Feed:** the user's messages are bubbles (right, the theme's "mine" colour); agent replies, tool lines and
  markers stay full width, as on the desktop, because replies carry code, tables and diagrams. Images of a user
  message (`user.images`) show in its bubble.
- **Composer:** a floating pill with the paperclip, the field and the microphone inside, and a send button that is
  always visible, greyed when there is nothing to send. Stop replaces send while a turn runs, as now.
- **Code:** a code block in a reply has an expand icon; tapping it opens the code full screen: line numbers, no
  wrap, horizontal scroll, pinch zoom, close, copy, comment on the selection. The app is not locked to portrait,
  so turning the phone gives the landscape view.
- **Look:** the themes' tokens, Darcula first; Telegram's shapes (pills, round buttons, sheets with a grab bar).

### Window settings sheet

Opened from the header pill, top to bottom:

- **Model and effort:** the existing model sheet's content.
- **Mode:** a segmented control of `hello.capabilities.modes` with the selected mode's description under it; it
  sends `{type:'mode'}` and shows the `mode` event's ack. Names and descriptions are the web's `mode_<id>` and
  `mode_<id>_desc` strings, added to the strings generator; Codex and omp show their own modes, as on the web.
- **Plan limits:** five-hour and weekly bars with percent and reset time, from `stats`; rows absent when the agent
  reports none.
- **Actions:** four equal tiles, icon above a short label: Compact, Clear, Restart, Stats. Clear asks first, as on
  the desktop, and is held back by the same pending-comments guard (`isClearCommand` in `web/src/comments/send.ts`).

### Comments in the chat

- **Where comments live:** in the window's comment set on the host, as today for file comments: the phone
  replaces the set with `{type:'comments'}`, the desktop sees the same comments, and `send.commentIds` sends them.
  No protocol change for this.
- **Commentable items:** as on the desktop: user messages, final assistant replies, plans, tool panels; not
  streaming text. The anchor is a `TextAnchor` over the item's rendered text with source
  `{kind:'message', id, agent?}`, built by the existing Dart port of the anchors (`comments/anchor.dart`). The text is the rendered text, computed
  by that port's `renderedText` the way it already is for Markdown files, and its fixture parity test against the
  desktop (`web/src/anchors/mobileParity.test.tsx`) gains chat replies (my call: no second text model).
- **Long-press a message:** a row of quick-label emoji above it (the desktop's floating-bar five, then "⌄" for all
  eleven) and a vertical menu below: Comment, Select text, Copy, Reply. An emoji or Comment applies to the whole
  message. Select text enters selection with handles and a vertical menu: Comment, Copy, Select all. Reply puts the
  message (or the selection) into the draft as a Markdown blockquote, `> ` per line, followed by an empty line
  (my call). The selection menu replaces Flutter's default toolbar (my call).
- **Comment sheet:** the existing one, with the labels as emoji only (the name in a tooltip on long-press) and the
  microphone using the same voice path as the composer.
- **In the feed:** commented passages are highlighted and numbered; the queue above the composer is the existing
  strip. Send is enabled with comments alone.
- **Batch text:** the phone writes "where" exactly as the desktop does for chat anchors (reply, my message, tool,
  plan, agent; `selectReplyLabel` in `web/src/store/store.ts`), not the generic "chat" it writes now. A parity test
  pins it against the desktop's output.

### Voice

- **Gestures (Telegram):** hold the microphone to record; release to stop; slide left to cancel; slide up to lock,
  then a stop button ends it. A timer and level show while recording.
- **With Whisper on the host** (`capabilities.dictation === 'whisper'`): the phone records with the existing
  native recorder (`nb/record`) and `HostDictation`, sends
  the WAV to `/dictation/transcribe`, and the text is inserted into the field for editing; "Transcribing…" shows
  meanwhile. Recording is capped at 120 s by the 4 MiB request cap; the timer warns before the cap, and at the cap
  the recording stops and is transcribed, never dropped.
- **Without it:** the phone's recognizer runs continuously while recording: it sets the silence extras, restarts
  itself after the system ends a session, and keeps the words already recognized, so a pause no longer ends the
  dictation. Hold and lock work the same way.
- The same path serves the composer and the comment sheet.

### Images and video

- **Attach:** the paperclip opens a sheet with Camera, Gallery and File. Gallery opens Android's system photo
  picker (several images), Camera the system camera, File the system document picker, all through the app's
  native code (my call: no gallery permission and no new package; the mockup's in-sheet gallery grid would need
  both, and can come later); images only (png, jpeg, gif, webp, as `/attach` takes). A caption goes as the message text. Images are
  scaled as on the desktop (1568 px long edge, PNG over 3.5 MB to JPEG), uploaded with `POST /attach`, shown as
  thumbnails over the composer with a remove cross, and sent as `send.images`.
- **In the feed:** an image the agent saved (a `/tmp` path served by `/tmpimage`, or a project image) shows as a
  card in the reply; a project video shows as a card with duration and size, loaded only when tapped.
- **Viewer, markup, video:** the existing image and video screens, restyled: black background, swipe between the
  message's images, swipe down to close, actions Mark up, Comment, Share. Markup tools and the frame comment flow
  stay as they are; a frame comment joins the queue with its thumbnail and time.

### Session list

- Grouped by host; an offline host greyed with "last seen". A row: agent avatar, session title, time of the last
  event, the last event's text, a working dot, "!" for a waiting approval, an unread count, folder and model.
- The host stream (`device.ts` `INFO_FIELDS`, the window info in `server.ts`) gains `pending` (an approval or
  question waits) and `last` (`{text, at}` of the latest user or assistant message, the text cut to a line).
  The window server already holds its feed, so it fills both without new tracking. Unread is computed on the
  phone: the `at` of the last reply seen, stored per host and session id (not port, which changes on a restart);
  Mark read sets it. It is per phone, not synced (my call).
- Long-press a row: Open, Mark read.
- The QR button adds a host, as now.

### Older servers

Each new field and message degrades by hiding: no `modes` in `hello`, no mode row; no `stats` limits, no bars;
no `pending` or `last`, rows without them (my call).

## Left to the builder

Widget structure and state; gesture thresholds; how selection is drawn in the feed; the exact shape of `last`;
icon drawing (SVG assets or painters) as long as the glyphs match the web's; which Flutter packages for the camera,
gallery and file picking, within the dependency rule above; tests, with at least widget tests per screen, a parity
test for chat-anchor batch text, and connector tests for the new host fields.

## Delivery

Child issues of the remote epic #63 (#142–#147, titled `[Remote] …`), one per part below, merged in this order
into an integration branch, then into `main` in one PR. Each child ends with an APK the author tries on the device.

1. Layout: header pill, bubbles, composer, full-screen code.
2. Window settings sheet: mode, model and effort, limits, the four actions.
3. Comments in the chat.
4. Voice: gestures, host Whisper path, continuous phone recognition, the comment sheet's microphone.
5. Images: attach, images in bubbles, media cards, restyled viewer.
6. Session list: host fields, rows, unread, long-press.
