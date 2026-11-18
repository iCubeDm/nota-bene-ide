# Mobile UX for input, app states, pairing, sync and notifications (Android companion for AI coding-agent sessions)

Research date 2026-11-10, about 20 tool calls. Vendor help centres (Telegram FAQ, WhatsApp FAQ, Signal support) returned 403/empty, so those areas are gaps, not filled from memory.

## Composer: growth, send vs newline, attachments, drafts, queued/scheduled messages, keyboard

**Takeaway.** Telegram is the best-documented reference for drafts and scheduled sends: drafts are server-side objects pushed to all devices and cleared on send; a scheduled queue is editable until it goes out. Android's IME-inset APIs (edge-to-edge plus insets animation) keep a bottom composer synchronized with the keyboard.

**Findings**
- Telegram stores unsent text as a server draft (`messages.saveDraft`), pushed to all devices via `updateDraftMessage`; dialog lists carry each chat's draft. Cleared by `clear_draft` on send or saving an empty draft; with media the draft text becomes the caption. The doc does not specify cross-device conflict handling or update ordering ([API: drafts](https://core.telegram.org/api/drafts)). 2016 framing: "start typing on your phone, then continue on your computer" ([blog](https://telegram.org/blog/drafts)).
- Scheduled messages: pending messages can be edited, rescheduled, sent now or deleted; `editMessage` accepts `schedule_date`; "Send When Online" in private chats (third-party guides) ([API](https://core.telegram.org/api/scheduled-messages), [Guiding Tech](https://www.guidingtech.com/how-to-schedule-messages-on-telegram-on-mobile-and-desktop/)). Editing sent messages is time-limited ([editMessage](https://core.telegram.org/method/messages.editMessage)). A bug report: attachment button missing in Android's Scheduled view, a known pitfall for queued views ([bug](https://bugs.telegram.org/c/63709)).
- Keyboard: edge-to-edge, read `WindowInsetsCompat.Type.ime()`, use `WindowInsetsAnimationCompat` (API 30+) so the composer tracks the keyboard frame by frame (else content snaps); `adjustResize` for backward compatibility; Compose does this automatically. API 37.2+ offers opt-in synchronized insets animation and an off-main-thread listener, with a stutter warning on complex hierarchies ([Android](https://developer.android.com/develop/ui/views/layout/sw-keyboard)).
- NN/g: keep what the user entered so they can edit; catch likely mistakes before sending (mentions an attachment but none attached) ([errors](https://www.nngroup.com/articles/error-message-guidelines/)).

**Inferences**
- A "queued while agent busy" message maps onto Telegram's scheduled model: visible queue with edit/reorder/send-now/delete until dispatched, attachments editable (Telegram's gap).
- Shared draft: server-held per session, cleared by the send operation itself (not a separate call) to avoid ghost drafts after a send from another device. Conflict policy (last-writer-wins vs not overwriting while the field is focused) must be designed.
- Enter-sends vs newline, multiline max height, chip strip placement: no authoritative source; decide by testing.

**Gaps.** No primary source for multiline growth limits, send-vs-newline conventions, attachment/chip layout in Telegram/WhatsApp/Slack/ChatGPT mobile; Telegram's draft conflict resolution and sent-edit window.

## Voice: hold vs tap, lock, cancel, waveform, speed, transcription, failures, permissions

**Takeaway.** WhatsApp's 2022 update set the standard: draft preview before send, pause/resume, live waveform, 1.5x/2x playback, playback outside the chat, resume position. Telegram's hold-to-record with upward lock is only confirmed by third-party guides. ChatGPT's dictation history shows the cost of removing review-before-send.

**Findings**
- WhatsApp: preview, pause/resume while recording, waveform, 1.5x/2x including forwarded messages, playback continues outside the chat, paused message resumes in place ([WhatsApp](https://blog.whatsapp.com/making-voice-messages-better), [Engadget](https://www.engadget.com/whatsapp-voice-messages-draft-recordings-speed-up-playback-150034778.html)).
- Telegram: official docs describe press-and-hold the mic and release to send; upward lock for hands-free (10-20 min recordings) and cancel (slide away / Cancel button) come from third-party guides ([docs](https://core.telegram.org/blackberry/chat-voice), [guide](https://rfgcreative.com/misc/how-to-send-voice-record-in-telegram.html)). Telegram added 2x playback ([blog](https://telegram.org/blog/unread-replace-2x)).
- ChatGPT mobile dictation: Android users complained dictation stopped showing the transcript in an editable field before sending; others report errors losing dictated content (May 2026), auto-send changes, and an iOS drag-and-hold usability issue ([no transcript](https://community.openai.com/t/voice-dictation-no-longer-shows-transcribed-text-before-sending-major-usability-regression/1177339), [error](https://community.openai.com/t/bug-report-voice-input-error/1379888), [auto-send](https://community.openai.com/t/critical-feedback-on-new-voice-to-text-auto-send-update-please-read/1234098), [iOS](https://community.openai.com/t/drag-and-hold-to-record-breaks-usability-on-ios/1273423)). Voice mode moved into the chat with a live transcript and a revert setting (late 2025); GPT-Live update July 2026 ([Android Authority](https://www.androidauthority.com/chatgpt-voice-mode-in-chat-3619633), [Headlines](https://www.androidheadlines.com/2026/07/chatgpt-gpt-live-1-voice-mode-update-features.html)).
- Android permission guidance (about POST_NOTIFICATIONS, applied by analogy to the mic): ask in context, state benefit and consequence, do not re-show after dismissal ([Android](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications)).

**Inferences**
- For transcribe-on-the-computer: always show the transcript in an editable field before sending to the agent (mis-transcribed identifiers are costly); never discard audio/transcript on error, keep the recording and offer Retry transcription.
- Show an explicit "transcribing on your computer" state with audio retained (latency depends on relay and desktop being online).
- Adopt WhatsApp's pause/preview and Telegram's lock for long dictation; visible recording indicator and timer.

**Gaps.** Telegram's cancel/lock thresholds, haptics, minimum duration; Claude voice mode / Gemini Live UX; RECORD_AUDIO rationale guidance; Whisper-transcript display in messengers (WhatsApp transcripts only via a vendor blog, not relied on); privacy cues beyond the OS mic indicator.

## States and perceived performance: loading, empty, error, offline, progress, retry

**Takeaway.** NN/g timing rules: indicator after ~1 s, looped 2-10 s, percent-done beyond 10 s with estimate and cancel. Empty states state status, teach, offer a path. Errors are specific, near the source, with a next step and preserved input. Material: persistent offline indicator plus transient Retry snackbar.

**Findings**
- Progress: acknowledge at once; over ~1 s needs an indicator; looped spinner 2-10 s; percent-done 10 s+ with estimate (sooner when durations vary). Tactics: start slow, finish fast, avoid stalling at the end, rough ranges, step counts, label what loads, cancel for long waits, change button state on first click, avoid static "Loading…" (hides stalls) ([NN/g](https://www.nngroup.com/articles/progress-indicators/)).
- Skeletons: evidence conflicts. A Viget study (136 participants) reportedly found the longest perceived wait; another study higher perceived speed (secondhand) ([summary](https://theplusaddons.com/blog/skeleton-loading-screen/)); Carbon: skeletons suit predictable layouts ([Carbon](https://carbondesignsystem.com/patterns/loading-pattern)). Nielsen's limits (0.1/1/10 s) cited via secondary sources; UX Tigers gives a different threshold (over 10 s) than NN/g's 1 s ([UX Tigers](https://www.uxtigers.com/post/progress-indicators)).
- Empty states: accurate status (inaccurate empty messages during loading are "particularly harmful"), teach what the area shows, direct paths (e.g. "add" and "explore demo data") ([NN/g](https://www.nngroup.com/articles/empty-state-interface-design/)).
- Errors: near source, not colour alone, plain specific language, always a next step, blame the system, keep input, modals only for serious errors ([NN/g](https://www.nngroup.com/articles/error-message-guidelines/)).
- Offline: indicate state for mixed apps; persistent unobtrusive indicator when offline and the user tries an online task; Retry snackbar for failures; banners max two buttons ([offline](https://m2.material.io/design/communication/offline-states.html), [errors](https://m1.material.io/patterns/errors.html), [Google](https://design.google/library/offline-design), [web.dev](https://web.dev/articles/offline-ux-design-guidelines)).
- Progress notifications: for user-initiated long activities use the progress template with Cancel; "non-cancelable activities don't warrant notifications" ([Android](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications)).

**Inferences**
- "Agent is working" is indeterminate and often >10 s: percent-done cannot apply; use phase labels ("Reading files", "Running tests") plus elapsed time and Stop, not a bare spinner.
- Separate accurate states for "phone offline/relay down", "desktop offline", "agent idle"; mislabelling a loading list as "no sessions" is the harm NN/g flags.
- Optimistic send: show the message at once as "sending/queued" with Retry on failure, keeping text (not directly sourced for messengers).

**Gaps.** No primary source on streaming-text rendering, AI task time estimates, optimistic-send visuals in WhatsApp/Telegram/Slack; no current M3 page for offline banners (only m1/m2); skeleton vs spinner evidence secondary and contradictory.

## Onboarding and pairing: QR flows, trust cues, fingerprints, revocation

**Takeaway.** Signal and Tailscale document the clearest QR flows: the new device shows the QR, the trusted device scans, with expiry, device caps, inactivity unlinking and optional history transfer. Fingerprint/safety-number specifics and WhatsApp/Telegram flows were not retrievable.

**Findings**
- Signal linking: the new device creates a temporary provisioning address and shows a QR with it plus a public key; the primary scans and sends an encrypted provisioning message with account keys and a one-time linking token; senders then encrypt separately per linked device. "Finish Linking" asks whether to transfer history, with progress; media only from the last 45 days; device-to-device encrypted archive (one-time 256-bit AES key) ([Signal blog](https://signal.org/blog/a-synchronized-start-for-linked-devices/)).
- Signal limits (search summary; support page 403): up to 5 linked devices; auto-unlink after 45 days inactive; expired QR is normal, refresh and rescan; a non-Signal scanner shows "No Usable Data Found" ([support](https://support.signal.org/hc/en-us/articles/360007320551), [Beeper](https://help.beeper.com/chat-networks/signal)).
- Tailscale: add a device by QR instead of IdP login; the new device shows the QR, a signed-in phone scans; with device approval on it shows "needs approval"; the Android variant shows a code under the QR to enter in the admin console ([QR](https://tailscale.com/kb/1336/device-add-qr-code), [Android](https://tailscale.com/kb/1079/install-android)).
- Permission prompts: contextual UI first, dismissable, no re-prompt after dismissal; re-prompt possible from Android 13 ([Android](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications)).

**Inferences**
- Here the phone is the scanner (QR on the desktop), as in Signal desktop linking. The desktop should show a short-lived code, an explicit "pair this phone?" confirmation with device name, and a device list with revoke. Show a short verification string/fingerprint on both sides for trust through an untrusted relay; no retrieved source documents a specific fingerprint UX.
- Ask for camera permission at the scan step and notification permission after the first successful pairing.
- First-run tours vs progressive disclosure: no evidence; NN/g's "empty states that teach" supports teaching in place.

**Gaps.** WhatsApp Web/Desktop linking FAQ (empty fetch), Telegram QR login, Syncthing device IDs, Signal safety numbers, revoke-device UX, first-run tour evidence.

## Multi-device: drafts, read state, notification de-duplication, active-elsewhere

**Takeaway.** Telegram syncs drafts server-side as pushed updates. Slack suppresses mobile push while the user is active on desktop, with a timing setting. Read-state sync specifics were not retrieved.

**Findings**
- Slack: by default mobile notifications arrive 1 minute after locking the desktop screen or 10 minutes after cursor inactivity; options: as soon as sent, as soon as inactive, or after an extra delay; "immediately, even if I'm active" gives simultaneous notifications ([Slack](https://slack.com/help/articles/201355156-Configure-your-notifications)).
- Signal encrypts per linked device (each a separate recipient), so state sync is device-to-device by design.
- Android: dismiss stale notifications; completed actions should cancel or update the notification ([Android](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications), [Notifee](https://docs.page/invertase/notifee/react-native/android/interaction)).

**Inferences.** Use desktop-activity presence (as Slack) to delay phone push, but approvals that block the agent justify a short or zero delay; make the delay a setting. When a prompt is answered on one device, cancel its notification on the others.

**Gaps.** Read-state sync and notification de-dup mechanics in Telegram/WhatsApp/Signal; "active on another device" handoff cues; Slack engineering blog.

## Notifications for long tasks and approvals

**Takeaway.** Android allows up to three actions, discourages actions that duplicate the body tap, and recommends channels, grouping and lock-screen visibility levels. GitHub Mobile already approves/rejects deployments in-app; Claude's mobile remote sessions have user-reported gaps in permission-prompt pushes.

**Findings** ([Android](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications) unless noted)
- Up to three actions (suggested replies, pill buttons, text actions); no text actions duplicating the body tap; Reply is for small text, longer input opens the app. Notifee: max three buttons; cancel or update after the action ([Notifee](https://docs.page/invertase/notifee/react-native/android/interaction)).
- Channels (Android 8+): HIGH only for time-critical items needing action; categories `CATEGORY_PROGRESS`, `CATEGORY_ERROR`; do not notify for recoverable errors or syncing needing no user.
- Lock-screen visibility public/private/secret; private shows app name and neutral text ("2 new messages"). Title <= ~30 characters with the key info, content <= ~40; group same-type notifications so each child stands alone.
- GitHub Mobile: approve/reject deployments awaiting review, push for approval requests, listed in the Notifications tab, push schedules; 2021 sources, current app may differ ([changelog](https://github.blog/changelog/2021-04-01-reviewing-deployments-on-github-mobile), [blog](https://github.blog/news-insights/product-news/new-push-notifications-scheduling-releases-github-mobile/)).
- Claude Code: no standalone mobile app; Remote Control and cloud sessions live in the Claude app's Code tab; push is two `/config` toggles; user issues (Feb and May 2026) say permission-prompt pushes were missing and Approve/Deny buttons requested (not available then); third-party tools use the `PermissionRequest` hook with ntfy ([docs](https://code.claude.com/docs/en/mobile), [62458](https://claudeissues.com/issue/62458-feature-request-actionable-approve-deny-on-mobile-push-for-permission-prompts), [30592](https://claudeissues.com/issue/30592-bug-ios-claude-code-notifications-broken)).

**Inferences**
- Approval design: high-importance "Needs approval" channel with Approve / Deny (two actions plus body tap for details); "Task finished" on default; errors on their own channel. Show tool and target in expanded text but hide details on the lock screen (private); Approve from the lock screen should require unlock.
- After resolution anywhere, update/cancel the notification and show the outcome in-app.
- Delivery of pushes for blocked agents is the core reliability requirement: surface "pushes not arriving" diagnostics (battery optimisation, permission) in settings.

**Gaps.** ChatGPT tasks and Codex mobile notification behaviour; whether FCM-style push with action buttons can work via a self-hosted relay without Google services (not researched).
