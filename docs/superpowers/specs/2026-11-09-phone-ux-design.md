# Phone UX: a Telegram-like Android app with comments in the chat

The remote prototype (#63, `2026-11-07-remote-prototype-design.md`) works end to end. A real phone test showed gaps: no way to set the permission mode (approvals cannot be tried); text can be commented only in Markdown files, not the chat (the main story); dictation loses words and stops at the first pause. This redesigns the app around Telegram's interaction model and fills them. Reference: reviewed HTML mockups (Darcula), local and untracked.

## Intent

Away from the laptop, the author wants to work with an agent as in Telegram: read the reply, mark what is wrong, say the rest by voice, attach a screenshot, send. Success: the review-and-steer loop feels as quick as replying in Telegram and nothing the desktop can do in that loop is missing.

## Goals, non-goals, anti-goals

Goals: Telegram look and gestures (floating header/composer, user bubbles, long-press menus, hold-to-record); chat comments with the desktop's anchors, labels and batch text; window settings on the phone (mode, model/effort, plan limits, compact, clear, restart, stats); voice that keeps every word (recorded on the phone, transcribed by Whisper on the host; #154: the phone's recognizer dropped words and is gone); images in the chat (attach from camera/gallery/files, bubbles, open, mark up, comment images and video frames); a session list showing per host which windows work, wait for approval or have unread replies.

Non-goals (later): closed sessions/history (needs remote window start); project file tree; stop/restart from the session list (needs a window connection without taking the tab); sending video/audio files to the agent; push; iOS.

Anti-goals: a comment flow whose anchors, labels or batch text differ from desktop; a voice message reaching the agent as audio (it gets text, the user sees and edits it first); a recording that silently loses its end; a desktop feature changed.

## Constraints

Prototype constraints stand (`main` rules, six languages via ARB files or the strings generator for web-owned text, ports 4790–4795, public-repo hygiene). The phone is an ordinary tab; a protocol change bumps `PROTOCOL` and regenerates Dart types (`npm run gen:protocol`); the app degrades on older servers. Icons match the web's lucide-style glyphs (compact `minimize-2`, clear `eraser`, restart rotate-cw, usage bar chart, comments, send). Relay/channel limits per `relay/PROTOCOL.md` and `server/src/remote/CHANNEL.md`. Each new Flutter package is named in its PR and agreed first.

## Decisions

### Look and layout

- Header: floating round back button; a pill with agent avatar, session title (as the host tab names it) and subtitle `model · mode · limits` with two mini bars (five-hour, weekly, from `stats`); round "⋮" button. Tapping the pill opens the settings sheet; "⋮" keeps the session's files list.
- Feed: user messages are bubbles (right, theme "mine" colour); agent replies, tool lines and markers stay full width (code, tables, diagrams). `user.images` show in the bubble.
- Composer: floating pill with paperclip, field and mic inside; send always visible, greyed when empty; Stop replaces it while a turn runs.
- Code: a block has an expand icon opening full screen (line numbers, no wrap, horizontal scroll, pinch zoom, close, copy, comment selection). Not locked to portrait.
- Look: theme tokens, Darcula first; Telegram shapes (pills, round buttons, sheets with grab bar).

### Window settings sheet

Top to bottom: Model and effort (existing sheet's content); Mode (segmented control of `hello.capabilities.modes` with the selected description; sends `{type:'mode'}`, shows the `mode` ack; names/descriptions are web `mode_<id>`/`mode_<id>_desc` added to the strings generator; Codex and omp show their own modes); Plan limits (five-hour and weekly bars with percent and reset, from `stats`; absent when none); Actions as four tiles: Compact, Clear, Restart, Stats. Clear asks first and, like the desktop button, is not blocked by pending comments (only a typed `/clear` is).

### Comments in the chat

- Stored in the window's comment set on the host as for file comments: phone replaces the set with `{type:'comments'}`, desktop sees the same, `send.commentIds` sends them. No protocol change.
- Commentable: user messages, final assistant replies, plans, tool panels; not streaming text. Anchor is a `TextAnchor` over the item's rendered text with source `{kind:'message', id, agent?}`, built by the Dart anchors port (`comments/anchor.dart`, `renderedText`); its parity test (`web/src/anchors/mobileParity.test.tsx`) gains chat replies (my call: no second text model).
- Long-press a message: quick-label emoji row above (desktop's floating-bar five, "⌄" for all eleven) and a vertical menu: Comment, Select text, Copy, Reply. Emoji/Comment apply to the whole message. Select text enters selection with handles and a menu: Comment, Copy, Select all (replaces Flutter's default toolbar; my call). Reply puts the message or selection into the draft as a Markdown blockquote (`> ` per line, then an empty line; my call).
- Comment sheet: existing one, labels as emoji only (name in long-press tooltip), mic uses the composer's voice path.
- Feed: commented passages highlighted and numbered; queue strip above the composer is the existing one; Send enabled with comments alone.
- Batch text: "where" written exactly as desktop for chat anchors (reply, my message, tool, plan, agent; `selectReplyLabel` in `web/src/store/store.ts`), not generic "chat"; a parity test pins it.

### Voice

- Telegram gestures: hold mic to record, release stops, slide left cancels, slide up locks (then a stop button); timer and level shown.
- With host Whisper (`capabilities.dictation === 'whisper'`, protocol >= 14): a recording is a voice message, not dictation; see [the voice messages design](2026-11-09-voice-messages-design.md).
- Without it (#154): no recording; the mic opens a sheet with the desktop's install question (size, folder), installs Whisper on the host or turns it on, then follows the install. The phone's recognizer was dropped (live transcription lost words). A remote transcription server was left out: the window must be on anyway and a small server cannot hold whisper-small.
- The same recorder serves the composer (voice message) and the comment sheet (clips).

### Images and video

- Attach: paperclip opens Camera, Gallery, File. Gallery = Android system photo picker (multiple), Camera = system camera, File = system document picker, via the app's native code (my call: no gallery permission, no new package; the mockup's in-sheet grid would need both, later). Images only (png, jpeg, gif, webp). Caption = message text. Scaled as desktop (1568 px long edge, PNG over 3.5 MB to JPEG), uploaded with `POST /attach`, thumbnails with a remove cross, sent as `send.images`.
- Feed: agent-saved images (`/tmp` path via `/tmpimage`, or project image) show as cards; project videos as cards with duration/size, loaded on tap.
- Viewer: existing image and video screens restyled (black, swipe between images, swipe down to close; Mark up, Comment, Share). Markup and frame comment flow unchanged; a frame comment joins the queue with thumbnail and time.

### Session list

- Grouped by host; offline host greyed with "last seen". Row: avatar, title, last-event time and text, working dot, "!" for waiting approval, unread count, folder (coloured prefix, two lines a row, #161).
- Host stream (`device.ts` `INFO_FIELDS`, window info in `server.ts`) gains `pending` (approval/question waits) and `last` (`{text, at}` of the latest user/assistant message, cut to a line); the server already holds the feed. Unread is computed on the phone from the `at` of the last reply seen, stored per host and session id (not port); Mark read sets it; per phone, not synced (my call).
- Long-press a row: Open, Mark read. The QR button adds a host.

### Older servers

New fields/messages degrade by hiding: no `modes`, no mode row; no `stats` limits, no bars; no `pending`/`last`, rows without them (my call).

## Left to the builder

Widget structure and state; gesture thresholds; selection drawing; exact shape of `last`; icon drawing (SVG assets or painters) matching web glyphs; Flutter packages for camera/gallery/files within the dependency rule; tests at least widget tests per screen, a parity test for chat-anchor batch text, connector tests for the new host fields.

## Delivery

Child issues of epic #63 (#142–#147, `[Remote] …`), merged in order into an integration branch, then `main` in one PR; each ends with an APK the author tries: (1) layout: pill, bubbles, composer, full-screen code; (2) settings sheet; (3) chat comments; (4) voice: gestures, host Whisper path, comment-sheet mic (phone recognizer removed in #154); (5) images: attach, bubbles, cards, viewer; (6) session list: host fields, rows, unread, long-press.
