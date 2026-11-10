# Mobile UX for input, app states, pairing, sync and notifications (Android companion for AI coding-agent sessions)

Research date 2026-11-10. About 20 tool calls. Search snippets were thin for several vendor help centres (Telegram FAQ, WhatsApp FAQ, Signal support returned 403/empty), so those areas are marked as gaps rather than filled from memory.

## Composer: multiline growth, send vs newline, attachments, context chips, drafts, queued/scheduled messages, editing, keyboard

### Takeaway
Telegram is the best-documented reference for drafts and scheduled/queued sends: drafts are server-side objects pushed to all devices and cleared on send, and a scheduled queue is editable until it goes out. Android's IME-inset APIs (edge-to-edge plus insets animation) are the documented way to keep a bottom composer synchronized with the keyboard.

### Cited Findings
- Telegram stores unsent text as a server-side draft (`messages.saveDraft`); new drafts are pushed to all the user's devices via `updateDraftMessage`, and dialog lists carry each chat's draft — [Telegram API: drafts](https://core.telegram.org/api/drafts)
- A draft is cleared by passing `clear_draft` on send, or by saving an empty draft; when media is sent, the draft text becomes the caption — [Telegram API: drafts](https://core.telegram.org/api/drafts)
- The Telegram drafts doc does not specify conflict handling between two devices editing the same draft, nor update ordering — [Telegram API: drafts](https://core.telegram.org/api/drafts)
- Telegram's 2016 announcement framed drafts as "start typing on your phone, then continue on your computer — right where you left off" — [Telegram blog: Drafts](https://telegram.org/blog/drafts)
- Telegram scheduled messages: guides state pending messages can be edited, rescheduled, sent now or deleted; the API `editMessage` accepts `schedule_date`; "Send When Online" exists in private chats (third-party guides, wording varies) — [Telegram API: scheduled messages](https://core.telegram.org/api/scheduled-messages), [Guiding Tech](https://www.guidingtech.com/how-to-schedule-messages-on-telegram-on-mobile-and-desktop/)
- Editing already-sent Telegram messages is time-limited (API error when too much time has passed) — [Telegram API: editMessage](https://core.telegram.org/method/messages.editMessage)
- A bug report notes the attachment button was missing in Telegram's Scheduled messages view on Android: attachments in a queued/scheduled view are a known gap/pitfall — [Telegram bugs](https://bugs.telegram.org/c/63709)
- Android keyboard handling: configure edge-to-edge, read IME visibility/height via `WindowInsetsCompat.Type.ime()`, and use `WindowInsetsAnimationCompat` (API 30+) so the composer tracks the keyboard frame by frame; without it (Android 10 behaviour) content snaps and looks jarring; set `adjustResize` for best backward compatibility; Compose handles this automatically — [Android Developers: Control and animate the software keyboard](https://developer.android.com/develop/ui/views/layout/sw-keyboard)
- API 37.2+ offers opt-in synchronized insets animation and an off-main-thread `WindowInsetsAnimationListener`; the doc warns it can cause stutter on complex hierarchies — [Android Developers](https://developer.android.com/develop/ui/views/layout/sw-keyboard)
- NN/g error guidance relevant to sends: keep what the user entered so they can edit rather than start over; catch likely mistakes before sending (e.g. mentions an attachment but none attached) — [NN/g: Error-message guidelines](https://www.nngroup.com/articles/error-message-guidelines/)

### Inferences
- A "queued while agent busy" message maps onto Telegram's scheduled model: show it in a visible queue, allow edit/reorder/send-now/delete until it is dispatched; keep attachments editable in the queue (Telegram's gap).
- Shared draft: treat it as server-held per session, cleared by the send operation itself (not by a separate call) to avoid ghost drafts after a send from another device. Conflict policy (last-writer-wins vs. skip overwriting while the field is focused) is not documented by Telegram; must be designed.
- Enter-sends vs Enter-newline defaults, multiline max height, chip strip placement: no authoritative source found; decide by testing (see Gaps).

### Gaps
- No primary source found for multiline growth limits, send-vs-newline conventions on mobile, or attachment/chip strip layout in Telegram/WhatsApp/Slack/ChatGPT mobile.
- Draft conflict resolution across devices is undocumented by Telegram.
- Editing a sent message window (Telegram's exact limit) not found in retrieved sources.

## Voice: hold vs tap, lock, cancel, waveform, speed, transcription, failures, privacy, permissions

### Takeaway
WhatsApp's 2022 voice update established the now-standard feature set: draft preview before send, pause/resume, live waveform, 1.5x/2x playback, playback outside the chat and resume position. Telegram's hold-to-record with upward lock is widely described but only confirmed by third-party guides; ChatGPT's dictation history shows the cost of removing the review-before-send step.

### Cited Findings
- WhatsApp: preview a recording before sending; pause and resume while recording; waveform visualisation; 1.5x/2x playback incl. forwarded messages; playback continues when leaving the chat; paused message resumes from the same spot — [WhatsApp blog: Making voice messages better](https://blog.whatsapp.com/making-voice-messages-better), [Engadget](https://www.engadget.com/whatsapp-voice-messages-draft-recordings-speed-up-playback-150034778.html)
- Telegram: official docs describe press-and-hold the mic by the input field and release to send; the upward drag to lock for hands-free is described by third-party guides (10-20 minute recordings), and cancel is variously described (slide away / Cancel button) — not confirmed in an official Telegram page — [Telegram docs (BlackBerry)](https://core.telegram.org/blackberry/chat-voice), [rfgcreative guide](https://rfgcreative.com/misc/how-to-send-voice-record-in-telegram.html)
- Telegram added 2x voice message playback — [Telegram blog](https://telegram.org/blog/unread-replace-2x)
- ChatGPT mobile dictation: Android users complained that dictation stopped showing transcribed text before sending and skipped an editable field; others report voice input erroring and losing dictated content (May 2026) and auto-send changes; iOS thread says recording needed drag-and-hold (undated) — [OpenAI community: no longer shows transcribed text](https://community.openai.com/t/voice-dictation-no-longer-shows-transcribed-text-before-sending-major-usability-regression/1177339), [Bug report voice input error](https://community.openai.com/t/bug-report-voice-input-error/1379888), [Auto-send feedback](https://community.openai.com/t/critical-feedback-on-new-voice-to-text-auto-send-update-please-read/1234098), [Drag and hold iOS](https://community.openai.com/t/drag-and-hold-to-record-breaks-usability-on-ios/1273423)
- ChatGPT voice mode moved into the chat with a live transcript and a setting to revert to a separate screen (late 2025); GPT-Live voice update announced July 2026 — [Android Authority](https://www.androidauthority.com/chatgpt-voice-mode-in-chat-3619633), [Android Headlines](https://www.androidheadlines.com/2026/07/chatgpt-gpt-live-1-voice-mode-update-features.html)
- Android notification permission guidance (applies to the mic prompt analogously): ask in context, describe the benefit and consequence of not granting, don't re-show the prompt after the user dismissed the contextual UI — [Android Developers: Notifications](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications) (this page is about POST_NOTIFICATIONS, not RECORD_AUDIO)

### Inferences
- For a transcribe-on-the-computer flow, the pitfall evidenced by ChatGPT complaints is: always show the transcript in an editable field before it is sent to the agent (voice is a coding instruction; mis-transcription of identifiers is costly), and never discard audio/transcript on error — keep the recording and offer Retry transcription.
- Show an explicit "transcribing on your computer" state with the original audio retained, since latency depends on the relay and the desktop being online.
- Adopt WhatsApp's pause/preview and Telegram's lock to make long dictation safe; add a visible recording indicator and timer.

### Gaps
- No official source for Telegram's slide-left-to-cancel/slide-up-to-lock thresholds, haptics, or minimum-duration rules.
- No source on Claude voice mode / Gemini Live UX specifics, Android RECORD_AUDIO rationale guidance, or Whisper-transcript display in messengers (WhatsApp transcripts are described only by a vendor blog, [Sonix](https://sonix.ai/resources/?p=3635), not relied on).
- Privacy cues (mic indicator, on-device vs server processing wording): only the OS-level indicator is known generally; no sourced finding.

## States and perceived performance: loading, empty, error, offline, progress, retry

### Takeaway
NN/g gives concrete timing rules (indicator after ~1 s, looped 2-10 s, percent-done beyond 10 s with estimate and cancel). Empty states should state status, teach and offer a path. Errors should be specific, kept near the source, with a next step and preserved input. Material suggests a persistent offline indicator plus transient retry snackbar.

### Cited Findings
- Immediate acknowledgement: show visual feedback at once; any delay over about 1 s needs a progress indicator; looped spinner for 2-10 s; percent-done for 10 s or more; show an estimate above 10 s; switch to percent-done sooner if durations vary widely — [NN/g: Progress indicators](https://www.nngroup.com/articles/progress-indicators/)
- Perceived-speed tactics: start progress slower and finish faster; avoid stalling at the end; use rough ranges with margin; show step counts; label what is loading; offer cancel for long waits; change button state on first click instead of warning "don't click again"; avoid static "Loading…" because it doesn't reveal stalls — [NN/g: Progress indicators](https://www.nngroup.com/articles/progress-indicators/)
- Skeleton screens: evidence conflicts. A Viget study (136 participants) reportedly found skeletons produced the longest perceived wait; another academic study found higher perceived speed (secondhand summary only) — [Plus Addons summary](https://theplusaddons.com/blog/skeleton-loading-screen/); Carbon says skeletons suit predictable layouts — [Carbon loading pattern](https://carbondesignsystem.com/patterns/loading-pattern)
- Nielsen's response-time limits (0.1 s instant, 1 s flow, 10 s attention lost) are cited via secondary sources; UX Tigers gives a different indicator threshold (over 10 s) than NN/g's 1 s — [UX Tigers](https://www.uxtigers.com/post/progress-indicators)
- Empty states: communicate status accurately (inaccurate empty messages during loading are "particularly harmful"); teach what the area shows and how to populate it; give direct paths/buttons (e.g. offer both "add" and "explore demo data") — [NN/g: Empty states](https://www.nngroup.com/articles/empty-state-interface-design/)
- Errors: place near the source; don't use colour alone; plain language, specific, always a next step; blame the system not the user; keep user input; reserve modals for serious errors — [NN/g: Error-message guidelines](https://www.nngroup.com/articles/error-message-guidelines/)
- Offline: Material says apps with mixed offline/online features should indicate current state; persistent unobtrusive indicator when offline and the user attempts an online task; snackbar with Retry for failed operations; banners max two buttons — [Material offline states](https://m2.material.io/design/communication/offline-states.html), [Material errors](https://m1.material.io/patterns/errors.html), [Google offline design](https://design.google/library/offline-design), [web.dev offline UX](https://web.dev/articles/offline-ux-design-guidelines)
- Android progress notifications: for user-initiated long activities use the progress template with a Cancel action; "non-cancelable activities don't warrant notifications" — [Android Developers: Notifications](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications)

### Inferences
- "Agent is working" is an indeterminate, often >10 s task: NN/g's percent-done rule can't apply; use step counts/phase labels ("Reading files", "Running tests") plus elapsed time and a Stop action instead of a bare spinner.
- Distinguish "phone offline/relay down" from "desktop offline" from "agent idle" in separate, accurate states; mislabeling an empty/loading list as "no sessions" is the harm NN/g flags.
- Optimistic send: show the message immediately in a "sending/queued" state with Retry on failure, keeping text (per NN/g); not directly sourced for messengers.

### Gaps
- No primary source on streaming-text rendering, time estimates for AI tasks, or optimistic-send visuals in WhatsApp/Telegram/Slack; no current Material 3 page for offline banners (retrieved pages are legacy m1/m2).
- Skeleton vs spinner evidence is secondary and contradictory.

## Onboarding and pairing: QR flows, trust cues, fingerprints, revocation, tours

### Takeaway
Signal and Tailscale document the clearest QR flows: the new device displays the QR, the trusted device scans, with expiry, device caps, inactivity unlinking and optional history transfer. Fingerprint/safety-number specifics and WhatsApp/Telegram flows were not retrievable.

### Cited Findings
- Signal linking: new device creates a temporary provisioning address and shows a QR containing it plus a public key; the primary device scans and sends an encrypted provisioning message with account keys and a one-time linking token; senders then encrypt separately per linked device — [Signal blog: A Synchronized Start for Linked Devices](https://signal.org/blog/a-synchronized-start-for-linked-devices/)
- Signal "Finish Linking" step asks whether to transfer message history, with a progress indicator; media only from the last 45 days because attachments expire; transfer is device-to-device via an encrypted archive (one-time 256-bit AES key) — [Signal blog](https://signal.org/blog/a-synchronized-start-for-linked-devices/)
- Signal limits as reported by a search summary: up to 5 linked devices; automatic unlink after 45 days inactivity; expired QR codes are normal, refresh and rescan; scanning with a non-Signal scanner yields "No Usable Data Found"; remove old linked desktop if linking refused — [Signal support (search summary; page returned 403 on fetch)](https://support.signal.org/hc/en-us/articles/360007320551), [Beeper help](https://help.beeper.com/chat-networks/signal)
- Tailscale: a device can be added by QR instead of IdP login; the new device shows the QR, a signed-in phone scans it; if device approval is enabled the new device shows "needs approval"; Android app variant shows a code under the QR to enter in the admin console — [Tailscale: Add a device using a QR code](https://tailscale.com/kb/1336/device-add-qr-code), [Tailscale Android install](https://tailscale.com/kb/1079/install-android)
- Android permission prompt guidance: show contextual UI first (benefit, consequence), dismissable, don't re-prompt after dismissal; users can be re-prompted from Android 13 — [Android Developers: Notifications](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications)

### Inferences
- In this app the phone is the scanner (QR shown by the desktop), as in Signal desktop linking; the desktop should show a short-lived code, an explicit "pair this phone?" confirmation with a device name, and a device list with revoke. Display a short verification string/fingerprint both sides for trust through an untrusted relay; no retrieved source documents a specific fingerprint UX (gap).
- Ask for camera permission at the scan step and notification permission after the first successful pairing, in context (Android guidance).
- First-run tours vs progressive disclosure: no sourced evidence retrieved; NN/g's "empty states that teach" supports progressive teaching in place.

### Gaps
- WhatsApp Web/Desktop linking FAQ (fetch returned empty), Telegram QR login, Syncthing device IDs, Signal safety numbers/fingerprints, revoke-device UX, and first-run tour evidence: not found in this pass.

## Multi-device: drafts, read state, notification de-duplication, active-elsewhere

### Takeaway
Telegram syncs drafts server-side as pushed updates. Slack suppresses mobile push while you're active on desktop, controlled by a timing setting. Read-state sync specifics for Telegram/WhatsApp/Signal were not retrieved.

### Cited Findings
- Telegram draft sync via pushed updates (see Composer section) — [Telegram API: drafts](https://core.telegram.org/api/drafts)
- Slack: by default mobile notifications arrive one minute after locking the desktop screen or 10 minutes after cursor inactivity; options: as soon as sent, as soon as inactive, or after an extra delay; "immediately, even if I'm active" gives simultaneous notifications; mobile setting "Notify Me on Mobile" — [Slack Help: Configure your notifications](https://slack.com/help/articles/201355156-Configure-your-notifications)
- Signal encrypts per linked device (each device is a separate recipient), so sync of state is device-to-device by design — [Signal blog](https://signal.org/blog/a-synchronized-start-for-linked-devices/)
- Android: dismiss stale notifications so the drawer shows only current items; completed actions should cancel or update the notification — [Android Developers: Notifications](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications); [Notifee docs](https://docs.page/invertase/notifee/react-native/android/interaction)

### Inferences
- Use desktop-activity presence (like Slack) to delay phone push for an approval prompt, but approvals blocking the agent justify a short or zero delay; make the delay a setting.
- When a prompt is answered on one device, cancel its notification on the others (stale-notification rule).

### Gaps
- No sourced details for read-state sync, notification de-dup mechanics in Telegram/WhatsApp/Signal, or "active on another device" handoff cues. Slack engineering blog not retrieved.

## Notifications for long tasks and approvals

### Takeaway
Android guidance allows up to three actions, discourages actions that duplicate the body tap, and recommends channels, grouping and lock-screen visibility levels. GitHub Mobile already approves/rejects deployments from the app; Claude's mobile remote sessions have user-reported gaps in permission-prompt pushes.

### Cited Findings
- Expanded notifications can show up to three actions (suggested replies, emphasized pill buttons, text actions); don't include text actions that duplicate tapping the body; Reply action is for small text, longer input should open the app — [Android Developers: Notifications](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications)
- Notifee: max three action buttons; cancel or update the notification after the action completes — [Notifee](https://docs.page/invertase/notifee/react-native/android/interaction)
- Channels (Android 8+) let users tune each class; importance HIGH only for time-critical items the user must act on; categories include `CATEGORY_PROGRESS` and `CATEGORY_ERROR`; don't notify for errors the app can recover from or syncing that needs no user involvement — [Android Developers: Notifications](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications)
- Lock-screen visibility: public/private/secret; private shows app name and a neutral text such as "2 new messages" — [Android Developers: Notifications](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications)
- Title <= about 30 characters with the most important info; content <= about 40 characters; group same-type notifications so each child is understandable alone — [Android Developers: Notifications](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications)
- GitHub Mobile: approve or reject deployments awaiting review from the app; push for approval requests; approvals also listed in the Notifications tab; push schedules (days/hours) — [GitHub changelog: Reviewing deployments on GitHub Mobile](https://github.blog/changelog/2021-04-01-reviewing-deployments-on-github-mobile), [GitHub blog](https://github.blog/news-insights/product-news/new-push-notifications-scheduling-releases-github-mobile/) (2021 sources; current app may differ)
- Claude Code: no standalone mobile app; Remote Control and cloud sessions live in the Claude app's Code tab; push controlled by two `/config` toggles; user issue reports (Feb and May 2026) say pushes for permission prompts were missing and Approve/Deny buttons on push were requested, i.e. not available then; third-party tools use the `PermissionRequest` hook with ntfy to approve from a notification — [Claude Code docs: mobile](https://code.claude.com/docs/en/mobile), [Issue: actionable Approve/Deny](https://claudeissues.com/issue/62458-feature-request-actionable-approve-deny-on-mobile-push-for-permission-prompts), [Issue: iOS notifications broken](https://claudeissues.com/issue/30592-bug-ios-claude-code-notifications-broken)

### Inferences
- Approval notification design: High-importance channel "Needs approval" with Approve / Deny actions (two actions plus body tap to open details); "Task finished" on a default channel; errors on their own channel. Show tool + target (command, file) in the expanded text but hide details on the lock screen (private visibility); sensitive Approve from the lock screen should require unlock.
- After resolution anywhere, update/cancel the notification (the stale-notification rule) and show the outcome in-app.
- Pitfall evidenced by Claude issues: notification delivery for blocked agents is the core reliability requirement; surface "pushes not arriving" diagnostics (battery optimisation, permission) in settings.

### Gaps
- Current ChatGPT tasks and Codex mobile notification behaviour: no primary source retrieved. GitHub sources are 2021.
- Whether FCM-based push can carry action buttons for approvals via a self-hosted relay without Google services: not researched.
