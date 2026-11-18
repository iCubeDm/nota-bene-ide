# Nota Bene Android app: UX inventory as implemented

Source: `mobile/app` (Flutter, Dart), read at the checked-out revision. Intent notes come from `docs/superpowers/specs/2026-11-09-phone-ux-design.md` and `docs/guide.md` ("Remote access", "The Android app"). References are `path:line`; paths without a prefix are under `mobile/app/lib/`. Descriptive except the last section. Android only (manifest: INTERNET, CAMERA, USE_BIOMETRIC, RECORD_AUDIO; no notification permission).

## 1. App structure and navigation

- Entry: `main()` loads theme and language choice from a secure vault before the first frame, builds one hidden WebView for Mermaid, wraps the Navigator in the lock gate (`main.dart:21-42`). `AppRoot` shows a spinner while identity, hosts and "seen" store load, or one text line if the store is unreadable (`main.dart:74-92`).
- Navigation is plain Material route pushes: Home -> Pair, Settings, Chat. No bottom nav, drawer or named routes (`main.dart:94-128`). Locales: en, ru, zh, es, pt, de; phone language if supported, else English.
- Home: AppBar with app name, a QR-scanner icon (only once a host exists) and a settings icon (`home.dart:292-309`). No hosts: explanatory text plus a filled "Pair a host" button (`home.dart:310-327`); else `HostsList`.
- Auto-reopen: once at start, the last opened chat is pushed if its host is online and still lists that window; waits while "connecting"; fires on later link/host changes until tried once (`home.dart:256-278`). No setting to disable it.
- Lifecycle: links pause 10 minutes after the app is hidden, resume on show (`home.dart:228-236`).

### Session list (HostsList)

- One group per paired host: `ListTile` with a 10 px status dot (success online; muted connecting/offline; destructive unpaired), bold label, subtitle "Connecting...", "Offline", "Offline, seen N ago" or "Unpaired" (`hosts/hosts_screen.dart:55-79`). Unpaired shows a "Forget" button with no confirmation (`hosts_screen.dart:75-77`, `home.dart:333`). Online host without windows: muted "no windows" line. Offline hosts keep windows dimmed to 50% and not tappable (`hosts_screen.dart:166-170`).
- Session row: 54 px avatar with provider letter (C, X, O or first letter), accent dot while the window works; 17 px one-line title with last-message time (HH:mm today, short weekday within 7 days, else `d.MM`); second line: folder name (primary colour) then last message ("You: " prefix for user messages); right badge "!" (accent) when an approval/question is pending, else unread count in a primary pill (`hosts_screen.dart:113-306`).
- Tap opens the chat (online only); long press opens a sheet with "Open" (online only) and "Mark read" (`hosts_screen.dart:129-171`). No search, pinning, swipe actions, pull-to-refresh or section collapse. Unread is computed on the phone per host and session (`store/seen.dart`), not synced.

### Pairing (QR)

- Entry points: Home QR icon, empty-state button, "Pair a host" row in Settings (`home.dart:297-322`, `settings_screen.dart:108-112`).
- `PairScreen`: AppBar "pair", `MobileScanner` filling the body, a bottom block with error line, hint ("scan the code from `nota-bene remote pair`") and "Paste the code instead" (clipboard). Busy: spinner and "Pairing..." (`pairing/scan_screen.dart:64-142`).
- Inline errors: not a code, code already used, host unreachable; camera denied vs failed are distinct (`scan_screen.dart:58-62,102-113`). A `ScanGate` stops the same failed code re-triggering (`scan_screen.dart:40,96`).
- `ConfirmScreen`: host and phone fingerprints (20 px monospace, selectable), "compare with what `pair` printed" hint, full-width "Done" (`pairing/confirm_screen.dart:31-52`). No "they match / they differ" choice; Done is the only action.

### Settings

- One scrolling list (`settings_screen.dart:88-163`): paired hosts (relay host name, "Forget" with confirm dialog), "Pair a host", phone fingerprint, Language row (sheet: "System" plus six languages by own names), Theme with six rows (swatch, untranslated name, check) (`settings_screen.dart:29-81,99-160`, `theme.dart:258-291`).
- Themes: Darcula (default), Plannotator, IntelliJ Light, GitHub Light, Solarized Light, Solarized Dark; no follow-system option (`store/theme_choice.dart:15-17`). No settings for text size, haptics, notifications, lock timeout, or Whisper (managed from the mic sheet).

### Lock screen

- `LockGate` stacks the app under Offstage + TickerMode; locked means not painted, hit-tested or read out. Authenticates at start and after 5 minutes in background via BiometricPrompt with device-credential fallback (`lock/lock.dart:22-43,86-124`).
- Locked screen: 48 px lock icon, title, optional "authentication failed", filled "Unlock"; with no phone screen lock only a "set a screen lock" message and no way in (`lock.dart:126-156`).

## 2. Chat screen

### Structure

- `ChatRoute` owns the window tab (opened on push, closed on pop), composes `ChatPanes` with header, chat, files, comments (`chat/chat_route.dart:143-182`). Installs `PermissionWatcher` (auto-opening permission sheets) and marks replies seen while the tab is open (`chat_route.dart:75-90`).
- Draft text controller and focus node live in `ChatRoute` so Reply can write into the draft (`chat_route.dart:104-114`). The draft is disposed on leaving the chat (not persisted).

### Floating header

- Overlay on the panes (narrow) or inside the chat pane (wide); 8 dp margins, 40 dp tall (`chat/chat_header.dart:45-47,136-139`). Left: 40 dp round back button (`maybePop`) (`chat_header.dart:142-161`).
- Middle: stadium pill (popover colour 92% alpha, 1 px border) with a 28 dp provider avatar, 14 px one-line title, and an 11 px line with context meter (22x4 bar + percent; primary, accent at 60%, destructive at 85%) and the agent mode label (accent) (`chat_header.dart:59-135,195-250`). The whole pill opens the window sheet (`chat_header.dart:163-171`).
- Right: optional actions pill; no chat passes any, so it never appears. Header text clamped to 1.3x system scale (`chat_header.dart:59-61`). The header does not show connection state (a status line in the feed does).

### Window sheet (tap the header pill)

- Modal bottom sheet: title, project path, model + effort row (opens a second sheet with model list, effort chips, "Apply") or read-only model, permission-mode `SegmentedButton` (only with 2+ modes), mode description, plan limits (5 h and week rows with percent, reset time, 6 px bar), and four tiles: Compact, Clear, Restart, Stats (`chat/window_sheet.dart:57-247`, `chat/controls.dart:39-137`).
- Compact/Clear disabled while the agent works; Clear and Restart confirm; Stats opens the usage screen; refusals explained in a snackbar (`window_sheet.dart:175-281`, `controls.dart:15-37`). Tile labels 10.5 px (`window_sheet.dart:430`).

### Panes and the "Files, Chat, Comments" pill

- Three panes: Files (left), Chat (middle, opened first), Comments (right) (`chat/panes.dart:1-5,15`).
- Narrow (< 840 dp): `PageView` with `PageScrollPhysics`; a floating 40 dp pill of three labels (current tab a lighter stadium sliding with the swipe, accent count badge on Comments); a tap animates 250 ms (`panes.dart:220-306`, `ui/folder_tabs.dart:29-132`). Labels `FittedBox` scale-down at 14 px.
- Swipe: horizontal drag anywhere changes pane; disabled (NeverScrollable) while recording (`panes.dart:233-239`); a tap on another pane during a recording shows "finish the recording first" (`panes.dart:146-159`).
- Panes are kept alive (`_Kept`) with GlobalKeys so state survives narrow/wide (`panes.dart:54-72,115-119`).
- Wide (>= 840 dp, `widePanes`): Files : Chat : Comments at flex 3 : 5 : 3 with dividers; header moves inside the chat pane; no strip, no swipe (`panes.dart:75,181-219`).
- Back (narrow): `PopScope(canPop: current == chat)`; on Files pops one folder then goes to Chat; on Comments to Chat; on Chat leaves the route (`panes.dart:168-178,223-227`). Wide: pops a Files folder when deep, else leaves (`panes.dart:205-218`). The header back calls `maybePop` on the root navigator, so it leaves from any pane (`chat_header.dart:149`).
- Priority overlaps: a recording blocks pop and asks (`chat/composer.dart:330-335,203-237`); the message menu registers a `PopEntry` to close first (`chat/message_menu.dart:58-71,126-135`).

## 3. The feed

### Layout and scrolling

- Reversed `ListView.builder` (newest at bottom), 0 horizontal padding (bubbles carry margins), top padding = status bar + header 56 + strip 40; items keyed by id, `findChildIndexCallback` keeps state on insert (`chat/chat_screen.dart:183-196,220-229,266-293`). At the bottom the view stays pinned to the newest item; scrolled up, new content does not move it. No jump-to-bottom button or new-messages indicator.
- 2 px accent progress at the list bottom while compacting (`chat_screen.dart:295-304`).
- History: an "Earlier" text button as the last item (top) when `feed.earlier > 0`, one archived segment per tap, no auto-load, no spinner (`chat_screen.dart:245-251`, `chat/feed.dart:139-153,288-317`).
- Programmatic scroll to a message (from Comments): estimate by average item height, jump, step 0.8 viewport up to 40 times until the keyed item is built, then `ensureVisible` at alignment 0.3 over 250 ms; a fixed 300 ms delay waits for the pane switch (`chat_screen.dart:122-161`, `chat_route.dart:136-140`). No arrival highlight.
- Status line above the list (13 px muted): "Working..." while busy, "Connecting...", "Offline" / "Offline, seen N ago", "This window is gone"; occupied/taken show nothing (overlay covers) (`chat_screen.dart:206-215,334-346`). No action; Stop lives in the composer.

### User messages

- `UserBubble`: right-aligned, primary tint, 14 dp corners with square bottom-right, 1 px primary border at 45%, padding 10x7, margins 28 left / 8 right (`chat_screen.dart:715-745`). No timestamp or delivery/read status.
- Content: images above text, voice block, or Markdown with soft breaks (HTML as text), then folded sent comments (`chat_screen.dart:560-619`). One image full bubble width at 16:9, several in two columns at 4:3; tap opens the swipeable viewer (`chat/media_card.dart:203-237`).
- Voice message: 40 dp play button, 48-bar waveform (2 px bars, 1 px gaps, fixed 143 px) tap/drag to seek, 12 px elapsed/length, "Aa" transcript toggle (open by default), status rows: "Transcribing..." pulsing dot, error + Retry, "Sending..." / send failed with Retry and Delete (`voice/voice_view.dart:47-149`, `voice/voice_bubble.dart:16-192`, `chat_screen.dart:748-767`). No speed control.
- Sent comments folded under the bubble: "N comments" row with chevron, each with left-bar quote, "-> label text", voice clips with transcripts, images (`chat/sent_comments.dart:24-190`). If the comment set is empty but the message text carries the batch, the batch is shown folded.

### Agent messages

- A turn is one grouped bubble: text, tool, permission and shell pieces stacked without gap; first piece rounds top corners (14), last rounds bottom-right (14) with a 4 dp bottom-left tail; margins 8 left / 28 right; `agentBubble` colour (`chat_screen.dart:669-711`).
- Markdown via `flutter_markdown_plus`: GFM, inline and block KaTeX (display math scrolls horizontally, error falls back to source in destructive colour), raw HTML dropped, links open externally only for http/https; no table-specific scroll handling (`chat/markdown.dart:1-269`).
- Code blocks: card with language label, expand-to-fullscreen and copy icons (compact, 16 px), horizontal scroll, Darcula-token highlighting; commented passages painted with number badges in the bar (`chat/code.dart:145-240`). Copy gives no in-app confirmation.
- Mermaid: mermaid.js in one hidden 2x2 px WebView, returned as PNG, one diagram at a time with a 20 s timeout, cached per source/theme/scale; 48 px spinner, Mermaid's error text or a generic failure; tap opens a full-screen `InteractiveViewer` (max 8x) (`chat/mermaid.dart:72-298`). A streaming reply re-renders on each source change.
- Tool calls: one line with status icon (14 px: running dots, check, error), accent tool name, monospace main argument (one line); tap toggles the result (disabled while running); result panel selectable monospace max 320 dp; file-open button for project files (`chat_screen.dart:774-861`). Sub-agent calls indented 16.
- Media cards under a finished tool line (max 3): 16:9 image or video placeholder, file name, max width 360, indent 20 (`chat/media_card.dart:54-81,242-310`).
- Done line ("Done in 12 s" / interrupted / failed + error), markers (compacted, cleared), permission lines, notices, "idle compact": centered 13 px muted (`chat_screen.dart:552-559,633-664`). Shell blocks (`! cmd` + output): bordered monospace 12 px (`chat_screen.dart:651-663`).
- Structured permission/question prompts are answered inline in a card (title, command, optional text fields incl. secret, wrapped choice buttons, "settled" text) (`chat/permission_sheet.dart:194-317`). A plain unanswered permission shows a "Permission asked: tool" line that reopens the sheet (`chat_route.dart:116-133`).
- Streaming: a non-final assistant item grows in place; not commentable and no menu until final (`comments/chat_anchor.dart:14-24`). No indicator beyond the "Working..." line.

## 4. Message actions, selection and comments

### Long-press menu

- Long press on a user message or final agent reply (not tool lines, plans, status lines, streaming text) starts `showMessageMenu`; the press position is kept for "Select text" (`chat_screen.dart:464-527`). Haptic `selectionClick` on open (`chat/message_menu.dart:86`).
- Overlay (not a route) over a 60% black scrim: the message "lifted" in place (long ones scroll inside), a quick-label emoji row above, a vertical menu below (`message_menu.dart:279-353`). Scrim tap or back closes it; auto-closes if the route under it is no longer current (`message_menu.dart:72-85`).
- Quick labels: first five (Looks good, Love it!, Clarify this, Verify, Out of scope) as 44 dp emoji chips with the label as tooltip (long press); a chevron toggles all eleven (`message_menu.dart:23-34,175-227`, `comments/strings.g.dart`). Tapping an emoji adds a whole-message comment with that label and closes the menu, no text, no confirmation.
- Vertical menu, 220 dp wide, 48 dp rows: Comment, Select text, Copy, Reply (`message_menu.dart:229-277`). Comment opens the sheet on the whole message (quote cut to 200 chars in the sheet only) (`message_menu.dart:94-111`). Copy copies raw text, no feedback. Reply appends a Markdown blockquote (`> ` per line + blank line) to the draft and focuses the field (`message_menu.dart:40-42`, `chat_route.dart:104-114`). No delete/edit/resend/forward/share.

### Text selection

- "Select text" swaps the item for `SelectableMessage`: a `SelectionArea` with all text selected, then the word under the press re-selected by replaying a synthetic pointer down/up with a long-press timer (`chat/message_selection.dart:80-113`). Ends on a tap outside (`TapRegion`) or after a comment (`message_selection.dart:233-248`).
- Custom toolbar replaces Flutter's: 168 dp vertical card, three 44 dp rows: Comment, Copy, Select all (`message_selection.dart:172-231`). No Reply, labels, Share, Look up.
- Comment from selection: locates it in the rendered text; if it cannot be placed, snackbar "comment not placed"; else opens the sheet with the quote (`message_selection.dart:147-170`).

### Comment sheet

- Modal bottom sheet with drag handle, scrollable, keyboard-aware. Top to bottom: quote (max 4 lines, accent bar); scrolling row of 11 quick-label emoji (32 dp circles, selected outlined, name only as tooltip); voice clips (delete icon each); 2-8 line field (autofocus on create); mic button (only with protocol 14+) recording up to 10 clips; Delete (when editing), Cancel, Save (`comments/comment_sheet.dart:39-49,200-360`).
- Save disabled while a clip is transcribing/failed or recording; spinner while busy. A comment may be text, label, clips or any combination; an empty comment with no label is allowed (no validation) (`comment_sheet.dart:336-358`). The sheet has its own `ScaffoldMessenger` so snackbars show above it (`comment_sheet.dart:365-382`).

### Pending comments: strip and Comments pane

- Strip above the composer: card (max 132 dp) "N comments pending", one line per comment (quote muted, label, text, transcripts). Tap opens the file for file/media comments (video at its time); chat comments do nothing; long press opens the edit sheet with Delete (`comments/comment_strip.dart:30-118`). The file's header comment says long press deletes, but it edits.
- In the feed, pending comments are painted: passages highlighted with an accent badge of the strip number, whole-message comments as a badge at the message's top-right; a badge tap opens the edit sheet (`chat_screen.dart:349-462`, `files/file_markdown.dart:136-160`).
- Comments pane (right): empty "no comments yet"; "N pending" heading with a filled Send (enabled when the tab is open and comments sendable); pending rows (11 px where-label, 2-line quote, 4-line "-> body"); collapsible "Sent - N" (collapsed by default) grouped by the message they went with (newest first) (`comments/comments_pane.dart:123-238`). Tap goes to the place (chat: switch and scroll; file: open; media: open at time); long press edits pending; sent are read-only (`comments_pane.dart:45-66`).
- Sending: composer Send includes pending comments in the same batch text as the desktop; enabled with comments alone (`chat/composer.dart:239-293`, `chat/send_now.dart:36-92`). A refused send returns text, comments and images with a snackbar (`composer.dart:79-96`).

## 5. Composer

- Layout: under the comment strip: optional 60 dp image draft strip, then a row with a rounded field (22 dp radius, min 48, up to 6 lines) and a 48 dp round action button; padding 8,4,8,8 (`composer.dart:336-411,415-498`).
- Field: placeholder "Message"; disabled with "cannot send" when the tab is not open (`composer.dart:441-462`). The paperclip sits right of the field and moves to the top-right once text wraps to 2+ lines (width measured with a `TextPainter` using hard-coded paddings) (`composer.dart:295-312,431-440,471-485`).
- Action button: animated swap (180 ms) between mic (protocol 14+, nothing to send, or recording) and Send (primary when sendable, muted otherwise; spinner while an image uploads) (`composer.dart:328-405`). Default multiline keyboard action; no "send on Enter" setting.
- Stop: red 40 dp round button left of the action button while the agent works; interrupts immediately, no confirmation (`composer.dart:349-366`).
- Queue "now or after": while busy, Send (also Comments pane Send and a voice send) opens "Send now or after this turn?" with Cancel, "After" (queue), "Now" (interrupt, `force`); dismissing keeps the text (`send_now.dart:11-32`, `composer.dart:248-253`).
- Attachments: paperclip opens a sheet with Camera, Gallery, File (system picker, images only) (`chat/attach_sheet.dart:7-31`). Images are prepared in an isolate one at a time and uploaded in the background; thumbnail spinner while pending, red frame and error icon on failure, 24 dp remove cross; Send waits for uploads and is blocked while one failed. Errors (denied, busy, unavailable, too large, unsupported) are snackbars (`composer.dart:98-173,500-579`).
- Mic (`RecordButton`), Telegram-style: pointer-down starts a 150 ms timer; hold records, a 96 dp circle with level-driven halo follows the finger; slide left 96 dp cancels, up 80 dp locks, release sends; a short tap shows a 2 s hint tooltip; locked turns the button into Send with a 40 dp Stop above (`voice/record_button.dart:1-5,135-347`, `voice/record_session.dart:30-36`).
- Recording row replaces the field: blinking red dot, `m:ss,t` timer (accent after 9:50), "< Slide to cancel" following the finger; locked: CANCEL button; preview: trash icon and player (`voice/record_row.dart:17-138`). Minimum 500 ms, maximum 10 minutes.
- Accessibility path: Semantics button with label; TalkBack tap starts a locked recording (`record_button.dart:212-220`).
- Hold interplay: while recording, pane swiping and switching are refused (snackbar); back stops into the preview and asks send/delete/cancel; backgrounding a locked recording stops it into the preview (`panes.dart:146-159,233-239`, `composer.dart:202-237`, `record_button.dart:60-64`). Voice sends outlive the chat through an outbox keyed by host and session (`window_tab.dart:99-103`).
- Whisper prompt: without Whisper on the host, a mic press opens a sheet asking about install (download/disk sizes, folder), installs on the host, polls every 2 s, turns it on, shows "Whisper is on" (`dictation/whisper_sheet.dart:1-228`).
- Permission sheet: auto-opens as a modal sheet when a plain permission is asked and the tab is open: "Allow <tool>?", the whole command in a selectable monospace box (max 50% height), Deny (outlined) and Allow (filled); closes when answered elsewhere; swiping it away leaves the feed line that reopens it (`permission_sheet.dart:53-192`). Only Deny/Allow; "for this session" style choices exist only in the structured card.
- One-tab overlay: when another tab owns (occupied) or took (taken) the window, a 92% scrim covers the feed (not header, strip or composer) with a centered message and a "Work here" button that takes over (`chat/one_tab.dart:9-42`, `window_tab.dart:280-286`).

## 6. Files pane (left pane)

- A nested `Navigator`: folders are pages of the pane and back goes up a folder first (`files/files_pane.dart:50-76`).
- First page: in a git repo, a 40 dp row of tabs Files / Changes / Log (underline, tap only) over an `IndexedStack`; otherwise only the tree (`files_pane.dart:117-149`).
- Tree (`FolderPage`): title row (path tail up to 34 chars; up arrow on sub-folders), search field (250 ms debounce, host fuzzy search), at root a "This session" block of files the agent touched (first 5, "Show all N"), then entries, folders first (`files_pane.dart:21-25,293-481`). Dense rows with type icon, one-line name, parent folder as subtitle in the session block and search. Errors: inline with Retry; spinner; "folder empty"; "no matches".
- No long press, rename, delete, create or share; no pull-to-refresh on the tree; read-only.
- Opening a file pushes on the root navigator, full screen over the chat (`chat/files.dart:87-99`): Markdown -> `FileScreen`; png/jpg/gif/webp/bmp -> `ImageScreen`; mp4/mov/webm/m4v -> `VideoScreen`; else `TextFileScreen` (code viewer).
- Changes tab: changed files with colour-coded status letter, name over folder, +/- counts; pull-to-refresh; reloads on turn boundaries. Log tab: commits (2-line subject, short hash, meta), pull-to-refresh, last row says the log was cut at N (no load-more); a commit opens `CommitPage`, a file opens `DiffScreen` (`files/git_pages.dart:33-453`).

### Viewers

- Markdown (`FileScreen`): `SelectionArea` over `FileMarkdown`, limit 2 MiB; the toolbar prepends "Comment" to system items; commented passages highlighted, tap edits/deletes; failures are plain centered text without Retry (`files/file_screen.dart:35-230`).
- Code (`TextFileScreen` -> `CodeScreen`): bar with close, file name (or language), line count, a Comment icon (disabled until selection) and Copy; fixed-height `ListView.builder` (13 px x 1.5) under a horizontal scroll sized to the longest line (no wrapping), line-number gutter; pinch scales text 0.5x-3x (resets on reopen); highlighting skipped over 200 kB and for lines over 2000 chars; binary/too-large shows size; error has Retry (`chat/code_screen.dart:45-377`, `ui/pinch_scale.dart`, `files/text_file_screen.dart:11-123`). Also used for a chat code block (selection becomes a comment on the message) and files (file comment). Comment is in the top bar, not the selection toolbar, unlike Markdown files and messages.
- Diff (`DiffScreen`): unified, old/new gutters, tinted rows, hunk heads, pinch scale, two-way pan, selectable, Copy and Comment icons (Comment disabled until selection); over 3000 rows waits for "Show anyway"; per-line highlighting up to 1500 rows (`files/diff_screen.dart:1-30,235-330`). Comments anchor to file path (plus commit short hash) and the code-row text without markers or numbers.
- Image (`ImageScreen`): black screen, name and "n / N", horizontal `PageView` across the message's images, pinch zoom to 8x (pan only when zoomed; no double-tap zoom), vertical drag at scale 1 closes past 120 px or on a fast fling; actions Mark up, Comment, Share (attachments only); markup toolbar rect/ellipse/pen/arrow, five colours, undo; saving a media comment uploads the marked frame first (`files/image_screen.dart:122-437`, `media/markup.dart:192-282`). Failure: text only, no Retry.
- Video: `VideoPlayer` via a local proxy, play/pause, seek slider with ticks for existing media comments, mark-up/comment on the playhead frame; failed state message (`files/video_screen.dart:22-346`).
- Usage/Stats screen: provider and period chips, bars, model mix, limits, per-task detail; from the window sheet (`usage/usage_screen.dart`).

## 7. States: connection, empty, loading, errors

- Link states per host: connecting, online, offline, unpaired. Reconnect with exponential backoff 1-30 s, +/-20% jitter; unpaired when the relay replies 4403 (`hosts/host_link.dart:1-3,12,100-160`).
- Tab states: connecting, open, occupied, taken, gone, offline (`window_tab.dart:22`). A closed window socket under a live link retries after 1 s; a link drop sets offline and keeps the feed readable until the next replay (`window_tab.dart:185-264`).
- In chat: status line, composer disabled with "cannot send", one-tab overlay, permission sheet closing when the window goes away and reopening when back (`permission_sheet.dart:67-91`).
- Snackbars (default Material): send refused, attach errors, mic denied/failed, finish-recording-first, comment-not-placed, share failed, frame failed, mark-save failed, compact/clear refusal, Whisper ready (`composer.dart:79-127`, `panes.dart:149-158`, `message_selection.dart:147-156`, `window_sheet.dart:183-195`, `whisper_sheet.dart:151-156`). None has an action.
- Dialogs: send-now, restart, clear, forget host, leave-while-recording.
- Loading: centered `CircularProgressIndicator` for app start, files, images, file reads; no skeletons.
- Empty states: no hosts (CTA), no windows, empty folder, no matches, no comments, no changes, no commits, no repo. The feed has no empty state for a session without messages.
- Haptics: only message-menu open and the three recording events (`message_menu.dart:86`, `voice/record_session.dart:88,136,139`).
- No push or local notifications (spec non-goal, `docs/superpowers/specs/2026-11-09-phone-ux-design.md`); background connections pause 10 minutes after hide (`home.dart:228-236`).

## 8. Accessibility

- Explicit `Semantics` in two places: header meters (`chat_header.dart:214-217`, label "ctx NN%") and the mic (`record_button.dart:212-220`). No `semanticLabel`, `liveRegion`, `MergeSemantics` or `sortKey` anywhere.
- Most icon buttons carry tooltips (Material turns them into labels): back, expand, copy, send, stop, attach, folder up, comment, markup tools, voice play/pause; Home icons too (`home.dart:297-307`). Gaps: Files search clear button (`files_pane.dart:463-469`) and custom `GestureDetector`/`InkWell` targets.
- Text scale: only the header is clamped (1.3x); the composer's wrap measurement honours the system scaler (`composer.dart:307`); the rest follows system scale unclamped. The manifest lists `fontScale` in `configChanges`, so the activity is not recreated.
- Touch targets: Material defaults (48 dp) for IconButtons; smaller explicit ones: record stop 40, play 40, header back 40, composer stop 40, draft remove 24, comment badge 18, quick-label circles 32, code block icons compact, tool-line file icon compact (`record_button.dart:306-309`, `voice_view.dart:96`, `composer.dart:353-362,557-565`, `file_markdown.dart:151-155`, `comment_sheet.dart:240-244`).
- Colour is the only distinction for some states: connection dot (offline vs connecting both muted, differ by text), meter levels. Tests (`mobile/app/test/`) cover meter semantics and the mic, not screen-reader traversal.

## 9. Localization

- Six languages en, ru, zh (zh-CN), es, pt (pt-BR), de from shared `UI_LANGS`; a test enforces the `.arb` set equals `UI_LANGS` and every language has English's keys (`mobile/app/test/l10n_test.dart:11-37`); 204 keys per language (`l10n/app_*.arb`).
- Two string sources: app-owned ARB through `AppLocalizations`, and web-owned strings generated into `comments/strings.g.dart` by `npm run gen:protocol` from `web/src/comments/labels.ts` and `web/src/i18n` (quick labels, batch templates, "ctx", Changes/empty/failed texts, mode names/descriptions, clear confirm). `usage/format.dart` uses `usageString` similarly.
- Language "System" or explicit, stored in the vault, applied live (`store/lang_choice.dart`, `main.dart:165-176`). Dates via `intl`; relative time ("N min ago") by ARB plurals (`hosts_screen.dart:16-31`). Theme names not translated. Whisper sheet text partly from web strings.

## 10. Docs drift

`docs/guide.md` ("The Android app (prototype)") still describes an "agent menu" with Compact/Model/Restart and says comments on chat messages, images and video, usage statistics and dictation are "not yet"; the code has the window sheet, chat/image/video comments, a stats screen and Whisper voice.

## 11. Observed weak points

Concrete issues visible in the code; candidates for the gap analysis, not verdicts. Numbers are cited from the report.

Navigation and gestures
1. Pane swipe competes with inner horizontal scrollers: code blocks (`chat/code.dart:221-223`), display math (`chat/markdown.dart:112-115`), the draft strip, the voice waveform drag (`voice_view.dart:115-118`). The pager takes over when the inner scroller reaches its edge; no edge guard.
2. Files/Changes/Log tabs switch by tap only (`files_pane.dart:130-134`) while outer panes swipe: two tab strips with different rules; a swipe on Files goes to Chat, not the next sub-tab.
3. Back is inconsistent: header back leaves the chat from any pane (`chat_header.dart:149`); system back goes pane by pane (`panes.dart:168-178`).
4. A recording blocks pane switching with only a snackbar; the user must return to the composer to finish or delete (`panes.dart:149-158`).
5. Opening a file from any pane pushes over the root navigator and hides header/pill; no breadcrumb besides back (state is kept alive, so fine).
6. Auto-reopen of the last chat (`home.dart:256-278`) gives no visible transition from the list; Back lands on the list; no setting to disable.

Feed
7. No jump-to-bottom control or "new messages" indicator when scrolled up.
8. Older history is a manual "Earlier" button, one segment per tap, no loading state (`chat_screen.dart:245-251`).
9. Scroll-to-message from Comments uses a fixed 300 ms delay and up to 40 jump frames; can fail silently, no arrival highlight (`chat_route.dart:136-140`, `chat_screen.dart:122-161`).
10. Tool lines, plans, status lines and streaming text are not long-press targets (`chat_anchor.dart:14-24`); the spec says plans and tool panels are commentable, the code does not implement it; a long press there does nothing, with no hint.
11. Copy (message menu, code block, code screen) gives no confirmation (`message_menu.dart:265-268`, `code.dart:213-218`, `code_screen.dart:350-355`).
12. No timestamps or delivery state on bubbles (time only in the list row); a queued ("After") message is not marked queued.
13. Mermaid: one WebView and a serial queue with 20 s timeouts; a slow diagram blocks later ones (`mermaid.dart:120-146`); non-Mermaid failure text is generic with no Retry.
14. Tool result panel capped at 320 dp with its own scroll inside the feed scroll (`chat_screen.dart:844`).
15. Media cards and attachment thumbnails are plain `GestureDetector`s with no semantics label or tooltip (`media_card.dart:188,260`).

Message actions and selection
16. Two parallel selection models: "Select text" re-creates a selection by replaying synthetic pointer events with a timer and up to 30 retry frames (`message_selection.dart:84-113`); intricate and timing-dependent. A second long press inside a selected message is the system's, not the app menu.
17. Reply is absent from the selection toolbar; Reply exists only for the whole message, so quoting a passage needs Comment or manual copy (`message_selection.dart:213-225` vs `message_menu.dart:269-273`).
18. A quick-label tap applies at once, no undo or confirmation; reversible only via strip or pane (long press -> Delete) (`message_menu.dart:165-173`).
19. Comment strip: tap on a chat-message comment does nothing, and its doc comment says long press deletes while it edits (`comment_strip.dart:1-3,87-99`).
20. In code/diff screens Comment is a top-bar icon disabled until selection; in the feed and Markdown files it is in the selection toolbar: different place, and the disabled icon gives no hint (`code_screen.dart:343-349`, `diff_screen.dart:291-295`).
21. The comment sheet accepts an empty comment with no label or clip (`comment_sheet.dart:336-351`).
22. Quick labels are 32 dp circles with the name only as a long-press tooltip; no visible names or other semantic label (`comment_sheet.dart:234-262`).

Composer and voice
23. The draft (text and images) lives in the route and is lost on leaving the chat (`chat_route.dart:58,97`).
24. Attachments are images only; "File" in the attach sheet is still the image picker (spec non-goal, visibly missing).
25. The send-now dialog appears on every send while the agent works; no remembered preference; the default is not highlighted or labelled by consequence.
26. Stop only in the composer while busy, fires without confirmation, 6 dp from the 48 dp Send; a mis-tap interrupts the agent (`composer.dart:349-366`).
27. Hard-coded wrap-detection geometry (`box.maxWidth - 2 - 16 - 4 - 48 - 2`) duplicates the field's paddings; changing padding silently breaks the one-line/wrapped switch (`composer.dart:432-433`).
28. Voice waveform fixed at 143 px regardless of duration or screen; drag-seek imprecise; no speed (`voice_view.dart:83-88,115-130`).
29. Mic requires Whisper on the host; without it every press opens the install sheet (incl. first-time users), no local fallback (design decision #154); a 150 ms hold timer separates tap (hint) from hold.
30. While recording, pane swiping/switching is blocked and back intercepted; backgrounding stops into the preview, but a hold recording does not survive an interruption (call/notification) beyond that handler (`record_button.dart:60-64`).
31. The permission sheet auto-opens over whatever the user is doing (typing, selecting); it offers only Deny/Allow, richer choices only in the feed card (`permission_sheet.dart:67-123,126-192`).
32. Server errors reach `WindowTab.errors` (`ServerEventServerError`) but nothing listens, so the user sees no message (`window_tab.dart:156,171,323-324`).
33. The one-tab overlay covers only the feed; composer and strip stay visible and disabled, "Work here" sits mid-feed (`chat_screen.dart:305`, `one_tab.dart:23-40`).

Files and viewers
34. Markdown file failures have no Retry while code-file and tree failures do (`file_screen.dart:189-194` vs `text_file_screen.dart:89-96`); image and video failures also none (`image_screen.dart:383-392`).
35. Opened files do not refresh when the agent changes them; only tree/Changes/Log reload on turn boundaries.
36. `CodeScreen` computes line height (`size * 1.5`) and char width from a `TextPainter` without the system text scaler and uses a fixed `itemExtent` (`code_screen.dart:227-250`); at large system font, glyphs scale while row extent and gutter do not, so lines can clip or misalign (plausible, not verified on a device).
37. Pinch text scale in code/diff is not persisted, has no reset, and is independent of the system font (`pinch_scale.dart:19-20`).
38. The image viewer has no double-tap zoom and no hint that vertical drag closes (`image_screen.dart:417-435`); markup mode disables zoom and swipe.
39. Changes/Log tabs appear only after an async repo check and stay hidden if it failed (`files_pane.dart:108-115,127`); the strip can pop in after first paint, shifting the tree down 40 dp.
40. No sorting/filter in the Files pane, no recent files beyond "This session" (5), no way to open a file by path except a tool line or the session list.

States and feedback
41. No snackbar has an action (Retry/Undo); transient messages ("send refused", "attach failed") leave no recovery handle except typed text coming back (`composer.dart:79-96`).
42. The only in-chat connection indicator is a muted text strip beneath the header; the header never shows offline/connecting (`chat_screen.dart:206-215`, `chat_header.dart`).
43. Offline host rows are dimmed and non-tappable, so their last chat is unreadable offline (a tab keeps its feed only while its route is open) (`hosts_screen.dart:166-170`).
44. Forget on an unpaired host row is immediate; from Settings it asks (`hosts_screen.dart:75-77` vs `settings_screen.dart:61-81`).
45. No notifications, local or push: a pending permission or finished turn is visible only while the app is open and connected; background pause after 10 minutes (`home.dart:228-236`).
46. Fingerprint confirmation is informational only: no "does not match, cancel" on `ConfirmScreen` (only Done), and the host is already stored when it shows (`confirm_screen.dart:31-52`, `pairing/pair_flow.dart`).
47. No light/dark "follow system" theme; six fixed themes; no in-app text size (`settings_screen.dart:137-160`).

Accessibility and sizing
48. Only two `Semantics` widgets (`chat_header.dart:214`, `record_button.dart:212`); bubbles, agent-turn group, unread badges, status dots, connection state, pane strip and waveform have no custom semantics, no `liveRegion` for new messages or status, no traversal order.
49. Targets under 48 dp: comment badges 18, draft remove 24, quick labels 32, stop/play 40, header back 40, pane tabs 40 tall, code block icons compact (`file_markdown.dart:151-155`, `composer.dart:557-565`, `code.dart:197-218`).
50. Fixed font sizes below 12 px for secondary text: 10.5 px tile labels, 11 px meters/mode/where-labels/badges (`window_sheet.dart:430`, `chat_header.dart:119-123,209-213`, `comments_pane.dart:76`); clamps exist only for the header (1.3x), so the rest can overflow at large scales and header text does not follow the user's largest settings.
51. Hard-coded layout sizes: pane strip 40, header 56, wide threshold 840 (`panes.dart:75,122-125`), image grid and cards (360 max, 16:9, 4:3), waveform 143 px, menu widths 168/220 (`message_selection.dart:208`, `message_menu.dart:255`); wide mode is chosen by width only, regardless of orientation or fold posture.
52. The wide layout (>= 840 dp) shows three panes with no way to hide or resize; at 840 dp the chat pane is ~5/11 of the width (~380 dp), narrower than a phone's chat.
53. The lock screen offers no retry guidance beyond the button, and has no privacy screen in the app switcher (no `FLAG_SECURE` or equivalent under `mobile/app/android/app/src`), so contents show in recents after unlock.

Tests and documentation
54. No TODO/FIXME markers in `mobile/app/lib/` or `mobile/app/test/`, but `docs/guide.md` is behind the app (section 10).
