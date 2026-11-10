# Nota Bene Android app: UX inventory as implemented

Source: `mobile/app` (Flutter, Dart; `mobile/app/lib/` and `mobile/app/test/`), read at the checked-out revision. Intent notes come from
`docs/superpowers/specs/2026-11-09-phone-ux-design.md` and `docs/guide.md` ("Remote access", "The Android app").
All references are `path:line` relative to the repository root. Descriptive except the last section.
Android only (the manifest declares INTERNET, CAMERA, USE_BIOMETRIC, RECORD_AUDIO; no notification permission).

## 1. App structure and navigation

- Entry: `main()` loads the theme choice and language choice from a secure vault before the first frame, builds one hidden WebView for Mermaid, and wraps the whole Navigator in the lock gate (`mobile/app/lib/main.dart:21-42`). `AppRoot` shows a spinner while the identity, hosts and "seen" store load, or one text line if the store is unreadable (`mobile/app/lib/main.dart:74-92`).
- Navigation is plain Material route pushes: Home -> Pair, Settings, Chat (`mobile/app/lib/main.dart:94-128`). No bottom navigation, no drawer, no named routes.
- Locale: the app supports en, ru, zh, es, pt, de; the phone's language is used when supported, otherwise English (`mobile/app/lib/main.dart:134-143`).
- Home (start screen) is a Scaffold with an AppBar titled with the app name, and actions: a QR-scanner icon (only once a host exists) and a settings icon (`mobile/app/lib/home.dart:292-309`).
  - No hosts: centered explanatory text plus a filled "Pair a host" button (`mobile/app/lib/home.dart:310-327`).
  - Otherwise a `HostsList` (below).
- Auto-reopen: at start, once, the last opened chat (`host port root` stored in the hosts store) is pushed automatically if its host is online and still lists that window; while the link is still "connecting" it waits for the first answer (`mobile/app/lib/home.dart:256-278`). This push also fires on later link/host changes until tried once.
- App lifecycle: links are paused 10 minutes after the app is hidden and resumed on show (`mobile/app/lib/home.dart:228-236`).

### Session list (HostsList)

- One group per paired host: a `ListTile` with a 10 px status dot (success colour online; muted when connecting/offline; destructive when unpaired), host label in bold, subtitle with "Connecting...", "Offline", "Offline, seen N ago" or "Unpaired" (`mobile/app/lib/hosts/hosts_screen.dart:55-79`). Unpaired shows a "Forget" text button; no confirmation dialog on this path (`mobile/app/lib/hosts/hosts_screen.dart:75-77`, `mobile/app/lib/home.dart:333`).
- Online host with no windows: muted "no windows" line (`mobile/app/lib/hosts/hosts_screen.dart:81-88`). Offline hosts keep their windows, dimmed to 50% opacity and not tappable (`mobile/app/lib/hosts/hosts_screen.dart:166-170`).
- Session row (`_SessionRow`): 54 px circular avatar with the provider letter (C, X, O or the first letter), an accent dot at its bottom-right while the window works; title (17 px, one line) with the time of the last message on the right (HH:mm today, short weekday within 7 days, else `d.MM`); second line is the folder name in the primary colour followed by the last message text ("You: " prefix for user messages), one line, ellipsis; right-hand badge "!" (accent) when an approval/question is pending, otherwise the unread count in a primary pill (`mobile/app/lib/hosts/hosts_screen.dart:113-306`).
- Tap opens the chat (only when online). Long-press opens a bottom sheet with "Open" (online only) and "Mark read" (`mobile/app/lib/hosts/hosts_screen.dart:129-171`).
- No search, no pinning, no swipe actions, no pull-to-refresh, no section collapse on the session list. Unread is computed on the phone per host and session (`mobile/app/lib/store/seen.dart`), not synced.

### Pairing (QR)

- Entry points: the QR icon in Home's AppBar, the empty-state button, and a "Pair a host" row in Settings (`mobile/app/lib/home.dart:297-322`, `mobile/app/lib/settings_screen.dart:108-112`).
- `PairScreen`: AppBar "pair", a `MobileScanner` camera view filling the body, a bottom block with an error line (when any), a hint ("scan the code from `nota-bene remote pair`") and a "Paste the code instead" text button reading the clipboard (`mobile/app/lib/pairing/scan_screen.dart:64-142`). Busy state replaces the camera with a spinner and "Pairing..." (`mobile/app/lib/pairing/scan_screen.dart:80-90`).
- Errors (inline text, error colour): not a code, code already used, host unreachable; camera denied vs camera failed are distinct messages in the scanner's error builder (`mobile/app/lib/pairing/scan_screen.dart:58-62,102-113`). A `ScanGate` stops the same failed code from re-triggering from the live camera (`mobile/app/lib/pairing/scan_screen.dart:40,96`).
- `ConfirmScreen`: shows host and phone fingerprints (20 px monospace, selectable) with a "compare with what `pair` printed" hint and a full-width "Done" button (`mobile/app/lib/pairing/confirm_screen.dart:31-52`). There is no explicit "they match / they differ" choice; Done is the only action.

### Settings

- One scrolling list (`mobile/app/lib/settings_screen.dart:88-163`): "Paired hosts" header; each host with its relay host name and a "Forget" text button that opens a confirm AlertDialog (`mobile/app/lib/settings_screen.dart:61-81,99-107`); "Pair a host"; the phone's fingerprint (selectable monospace); Language row (opens a modal sheet with a drag handle: "System" plus the six languages by their own names, check mark on the current one, `mobile/app/lib/settings_screen.dart:29-59,124-136`); Theme header with six rows, each a swatch avatar (background + primary dot), the theme's proper name (not translated) and a check mark (`mobile/app/lib/settings_screen.dart:137-160`, `mobile/app/lib/theme.dart:258-291`).
- Themes: Darcula, Plannotator, IntelliJ Light, GitHub Light, Solarized Light, Solarized Dark; default Darcula; no "follow system light/dark" option (`mobile/app/lib/store/theme_choice.dart:15-17`).
- No settings for text size, haptics, notifications, lock timeout, or Whisper (Whisper is managed from the mic sheet).

### Lock screen

- `LockGate` stacks the whole app under an Offstage + TickerMode; while locked the app is not painted, hit-tested or read out (`mobile/app/lib/lock/lock.dart:112-124`). Authenticates immediately on start and after 5 minutes in background using the system BiometricPrompt with device-credential fallback (`mobile/app/lib/lock/lock.dart:22-43,86-93`).
- Locked screen: lock icon 48 px, title, optional "authentication failed" line, a filled "Unlock" button; if the phone has no screen lock, only a "set a screen lock" message and no way in (`mobile/app/lib/lock/lock.dart:126-156`).

## 2. Chat screen

### Structure

- `ChatRoute` owns the window tab (opened on push, closed on pop) and composes `ChatPanes` with header, chat, files and comments (`mobile/app/lib/chat/chat_route.dart:143-182`). It also installs the `PermissionWatcher` (auto-opening permission sheets) and marks replies as seen while the tab is open (`mobile/app/lib/chat/chat_route.dart:75-90`).
- The draft text controller and focus node live in `ChatRoute`, so Reply can write into the draft (`mobile/app/lib/chat/chat_route.dart:104-114`). The draft is disposed on leaving the chat (not persisted).

### Floating header

- Overlay on top of the panes (narrow) or inside the chat pane (wide), 8 dp margins, 40 dp tall (`mobile/app/lib/chat/chat_header.dart:45-47,136-139`).
- Left: a 40 dp round back button (tooltip from MaterialLocalizations, `maybePop`) (`mobile/app/lib/chat/chat_header.dart:142-161`).
- Middle: a stadium pill (popover colour at 92% alpha, 1 px border) with a 28 dp provider-letter avatar, the session title (14 px, one line), and under it a 11 px line with a context-usage meter (22x4 bar + percent, coloured by level: primary, accent at 60%, destructive at 85%) and the agent mode label (accent), when known (`mobile/app/lib/chat/chat_header.dart:59-135,195-250`). The whole pill is one tap target that opens the window sheet (`mobile/app/lib/chat/chat_header.dart:163-171`, `mobile/app/lib/chat/chat_route.dart:151-154`).
- Right: an optional actions pill; no chat passes any, so it never appears (`mobile/app/lib/chat/chat_header.dart:173-187`, `mobile/app/lib/chat/chat_route.dart:151-154`).
- Header text is clamped to 1.3x system text scale (`mobile/app/lib/chat/chat_header.dart:59-61`).
- The header does not show the connection state; that is a separate status bar line in the feed (below).

### Window sheet (tap the header pill)

- Modal bottom sheet, rounded top, scrollable: session title, project path, a model + effort row (opens a second sheet with model list, effort chips and "Apply") or a read-only model name, a permission-mode `SegmentedButton` (shown only with 2 or more modes; labels split onto two lines), a description of the current mode, the plan limits (5 h and week rows with percent, reset time and a 6 px bar), and four tiles: Compact, Clear, Restart, Stats (`mobile/app/lib/chat/window_sheet.dart:57-247`, `mobile/app/lib/chat/controls.dart:39-137`).
- Compact/Clear are disabled while the agent works; Clear has a confirm dialog; Restart has a confirm dialog; Stats pushes the usage screen (`mobile/app/lib/chat/window_sheet.dart:175-243,251-281`, `mobile/app/lib/chat/controls.dart:15-37`). Refusals are explained in a snackbar on the chat's messenger (`mobile/app/lib/chat/window_sheet.dart:183-195`).
- Tiles use 10.5 px labels (`mobile/app/lib/chat/window_sheet.dart:430`).

### Panes and the "Files, Chat, Comments" pill

- Three panes in a row: Files (left), Chat (middle, opened first), Comments (right) (`mobile/app/lib/chat/panes.dart:1-5,15`).
- Narrow (< 840 dp): a `PageView` with `PageScrollPhysics`; a floating pill of three labels under the header (40 dp tall, 8 dp side margins), the current tab a lighter stadium that slides with the swipe position, count badge (accent) on Comments for pending comments; tapping a label animates to the page in 250 ms (`mobile/app/lib/chat/panes.dart:220-306`, `mobile/app/lib/ui/folder_tabs.dart:29-132`). Labels use `FittedBox` scale-down at 14 px.
- Swipe: horizontal drag anywhere on a pane changes pane. It is disabled (NeverScrollable) while a recording is active (`mobile/app/lib/chat/panes.dart:233-239`). A tap on another pane while a recording exists shows the snackbar "finish the recording first" and does not switch (`mobile/app/lib/chat/panes.dart:146-159`).
- Each pane is kept alive (AutomaticKeepAlive via `_Kept`) and has a GlobalKey so state survives the narrow/wide switch (`mobile/app/lib/chat/panes.dart:54-72,115-119`).
- Wide (>= 840 dp, `widePanes`): Files : Chat : Comments side by side at flex 3 : 5 : 3 with vertical dividers; the header moves inside the chat pane; no strip, no swipe, `_current` reset to chat (`mobile/app/lib/chat/panes.dart:75,181-219`).
- Back behaviour (narrow): `PopScope(canPop: current == chat)`. On Files, back first pops one folder in the Files navigator, then goes to Chat; on Comments goes to Chat; on Chat leaves the route (`mobile/app/lib/chat/panes.dart:168-178,223-227`). Wide: back pops a Files folder when deep, else leaves (`mobile/app/lib/chat/panes.dart:205-218`). The header back button calls `maybePop` on the root navigator, not the pane logic (`mobile/app/lib/chat/chat_header.dart:149`), so it leaves the chat from any pane.
- Back priority overlaps: a recording in the composer blocks pop and asks (`mobile/app/lib/chat/composer.dart:330-335,203-237`); the message menu registers a `PopEntry` to close first (`mobile/app/lib/chat/message_menu.dart:58-71,126-135`).

## 3. The feed

### Layout and scrolling

- A reversed `ListView.builder` (newest at the bottom), padding 0 horizontally (bubbles carry their own margins), top padding = status bar + header 56 + strip 40 (`mobile/app/lib/chat/chat_screen.dart:183-196,220-229`). Items are keyed by item id; `findChildIndexCallback` keeps state on insert (`mobile/app/lib/chat/chat_screen.dart:266-293`).
- Because the list is reversed, the view stays pinned to the newest item when the user is at the bottom; if the user scrolled up, new content does not move the view. There is no "jump to bottom" button and no new-messages indicator (no such widget exists in `mobile/app/lib/`).
- A thin 2 px accent linear progress at the bottom of the list while the conversation compacts (`mobile/app/lib/chat/chat_screen.dart:295-304`).
- History: an "Earlier" text button is the last list item (top of the feed) when `feed.earlier > 0`; it loads one archived segment per tap (`mobile/app/lib/chat/chat_screen.dart:245-251`, `mobile/app/lib/chat/feed.dart:139-153,288-317`). No automatic load on reaching the top, no spinner state in the button.
- Programmatic scroll to a message (from the Comments pane): estimate by average item height, jump, then step by 0.8 viewport up to 40 times until the keyed item is built, then `ensureVisible` at alignment 0.3 over 250 ms; a fixed 300 ms delay waits for the pane switch (`mobile/app/lib/chat/chat_screen.dart:122-161`, `mobile/app/lib/chat/chat_route.dart:136-140`). No highlight flash on arrival.
- Status line above the list (muted background, 13 px): "Working..." while the agent is busy, "Connecting...", "Offline" / "Offline, seen N ago", "This window is gone"; the occupied/taken states show nothing here (the overlay covers them) (`mobile/app/lib/chat/chat_screen.dart:206-215,334-346`). Not a banner with action; "Working" has no stop action beside it (Stop lives in the composer).

### User messages

- `UserBubble`: right-aligned, tinted primary, 14 dp corners with a square bottom-right, 1 px primary border at 45% alpha, padding 10x7, outer margins 28 left / 8 right (so up to the screen width minus 36 dp) (`mobile/app/lib/chat/chat_screen.dart:715-745`). No timestamp, no delivery/read status on bubbles.
- Content: images (above text), voice block, or Markdown with soft line breaks (HTML shown as text), then folded sent comments (`mobile/app/lib/chat/chat_screen.dart:560-619`).
- Images: one image as wide as the bubble at 16:9, several in two columns at 4:3; tap opens the swipeable viewer (`mobile/app/lib/chat/media_card.dart:203-237`).
- Voice message: 40 dp round play button, 48-bar waveform (2 px bars, 1 px gaps, fixed width 143 px) that can be tapped or dragged to seek, elapsed/length in 12 px, an "Aa" toggle for the transcript (open by default), and status rows: "Transcribing..." with a pulsing dot, error + Retry, or "Sending..." / send failed with Retry and Delete (`mobile/app/lib/voice/voice_view.dart:47-149`, `mobile/app/lib/voice/voice_bubble.dart:16-192`, `mobile/app/lib/chat/chat_screen.dart:748-767`). No playback speed control.
- Sent comments folded under the bubble: a "N comments" row with a chevron (tap to expand), each showing a left-bar quote, "-> label text", voice clips with their transcripts and attached images (`mobile/app/lib/chat/sent_comments.dart:24-190`). If the comment set is empty but the message text carries the batch, the batch is shown folded instead.

### Agent messages

- The agent's turn is one grouped bubble: pieces (text, tool lines, permission lines, shell blocks) sit under each other without gap; first piece rounds the top corners (14), last piece rounds bottom-right (14) and keeps a 4 dp bottom-left "tail"; margins 8 left / 28 right; colour `agentBubble` (`mobile/app/lib/chat/chat_screen.dart:669-711`).
- Markdown via `flutter_markdown_plus`: GitHub-flavoured, inline and block KaTeX (display math scrolls horizontally, error falls back to source in destructive colour), raw HTML dropped, links open in the external browser only for http/https (`mobile/app/lib/chat/markdown.dart:1-269`). No table-specific scroll handling beyond the library default.
- Code blocks: a card with language label, expand-to-fullscreen and copy icon buttons (compact density, 16 px icons), horizontal scroll for long lines, Darcula-token syntax highlighting; commented passages are painted with their number badges in the bar (`mobile/app/lib/chat/code.dart:145-240`). Copy gives no in-app confirmation.
- Mermaid: rendered by mermaid.js in one hidden 2x2 px WebView, returned as a PNG, one diagram at a time with a 20 s timeout, cached per source/theme/scale; shows a 48 px spinner, Mermaid's own error text, or a generic failure; tap opens a full-screen `InteractiveViewer` (max 8x) (`mobile/app/lib/chat/mermaid.dart:72-298`). A streaming reply re-renders the diagram on each source change.
- Tool calls: one line with status icon (14 px: running dots, check, error), tool name (accent), main argument in monospace (one line, ellipsis); tap toggles the result (disabled while running); result panel is selectable monospace max 320 dp tall; a file-open icon button for project files (Markdown, image, video) (`mobile/app/lib/chat/chat_screen.dart:774-861`). Sub-agent calls are indented 16.
- Media cards under a finished tool line (max 3): 16:9 image (cover) or a play-icon placeholder for a video, with the file name, max width 360, left indent 20; tap opens the viewer or the video screen (`mobile/app/lib/chat/media_card.dart:54-81,242-310`).
- Done line ("Done in 12 s" / interrupted / failed + error), markers (compacted, cleared), permission lines, notices, "idle compact" are centered 13 px muted lines (`mobile/app/lib/chat/chat_screen.dart:552-559,633-664`).
- Shell blocks (`! cmd` + output) in a bordered monospace 12 px container (`mobile/app/lib/chat/chat_screen.dart:651-663`).
- Structured permission/question prompts are answered inline in a card (title, command, optional text fields incl. secret fields, choice buttons wrapped, "settled" state text) (`mobile/app/lib/chat/permission_sheet.dart:194-317`). A plain unanswered permission shows a text button line "Permission asked: tool" in the feed that reopens the sheet (`mobile/app/lib/chat/chat_route.dart:116-133`).
- Streaming: a non-final assistant item grows in place; it is not commentable and has no menu until final (`mobile/app/lib/comments/chat_anchor.dart:14-24`). No typing/progress indicator beyond the "Working..." status line.

## 4. Message actions, selection and comments

### Long-press menu

- Long-press on a user message or a final agent reply (not tool lines, plans, status lines, streaming text) starts `showMessageMenu`; the press position is kept for "Select text" (`mobile/app/lib/chat/chat_screen.dart:464-527`). A haptic `selectionClick` fires on open (`mobile/app/lib/chat/message_menu.dart:86`).
- The menu is an overlay (not a route) above a 60% black scrim: the message "lifted" at its place (long messages scroll inside the lift), a row of quick-label emoji above it and a vertical menu below (`mobile/app/lib/chat/message_menu.dart:279-353`). Tap on the scrim or Android back closes it. It auto-closes if the route under it is no longer current (`mobile/app/lib/chat/message_menu.dart:72-85`).
- Quick labels: the first five (Looks good, Love it!, Clarify this, Verify, Out of scope) in the bar, each a 44 dp emoji chip with the label as a tooltip (long-press); a chevron button toggles all eleven (wrapped rows) (`mobile/app/lib/chat/message_menu.dart:23-34,175-227`, `mobile/app/lib/comments/strings.g.dart` quick-label list). Tapping an emoji immediately adds a whole-message comment with that label and closes the menu, with no text and no confirmation.
- Vertical menu, 220 dp wide, 48 dp rows, in this order: Comment, Select text, Copy, Reply (`mobile/app/lib/chat/message_menu.dart:229-277`). Comment opens the comment sheet on the whole message (quote cut to 200 chars in the sheet only) (`mobile/app/lib/chat/message_menu.dart:94-111`). Copy copies the raw message with no feedback. Reply inserts a Markdown blockquote (`> ` per line + blank line) at the end of the draft and focuses the field (`mobile/app/lib/chat/message_menu.dart:40-42`, `mobile/app/lib/chat/chat_route.dart:104-114`). The "more" chevron applies only to the emoji bar. No delete/edit/resend/forward/share on messages.

### Text selection

- "Select text" swaps the item for `SelectableMessage`: a Flutter `SelectionArea` where all text is selected, then the word under the original press is re-selected by replaying a synthetic pointer down/up with a long-press timer (`mobile/app/lib/chat/message_selection.dart:80-113`). It ends on a tap outside (`TapRegion`) or after a comment is made (`mobile/app/lib/chat/message_selection.dart:233-248`).
- Custom toolbar replaces Flutter's: a 168 dp vertical card with three 44 dp rows: Comment, Copy, Select all (`mobile/app/lib/chat/message_selection.dart:172-231`). No Reply, no quick labels, no Share, no Look up in this toolbar.
- Comment from a selection: locates the selection in the rendered text; if it cannot be placed, snackbar "comment not placed"; otherwise opens the comment sheet with the quote and adds the comment (`mobile/app/lib/chat/message_selection.dart:147-170`).

### Comment sheet

- Modal bottom sheet with drag handle, scrollable, keyboard-aware (`mobile/app/lib/comments/comment_sheet.dart:39-49,200-208`). Content top to bottom: a quote (max 4 lines, accent left bar); a horizontally scrolling row of 11 quick-label emoji, 32 dp circles, selected one outlined in accent, name only as a tooltip; voice clips (each a voice block with a delete icon); a 2-8 line text field (hint, autofocus when creating); a mic button (only when the window speaks protocol 14+) that records clips (max 10) and shows a recording row in place of the field; Delete (when editing), Cancel, Save (`mobile/app/lib/comments/comment_sheet.dart:213-360`).
- Save is disabled while a clip is transcribing or failed or a recording is active; while busy it shows a spinner (`mobile/app/lib/comments/comment_sheet.dart:336-358`). Saved comment may be text, label, clips or any combination; an empty comment with no label is allowed (no validation).
- The sheet carries its own `ScaffoldMessenger` so snackbars (mic denied) show above it (`mobile/app/lib/comments/comment_sheet.dart:365-382`).

### Pending comments: strip and Comments pane

- Comment strip above the composer: a card (max 132 dp) titled "N comments pending" with one row per comment (one line each: quote in muted, then label, text and clip transcripts). Tap opens the file for file/media comments (video at its time); chat comments do nothing on tap; long-press opens the edit sheet (with Delete) (`mobile/app/lib/comments/comment_strip.dart:30-118`). The file header comment says "long press offers to delete it" but it opens the edit sheet.
- In the feed, pending comments are painted: passages highlighted with an accent badge of their strip number, whole-message comments as a badge at the message's top-right; tapping a badge opens the edit sheet (`mobile/app/lib/chat/chat_screen.dart:349-462`, `mobile/app/lib/files/file_markdown.dart:136-160`).
- Comments pane (right pane): empty state text "no comments yet"; "N pending" heading with a filled Send button (enabled when the tab is open and comments are sendable); pending rows (where-label 11 px, quote 2 lines, "-> body" 4 lines); a collapsible "Sent - N" heading (collapsed by default) listing sent comments grouped by the message they went with (first line of that message as group name, newest first) (`mobile/app/lib/comments/comments_pane.dart:123-238`). Tap a row goes to its place: chat message (switch to Chat, scroll), file (open full screen), media (open at time); long-press edits a pending comment; sent comments are read-only (`mobile/app/lib/comments/comments_pane.dart:45-66`).
- Sending: the composer's Send includes pending comments in the same batch text as the desktop; Send is enabled with comments alone (`mobile/app/lib/chat/composer.dart:239-293`, `mobile/app/lib/chat/send_now.dart:36-92`). A refused send returns text, comments and images to their places with a snackbar (`mobile/app/lib/chat/composer.dart:79-96`).

## 5. Composer

- Layout: bottom of the chat column, under the comment strip: optional horizontal strip of 60 dp image drafts, then a row with a rounded field (22 dp radius, min height 48, up to 6 lines) and a 48 dp round action button; padding 8,4,8,8 (`mobile/app/lib/chat/composer.dart:336-411,415-498`).
- Field: placeholder "Message"; disabled with placeholder "cannot send" when the tab is not open (offline, occupied, taken, gone, connecting) (`mobile/app/lib/chat/composer.dart:441-462`). The paperclip sits to the right of the field and moves to the top-right corner once text wraps to 2+ lines (width measured with a `TextPainter` using hard-coded paddings) (`mobile/app/lib/chat/composer.dart:295-312,431-440,471-485`).
- Action button: animated swap (180 ms scale/fade) between mic (when the window speaks protocol 14+ and there is nothing to send, or while recording) and Send (circular, primary when sendable, muted otherwise; spinner while an image uploads) (`mobile/app/lib/chat/composer.dart:328-405`). Send enter key: field uses default multiline keyboard action; no "send on Enter" setting.
- Stop: a red 40 dp round button to the left of the action button while the agent works; sends interrupt immediately, no confirmation (`mobile/app/lib/chat/composer.dart:349-366`).
- Queue "now or after": when the agent is busy, Send (and the Comments pane's Send, and a voice send) opens an AlertDialog "Send now or after this turn?" with Cancel, "After" (queue) and "Now" (interrupt, `force`) (`mobile/app/lib/chat/send_now.dart:11-32`, `mobile/app/lib/chat/composer.dart:248-253`). Dismissing keeps the text.
- Attachments: paperclip opens a bottom sheet with Camera, Gallery, File (system picker via native code, images only) (`mobile/app/lib/chat/attach_sheet.dart:7-31`). Each image is prepared in an isolate one at a time and uploaded in the background; the thumbnail has a spinner while pending, a red frame and error icon on failure, and a 24 dp remove cross at its corner; Send waits for uploads and is blocked while one failed (`mobile/app/lib/chat/composer.dart:129-173,500-579`). Errors (denied, busy, unavailable, too large, unsupported) are snackbars (`mobile/app/lib/chat/composer.dart:98-127`).
- Mic (`RecordButton`): Telegram-style. Pointer-down starts a 150 ms timer; hold to record, a 96 dp circle with a halo that swells with input level follows the finger; slide left 96 dp to cancel, up 80 dp to lock (lock indicator floats above), release to send; a short tap shows a 2 s hint tooltip; locked mode turns the button into Send with a 40 dp Stop above it (`mobile/app/lib/voice/record_button.dart:1-5,135-226,229-347`, `mobile/app/lib/voice/record_session.dart:30-36`).
- Recording row replaces the field: blinking red dot, `m:ss,t` timer (accent after 9:50), "< Slide to cancel" that follows the finger and fades; locked: a CANCEL text button; preview (after Stop): trash icon and a player (`mobile/app/lib/voice/record_row.dart:17-138`). Minimum length 500 ms; maximum 10 minutes (warning at 9:50) (`mobile/app/lib/voice/record_session.dart:30-36`).
- Accessibility path for the mic: Semantics button with label; TalkBack tap starts a locked recording (`mobile/app/lib/voice/record_button.dart:212-220`).
- Hold gesture interplay: while recording, pane swiping is disabled and leaving panes is refused with a snackbar; back (or any pop) stops into the preview and asks "send / delete / cancel" in a dialog; going to background with a locked recording stops it into the preview (`mobile/app/lib/chat/panes.dart:146-159,233-239`, `mobile/app/lib/chat/composer.dart:202-237`, `mobile/app/lib/voice/record_button.dart:60-64`). Voice sends outlive the chat through an outbox keyed by host and session (`mobile/app/lib/chat/window_tab.dart:99-103`).
- Whisper prompt: when the window lacks Whisper, a press on the mic opens a bottom sheet that asks about installing (download and disk sizes, folder), runs the install on the host, polls every 2 s, turns it on and shows a "Whisper is on" snackbar through the pre-captured messenger (`mobile/app/lib/dictation/whisper_sheet.dart:1-228`). Steps: asking, absent, failed, installing, off, no answer.
- Permission sheet: auto-opens as a modal bottom sheet when a plain permission is asked and the tab is open: title "Allow <tool>?", the whole command in a selectable monospace box (max 50% height), Deny (outlined) and Allow (filled) buttons; closes itself when answered elsewhere; swiping it away leaves the feed line that reopens it (`mobile/app/lib/chat/permission_sheet.dart:53-192`). The plain sheet has only Deny/Allow (the structured prompt card carries "for this session" style choices).
- One-tab overlay: when another tab owns the window (occupied) or took it (taken), a 92% background scrim covers the feed (not the header, comments strip or composer), with a centered message and a "Work here" button that takes the window over (`mobile/app/lib/chat/one_tab.dart:9-42`, `mobile/app/lib/chat/window_tab.dart:280-286`). Takeover re-sends on the occupied event when wanted.

## 6. Files pane (left pane)

- A nested `Navigator` inside the pane, so folders are pages of the pane and Android back goes up a folder first (`mobile/app/lib/files/files_pane.dart:50-76`). The pane keeps its own top inset under the floating header and strip.
- First page: when the host is a git repository, a 40 dp row of tabs Files / Changes / Log (underline style, tap only, no swipe between them) over an `IndexedStack`; otherwise only the tree, no tabs (`mobile/app/lib/files/files_pane.dart:117-149`).
- Tree (`FolderPage`): a folder title row (path tail up to 34 chars; an up arrow on sub-folders), a search field (rounded, debounce 250 ms, asks the host's fuzzy search; clear icon), then at the root a "This session" block of files the agent touched (first 5, "Show all N"), then entries, folders first (`mobile/app/lib/files/files_pane.dart:21-25,293-410,412-481`). Rows are `dense` ListTiles with an icon (image/video/markdown/code/plain), one-line name and, in the session block and search results, the parent folder as subtitle. Errors: inline message with Retry; loading spinner; "folder empty"; "no matches".
- No long-press, rename, delete, create or share on files; no pull-to-refresh on the tree; opening is read-only.
- Opening a file: pushes on the root navigator, full screen over the whole chat (`mobile/app/lib/chat/files.dart:87-99`): Markdown -> `FileScreen`; png/jpg/gif/webp/bmp -> `ImageScreen`; mp4/mov/webm/m4v -> `VideoScreen`; anything else -> `TextFileScreen` (code viewer).
- Changes tab: working-tree changed files with status letter (colour-coded), name over folder, +/- line counts; pull-to-refresh; reloads on turn boundaries; empty/no-repo/failed messages (`mobile/app/lib/files/git_pages.dart:33-215`). Log tab: commits (subject 2 lines, short hash and meta), pull-to-refresh, last row says the log was cut at N when more exist (no load-more); a commit opens `CommitPage` with its files; a file opens `DiffScreen` (`mobile/app/lib/files/git_pages.dart:224-453`).

### Viewers

- Markdown file (`FileScreen`): AppBar with file name; `SelectionArea` over `FileMarkdown` in a padded ListView; limit 2 MiB; selection toolbar prepends "Comment" to the system items; commented passages highlighted, tap opens edit/delete; fail states are plain centered text without Retry (`mobile/app/lib/files/file_screen.dart:35-230`).
- Code file (`TextFileScreen` -> `CodeScreen`): full-screen on the code background, a bar with close icon, file name (or language), line count, a Comment icon (disabled until text is selected) and a Copy icon; lines are a fixed-height `ListView.builder` (13 px x 1.5) under a horizontal scroll sized to the longest line (no wrapping), with a line-number gutter; pinch changes the text scale 0.5x to 3x (`PinchScale` only watches pointers, scale resets on reopen); highlighting is skipped for files over 200 kB and for lines over 2000 chars; binary/too-large files show a message with size; error shows Retry (`mobile/app/lib/chat/code_screen.dart:45-377`, `mobile/app/lib/ui/pinch_scale.dart`, `mobile/app/lib/files/text_file_screen.dart:11-123`). The same screen is used for a chat code block (expand button), where a selection becomes a comment on the message, and for files, where it becomes a file comment. Comment is in the top bar, not in the selection toolbar (differs from the Markdown file and message flows).
- Diff (`DiffScreen`): unified diff full screen: old/new line-number gutters, tinted added/removed rows, hunk heads, pinch text scale, both-way pan, selectable, Copy and Comment icons in the bar (Comment disabled until selection); diffs over 3000 rows wait for "Show anyway"; per-line highlighting only up to 1500 rows (`mobile/app/lib/files/diff_screen.dart:1-30,235-330`). Comments anchor to file path (plus commit short hash for a commit's diff) and the code-row text without markers or numbers.
- Image viewer (`ImageScreen`): black screen, AppBar with name and "n / N", horizontal `PageView` across the message's images, `InteractiveViewer` pinch zoom up to 8x (pan only when zoomed; no double-tap zoom), vertical drag at scale 1 carries the picture and closes it past 120 px or a fast fling; bottom actions: Mark up, Comment, Share (Share only for attachments); markup toolbar with rect/ellipse/pen/arrow, five colours, undo, Comment, stop; saving a media comment uploads the marked frame first (`mobile/app/lib/files/image_screen.dart:122-437`, `mobile/app/lib/media/markup.dart:192-282`). Failure shows text only, no Retry.
- Video viewer: `VideoPlayer` via a local proxy over the channel, play/pause, a seek slider with ticks for existing media comments (tap a tick to seek), mark-up/comment on the frame at the playhead; failed state message (`mobile/app/lib/files/video_screen.dart:22-346`).
- Usage/Stats screen: provider and period chips, bars, model mix, limits, per-task detail (`mobile/app/lib/usage/usage_screen.dart`), reached from the window sheet.

## 7. States: connection, empty, loading, errors

- Link states per host: connecting, online, offline, unpaired. Reconnect with exponential backoff 1 s to 30 s with +/-20% jitter; unpaired when the relay replies 4403 (`mobile/app/lib/hosts/host_link.dart:1-3,12,100-160`).
- Tab states: connecting, open, occupied, taken, gone, offline (`mobile/app/lib/chat/window_tab.dart:22`). A closed window socket under a live link retries after 1 s; a link drop sets offline and keeps the feed readable until the next replay replaces it (`mobile/app/lib/chat/window_tab.dart:185-264`).
- In the chat: the status line (see section 3), composer disabled with "cannot send", the one-tab overlay, the permission sheet closing when the window goes away and reopening when back (`mobile/app/lib/chat/permission_sheet.dart:67-91`).
- Snackbars (default Material, on the nearest messenger): send refused (busy/switching), attach errors, mic denied/failed, finish-recording-first, comment-not-placed, share failed, frame failed, mark-save failed, compact/clear refusal, Whisper ready (`mobile/app/lib/chat/composer.dart:79-127`, `mobile/app/lib/chat/panes.dart:149-158`, `mobile/app/lib/chat/message_selection.dart:147-156`, `mobile/app/lib/chat/window_sheet.dart:183-195`, `mobile/app/lib/dictation/whisper_sheet.dart:151-156`). None has an action button.
- Dialogs: send-now, restart, clear, forget host, leave-while-recording (`mobile/app/lib/chat/send_now.dart`, `mobile/app/lib/chat/controls.dart:15-37`, `mobile/app/lib/chat/window_sheet.dart:251-281`, `mobile/app/lib/settings_screen.dart:61-81`, `mobile/app/lib/chat/composer.dart:203-237`).
- Loading: centered `CircularProgressIndicator` for app start, files, images, file reads; skeletons are not used anywhere.
- Empty states: no hosts (CTA), no windows, empty folder, no matches, no comments, no changes, no commits, no repo (`mobile/app/lib/home.dart:310-327`, `mobile/app/lib/hosts/hosts_screen.dart:81-88`, `mobile/app/lib/files/files_pane.dart:349-353,387-391`, `mobile/app/lib/comments/comments_pane.dart:142-149`, `mobile/app/lib/files/git_pages.dart:167,191,296`). The chat feed itself has no empty state when a session has no messages.
- Haptics: only message-menu open and the three recording events (`mobile/app/lib/chat/message_menu.dart:86`, `mobile/app/lib/voice/record_session.dart:88,136,139`).
- No push or local notifications (spec lists push as a non-goal: `docs/superpowers/specs/2026-11-09-phone-ux-design.md`, Non-goals). Background connections pause 10 minutes after the app is hidden (`mobile/app/lib/home.dart:228-236`).

## 8. Accessibility

- Explicit `Semantics` appears in only two places: the header meters (`mobile/app/lib/chat/chat_header.dart:214-217`, label "ctx NN%") and the mic button (`mobile/app/lib/voice/record_button.dart:212-220`). No `semanticLabel`, `liveRegion`, `MergeSemantics` or `sortKey` anywhere in `mobile/app/lib/`.
- Most icon buttons carry tooltips (which Material turns into semantics labels): back, expand, copy, send, stop, attach, folder up, comment, markup tools, voice play/pause. Gaps: the Files search clear button (`mobile/app/lib/files/files_pane.dart:463-469`), the Home settings/pair icons have tooltips (`mobile/app/lib/home.dart:297-307`), but custom `GestureDetector`/`InkWell` targets have none (see weak points).
- Text scale: only the header is clamped (1.3x, `mobile/app/lib/chat/chat_header.dart:59-61`); the composer's wrap measurement honours the system scaler (`mobile/app/lib/chat/composer.dart:307`). Everything else follows the system scale unclamped. The manifest lists `fontScale` in `configChanges`, so the activity is not recreated on font change.
- Touch targets: Material defaults (48 dp) for IconButtons; explicit smaller targets: voice record stop 40 dp, play button 40 dp, header back 40 dp, composer stop 40 dp (shrinkWrap tap target), draft remove cross 24 dp, comment badge 18 dp, 32 dp quick-label circles in the sheet, code block icon buttons compact density, tool-line file icon compact (`mobile/app/lib/voice/record_button.dart:306-309`, `mobile/app/lib/voice/voice_view.dart:96`, `mobile/app/lib/chat/composer.dart:353-362,557-565`, `mobile/app/lib/files/file_markdown.dart:151-155`, `mobile/app/lib/comments/comment_sheet.dart:240-244`).
- Colour is the only distinction for some states: connection dot colour (offline vs connecting are both muted, differ by text), meter levels, failed draft red frame (also an icon).
- Tests (`mobile/app/test/`) cover meter semantics and the mic, not general screen-reader traversal.

## 9. Localization

- Six languages: en, ru, zh (zh-CN), es, pt (pt-BR), de, defined by shared `UI_LANGS`; a test enforces that the `.arb` language set equals `UI_LANGS` and that every language has the same keys as English (`mobile/app/test/l10n_test.dart:11-37`). Currently 204 keys per language (`mobile/app/lib/l10n/app_*.arb`).
- Two string sources: app-owned ARB strings through generated `AppLocalizations`, and web-owned strings generated into `mobile/app/lib/comments/strings.g.dart` (quick labels, `webString`, `webCount`, batch templates, "ctx", Changes/empty/failed texts, mode names/descriptions, clear confirm texts) - header "GENERATED by npm run gen:protocol from web/src/comments/labels.ts and web/src/i18n" (`mobile/app/lib/comments/strings.g.dart:1,40-60`). `mobile/app/lib/usage/format.dart`/usage screen use `usageString` similarly.
- Language: "System" (follow phone) or explicit; stored in the vault; the live app locale changes immediately (`mobile/app/lib/store/lang_choice.dart`, `mobile/app/lib/main.dart:165-176`). Date formats use `intl` with the language (`mobile/app/lib/hosts/hosts_screen.dart:24-31`). Theme names are not translated (`mobile/app/lib/theme.dart:285-287`). The Whisper sheet text comes partly from web strings (`mobile/app/lib/dictation/whisper_sheet.dart:9`).
- Relative time ("N min ago") is composed per language by ARB plurals (`mobile/app/lib/hosts/hosts_screen.dart:16-21`).

## 10. Docs drift worth knowing

- `docs/guide.md` ("The Android app (prototype)") still describes an "agent menu" with Compact/Model/Restart and says comments on chat messages, images and video, usage statistics and dictation are "not yet"; the code has the window sheet, chat/image/video comments, a stats screen and voice with Whisper.

## 11. Observed weak points

Concrete issues visible in the code; each is a candidate for the gap analysis, not a verdict.

Navigation and gestures
1. Horizontal pane swipe competes with inner horizontal scrollers: code blocks (`mobile/app/lib/chat/code.dart:221-223`), display math (`mobile/app/lib/chat/markdown.dart:112-115`), the comment-sheet label row (sheet, not a pane), the draft strip, the voice waveform drag (`mobile/app/lib/voice/voice_view.dart:115-118`). The page view takes over when the inner scroller reaches its edge; no edge guard, and no way to swipe a pane from over a long code block except at the very edge.
2. Files/Changes/Log tabs inside the Files pane switch by tap only (`mobile/app/lib/files/files_pane.dart:130-134`), while the outer panes switch by swipe: two tab strips with different gesture rules; a swipe on Files goes to the Chat pane, not the next sub-tab.
3. Back is inconsistent: the header back button leaves the chat from any pane (`mobile/app/lib/chat/chat_header.dart:149`) while the system back goes pane-by-pane (`mobile/app/lib/chat/panes.dart:168-178`).
4. Pane switching blocked by a recording shows only a snackbar and no way to act on it from there; the user must go back to the composer to finish or delete first (`mobile/app/lib/chat/panes.dart:149-158`).
5. Opening a file from any pane pushes over the root navigator and hides the header/pill; no way back to the same sub-tab other than back (works, but no breadcrumb); search and folder state are page-local and are lost on pane rebuild only if the pane is disposed (kept alive, so fine).
6. Auto-reopen of the last chat (`mobile/app/lib/home.dart:256-278`) puts the user in a chat without a visible transition from the list; Back from it lands on the list. No setting to disable it.

Feed
7. No jump-to-bottom control and no "new messages" indicator when scrolled up (no such code in `mobile/app/lib/`); returning to the newest message is manual scrolling only.
8. Older history is a manual "Earlier" text button at the top, one archived segment per tap, with no loading state (`mobile/app/lib/chat/chat_screen.dart:245-251`).
9. Scroll-to-message from the Comments pane uses a fixed 300 ms delay and iterative jumps (up to 40 frames); it can fail silently (returns false, nothing shown) and gives no highlight on arrival (`mobile/app/lib/chat/chat_route.dart:136-140`, `mobile/app/lib/chat/chat_screen.dart:122-161`).
10. Tool lines, plans, status lines and streaming text are not long-press targets (`mobile/app/lib/comments/chat_anchor.dart:14-24`); the spec says plans and tool panels are commentable ("Commentable items" in the phone UX spec), the code does not implement it. A long press on a tool line does nothing and gives no hint.
11. Copy (message menu, code block, code screen) gives no in-app confirmation (`mobile/app/lib/chat/message_menu.dart:265-268`, `mobile/app/lib/chat/code.dart:213-218`, `mobile/app/lib/chat/code_screen.dart:350-355`).
12. Bubbles have no timestamps and no delivery state; time of a message exists only in the list row. A queued ("After") message is not marked as queued in the feed.
13. Mermaid diagrams: all diagrams share one WebView and a serial queue with 20 s timeouts; a slow one blocks later ones (`mobile/app/lib/chat/mermaid.dart:120-146`). Failure text for non-Mermaid errors is generic with no Retry.
14. Tool result panel is capped at 320 dp with its own scroll inside the feed's scroll (nested vertical scrolling) (`mobile/app/lib/chat/chat_screen.dart:844`).
15. Media cards and attachment thumbnails are plain `GestureDetector`s with no semantics label or tooltip (`mobile/app/lib/chat/media_card.dart:188,260`).

Message actions and selection
16. Two parallel selection models: "Select text" re-creates a selection by replaying synthetic pointer events with a timer and up to 30 retry frames (`mobile/app/lib/chat/message_selection.dart:84-113`); it is intricate and timing-dependent. A second long press inside a selected message is the system's, not the app menu.
17. Reply from the selection toolbar is absent; Reply exists only for the whole message in the menu, so quoting a passage needs Comment or manual copy (`mobile/app/lib/chat/message_selection.dart:213-225` vs `mobile/app/lib/chat/message_menu.dart:269-273`).
18. Quick-label tap in the menu applies at once with no undo and no confirmation; an accidental tap is reversible only via the strip or pane (long-press -> Delete) (`mobile/app/lib/chat/message_menu.dart:165-173`).
19. Comment strip: tap on a chat-message comment does nothing (only file/media comments open), and its doc comment says long-press deletes while it opens the editor (`mobile/app/lib/comments/comment_strip.dart:1-3,87-99`).
20. In code/diff screens the Comment action is a top-bar icon that is disabled until a selection exists, while in the feed and Markdown files it is in the selection toolbar: a different place for the same action, and the disabled icon gives no hint about selecting first (`mobile/app/lib/chat/code_screen.dart:343-349`, `mobile/app/lib/files/diff_screen.dart:291-295`).
21. The comment sheet accepts an empty comment with no label and no clip (`mobile/app/lib/comments/comment_sheet.dart:336-351`); no validation or hint.
22. Comment sheet quick labels are 32 dp circles with the name only as a long-press tooltip; no visible names, and no semantic label other than the tooltip (`mobile/app/lib/comments/comment_sheet.dart:234-262`).

Composer and voice
23. Composer draft (text and image drafts) lives in the route and is lost when the chat is left (`mobile/app/lib/chat/chat_route.dart:58,97`); no draft restore.
24. Attachments are images only; no documents, audio files or video (spec non-goal, but visible as a missing path); "File" in the attach sheet is still the image picker.
25. Send-now dialog appears on every send while the agent works (text, voice, pane Send); there is no remembered preference, and the default action is neither highlighted by position nor labelled with its consequence beyond the title.
26. Stop is only in the composer while busy, and fires without confirmation, directly adjacent (6 dp gap, 40 dp) to the 48 dp Send button; a mis-tap interrupts the agent (`mobile/app/lib/chat/composer.dart:349-366`).
27. Hard-coded geometry in the composer's wrap detection (`box.maxWidth - 2 - 16 - 4 - 48 - 2`) duplicates paddings of the field; a change to padding silently breaks the one-line/wrapped switch (`mobile/app/lib/chat/composer.dart:432-433`).
28. Voice message waveform is a fixed 143 px wide regardless of duration or screen; seeking by drag on a 143 px strip is imprecise; no playback speed (`mobile/app/lib/voice/voice_view.dart:83-88,115-130`).
29. Mic press requires Whisper on the host; without it every press opens the install sheet (incl. first-time users), with no local fallback (design decision #154), and a very small hold timer (150 ms) separates tap (hint) from hold.
30. While recording, pane swiping and pane switching are blocked and back is intercepted with a dialog; a recording that continues in the background is stopped (preview) on hide, but a hold recording does not survive an interruption (call/notification) beyond that handler (`mobile/app/lib/voice/record_button.dart:60-64`).
31. Permission sheet auto-opens over whatever the user is doing (typing, selecting) when a permission arrives; the sheet is the only quick answer with just Deny/Allow, while richer choices ("for this session") exist only in the in-feed card (`mobile/app/lib/chat/permission_sheet.dart:67-123,126-192`).
32. Server errors are received (`ServerEventServerError` -> `WindowTab.errors` stream) but nothing in `mobile/app/lib/` listens to the stream, so the user sees no message for them (`mobile/app/lib/chat/window_tab.dart:156,171,323-324`).
33. The One-tab overlay covers only the feed; the composer and comment strip stay visible and disabled, with the "Work here" button positioned in the middle of the feed (`mobile/app/lib/chat/chat_screen.dart:305`, `mobile/app/lib/chat/one_tab.dart:23-40`).

Files and viewers
34. Markdown file failures have no Retry while code-file and tree failures do (`mobile/app/lib/files/file_screen.dart:189-194` vs `mobile/app/lib/files/text_file_screen.dart:89-96`); image and video failures also have none (`mobile/app/lib/files/image_screen.dart:383-392`).
35. Opened files do not refresh when the agent changes them while the viewer is open; only the tree/Changes/Log reload on turn boundaries.
36. `CodeScreen` computes line height (`size * 1.5`) and character width from a `TextPainter` without the system text scaler and uses a fixed `itemExtent` (`mobile/app/lib/chat/code_screen.dart:227-250`); with a large system font the glyphs are scaled by Flutter while the row extent and gutter are not, so lines can clip or misalign (plausible, not verified on a device).
37. Pinch text scale in code/diff is not persisted and has no reset; it is also independent of the system font setting (`mobile/app/lib/ui/pinch_scale.dart:19-20`).
38. Image viewer has no double-tap zoom and no hint that vertical drag closes (`mobile/app/lib/files/image_screen.dart:417-435`); markup mode disables zoom and swipe.
39. Files tab "Changes/Log" appear only after an async repo check and silently stay hidden if it failed (`mobile/app/lib/files/files_pane.dart:108-115,127`); the tab strip can pop in after first paint, shifting the tree down by 40 dp.
40. Files pane has no sorting/filter options, no recent files other than "This session" (5 items), and no way to open a file by path from the chat other than a tool line or the session list.

States and feedback
41. Snackbars have no action (Retry/Undo) anywhere; transient messages (e.g. "send refused", "attach failed") disappear with no recovery handle except typed text coming back (`mobile/app/lib/chat/composer.dart:79-96`).
42. The only app-wide connection indicator in the chat is a muted text strip that scrolls with the layout beneath the header; the header itself never shows offline/connecting; state is not conveyed in the header pill (`mobile/app/lib/chat/chat_screen.dart:206-215`, `mobile/app/lib/chat/chat_header.dart`).
43. Offline host rows are dimmed to 50% and non-tappable, so their last chat is not readable offline although the tab keeps its feed only while the route is already open (`mobile/app/lib/hosts/hosts_screen.dart:166-170`).
44. Forget on an unpaired host row is immediate with no confirmation, while Forget from Settings asks (`mobile/app/lib/hosts/hosts_screen.dart:75-77` vs `mobile/app/lib/settings_screen.dart:61-81`).
45. No notifications at all (local or push): a pending permission or a finished turn is visible only while the app is open and connected; background pause after 10 minutes (`mobile/app/lib/home.dart:228-236`).
46. Pairing fingerprint confirmation is informational only; there is no "does not match, cancel" path on `ConfirmScreen` (only Done) and the host is already stored when the screen shows (`mobile/app/lib/pairing/confirm_screen.dart:31-52`, `mobile/app/lib/pairing/pair_flow.dart`).
47. No light/dark "follow system" theme option; six fixed themes, and the user cannot change the text size within the app (`mobile/app/lib/settings_screen.dart:137-160`).

Accessibility and sizing
48. Only two `Semantics` widgets exist in the app (`mobile/app/lib/chat/chat_header.dart:214`, `mobile/app/lib/voice/record_button.dart:212`); message bubbles, the agent-turn group, unread badges, status dots, connection state, the pane strip and waveform have no custom semantics, no `liveRegion` for new messages or status changes, and no semantic traversal order.
49. Several touch targets under 48 dp: comment number badges 18 dp (`mobile/app/lib/files/file_markdown.dart:151-155`), draft remove 24 dp (`mobile/app/lib/chat/composer.dart:557-565`), quick labels in the sheet 32 dp, stop/play 40 dp, header back 40 dp, pane tabs 40 dp tall, code block action icons in compact density (`mobile/app/lib/chat/code.dart:197-218`).
50. Fixed font sizes below 12 px for secondary text: 10.5 px tile labels, 11 px meters/mode/where-labels, 11 px badges (`mobile/app/lib/chat/window_sheet.dart:430`, `mobile/app/lib/chat/chat_header.dart:119-123,209-213`, `mobile/app/lib/comments/comments_pane.dart:76`); text-scale clamps exist only for the header (1.3x), so the rest can overflow at large scales, and the header clamp means header text does not follow the user's largest settings.
51. Hard-coded sizes in layout: pane strip height 40, header 56, wide threshold 840 (`mobile/app/lib/chat/panes.dart:75,122-125`), image grid and cards (360 max width, 16:9, 4:3), waveform 143 px, 168/220 dp menu widths (`mobile/app/lib/chat/message_selection.dart:208`, `mobile/app/lib/chat/message_menu.dart:255`); the wide mode is chosen by width only, regardless of orientation or foldable posture.
52. Wide layout (>= 840 dp) shows the three panes with no way to hide or resize any; at 840 dp the chat pane is ~5/11 of the width (about 380 dp), narrower than a phone's chat.
53. The lock screen has no "unlock" until a failed attempt is dismissed; no biometric prompt retry guidance beyond the button, and the dialog's text is localized but the lock gate has no privacy screen in the app switcher (no `FLAG_SECURE` or equivalent anywhere under `mobile/app/android/app/src`, so the app contents show in the recents screen after unlock).

Tests and documentation
54. No TODO/FIXME markers exist in `mobile/app/lib/` or `mobile/app/test/` (grep), but `docs/guide.md` is behind the app (section 10).
