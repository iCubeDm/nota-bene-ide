# Text selection, quoting and annotation of fragments on mobile (Android first, iOS comparison)

Research date: 2026-11-10. Evidence quality varies; each bullet says whether the source is primary (docs, vendor, issue tracker) or secondary (forum, press, third-party). Searches returned summarised snippets in several cases; where I could not open a page myself I say so.

## 1. Default-selectable text vs long-press message menu: what apps do, and how conflicts are resolved

### Takeaway
Chat apps mostly put whole-message actions behind long-press, and partial selection is a second step inside that menu or flow (Telegram, WhatsApp, Slack). Reading and annotation apps (Kindle, Readwise Reader, Hypothesis) make text itself selectable and turn the selection into a highlight or note. I found no primary source that documents how ChatGPT, Claude or Gemini mobile apps resolve this; for Claude the only evidence is user complaints that selection is not possible, so this is a known pain point in the AI-chat category.

### Cited Findings
- Telegram (official blog, Oct 2023, "Replies 2.0"): to quote part of a message, tap the message (on iOS press and hold), hold and drag to select the text, choose "Quote", write the reply. Tapping the quote later jumps with an animation to the exact place in the original message. So selection is reached via the message-level tap/long-press, then a drag, and the selection toolbar carries a "Quote" action. — [Telegram blog](https://telegram.org/blog/reply-revolution)
- Telegram quote formatting is separate: quote formatting can be applied to any text in your own reply, several quotes per reply. The post does not describe the visual layout of a quote in the chat. — [Telegram blog](https://telegram.org/blog/reply-revolution)
- Telegram's bug tracker shows a long-standing "partial reply" request; one commenter describes the older flow "long-press message, select text, tap reply, selection appears as a quote above the input". User reports, not official. — [Telegram bug tracker thread](https://bugs.telegram.org/c/1050/39) (snippet seen via search only)
- WhatsApp: partial text selection and copy is live on iOS (press and hold a message, drag to select a part). On Android it was in development as of the beta 2.25.18.3 (mid 2025) and tied to WhatsApp's redesigned message context menu, which the selection tool depends on. I could not confirm whether it has since shipped on Android. — [WABetaInfo](https://wabetainfo.com/whatsapp-beta-for-android-2-25-18-3-whats-new/); iOS rollout: [Digit](https://www.digit.in/news/apps/whatsapp-for-ios-finally-lets-you-copy-just-part-of-message-heres-how-it-works.html/amp/)
- Slack mobile: Slack's own tips say tap-and-hold on a message opens the action menu (reactions, thread, share, mark unread, save, copy link, edit). The tips do not mention partial text selection; I could not confirm it from a primary source. A forum post about another bot app assumes iMessage and Slack allow range selection (secondhand). — [Slack blog](https://slack.com/blog/productivity/get-more-from-slack-on-mobile); [Cursor forum](https://forum.cursor.com/t/grok-bot-ios-cannot-select-text-in-a-message-long-press-only-copies-the-whole-thing/168474)
- Claude mobile app: user issue reports say only whole-message or one-paragraph copy works and request "normal text selection inside rendered messages, drag on desktop and long-press on mobile, or per-paragraph copy buttons". Including a report about the Remote Control session on the mobile app (same product class as this app) where selected text copies incorrectly. These are user reports on a third-party aggregator (claudeissues.com), not Anthropic docs; I could not open the pages. — [selective copy request](https://claudeissues.com/issue/75155-feature-request-selective-text-copy-within-messages-mobile-app-desktop-not-only); [Remote Control copy bug](https://claudeissues.com/issue/71718-bug-cannot-copy-text-correctly-from-code-tab-remote-control-session-on-mobile-ap); [cannot selectively copy](https://claudeissues.com/issue/63676-bug-cannot-selectively-copy-text-from-assistant-response-only-full-message-copy)
- ChatGPT: OpenAI forum threads (July to Oct 2026) are feature requests for highlight-to-ask pop-ups, inline subthreads and quote-reply; OpenAI support replied (24 Jul 2026) that it would pass the suggestion on, no timeline. This indicates no native highlight-to-ask on all surfaces as of those dates. A separate forum post says reply-with-quote exists in the ChatGPT web app but was requested for macOS. A third-party how-to claims a highlight then quote-icon flow; unverified. — [OpenAI forum, Jul 2026](https://community.openai.com/t/feature-request-highlight-text-in-responses-to-ask-follow-up-questions-in-a-pop-up-box/1388090); [quote reply thread](https://community.openai.com/t/ability-to-use-forum-style-quoted-reply-feature/1379172); [macOS quoting](https://community.openai.com/t/quoting-feature-in-macos-app/763816)
- Kindle app (secondary sources, may be dated): press and hold first word, drag to last word, a popup offers Highlight or Note; one feature-request thread says drag immediately highlights in the last colour. — [Tom's Guide](https://tomsguide.com/how-to/how-to-highlight-text-and-make-notes-on-your-kindle); [Logos forum (not Kindle-specific)](https://community.logos.com/discussion/comment/1345614)
- Readwise Reader mobile: selected text can become a highlight immediately ("auto-highlighting", toggled from the "..." menu bottom right on mobile). Stylus: highlighting starts as soon as the stylus touches text and the user swipes in the left or right margin to scroll, which is a deliberate gesture-conflict resolution. Highlights are a single colour; tags are used instead. — [Readwise Reader docs](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes)
- Hypothesis: desktop adder popup (Annotate / Highlight) appears on selection. A Hypothesis design doc says the desktop adder cannot be used on mobile because Android and iOS show their own selection popup, and proposes buttons that pop out of the system toolbar (proposal, not confirmed shipped). The Chrome extension is not supported on mobile browsers; the workaround is a proxy link. — [Hypothesis annotation basics](https://web.hypothes.is/help/annotation-basics/); [Pomona mobile guide](https://servicedesk.pomona.edu/support/solutions/articles/18000023532); [Hypothesis mobile help](https://web.hypothes.is/help/how-to-use-hypothesis-on-mobile-devices/)
- Flutter engineers on the native behaviour: "native apps clear selection only on tap" (maintainer comment in the scroll-clears-selection issue below). — [flutter#120892](https://github.com/flutter/flutter/issues/120892)

### Inferences
- The dominant resolution of the long-press conflict is a two-stage model: long-press opens the message menu; "Select text"/"Quote" is a menu item that then enters a selection mode on that message (Telegram, WhatsApp iOS). The alternative is long-press-on-text = selection with the app's own action added to the system toolbar (reading apps). Default-selectable chat text is rare; the user's wish matches the reading-app model.
- A hybrid is implied: long-press on a word starts selection (platform default); long-press on bubble chrome (padding, avatar, timestamp) or a dedicated "..." affordance opens the message menu. I found no source documenting any chat app doing this; treat as a design hypothesis.
- For AI-agent chat, complaints about selection and copy (Claude, Grok-bot reports) suggest default-selectable rendered markdown is an unmet expectation, which supports the user's request.

### Gaps
- No primary documentation found for Gemini, Notion, Google Docs, Apple Books, Pocket, Google Keep mobile selection behaviour; Slack and ChatGPT/Claude mobile selection not confirmed from vendor sources.
- Exact Android gesture for GitHub Mobile line-range selection not found (see section 4).

## 2. Android text selection and Flutter selection

### Takeaway
Android's floating toolbar is an ActionMode of type TYPE_FLOATING; custom items arrive via ActionMode.Callback or PROCESS_TEXT. In Flutter, SelectionArea/SelectableRegion with contextMenuBuilder lets you add an app action (e.g. "Comment") to the toolbar and read the selection, but selection across lazy lists and horizontal swipe conflicts have had a stream of bugs, with an open crash tracked as of Nov 2026.

### Cited Findings
**Android platform**
- ActionMode represents a contextual mode that replaces parts of the UI; text selection is the canonical example. TYPE_FLOATING (API 23+) means the action mode is treated as a Floating Toolbar; TYPE_PRIMARY is default. ActionMode.Callback2 extends Callback to provide content-rect information (used to position the floating toolbar near the selection). `invalidateContentRect()` repositions without rebuilding. `hide(duration)` temporarily hides the toolbar so it does not obstruct content (capped internally at a few seconds). New `setTextSelection()` / `clearTextSelection()` forward selection data to a text-classification pipeline (smart selection actions) from support library version 37.2 per the docs. — [ActionMode reference](https://developer.android.com/reference/android/view/ActionMode)
- ACTION_PROCESS_TEXT: an activity declared for it with category DEFAULT appears as an item in the selection toolbar, labelled with the activity's android:label (keep short). Selected text arrives as CharSequence in EXTRA_PROCESS_TEXT; EXTRA_PROCESS_TEXT_READONLY indicates non-editable text. With AppCompatActivity, native floating toolbar on API 23+ needs `getDelegate().setHandleNativeActionModesEnabled(false)`. Source is a 2015 Android Developers post; check current docs before relying on details. PROCESS_TEXT items are system-wide activities (launch another activity), not in-app callbacks. — [Android Developers Medium](https://medium.com/androiddevelopers/custom-text-selection-actions-with-action-process-text-191f792d2999) (via search snippet; page returned 403 on fetch)
- Material guidance: only Material 1/2-era pages surfaced; the Android text selection toolbar guidance says the toolbar appears on selection, disappears on action or tap outside, shows Cut/Copy/Paste and a "More" overflow that expands into a secondary menu; handles are 22 x 22 dp in the old spec. I could not retrieve current Material 3 text-selection guidance (m3.material.io has no dedicated page found; the m2 page fetch returned only headings). — [Material text selection toolbar (m2)](https://m2.material.io/design/platform-guidance/android-text-selection-toolbar/); [Material 1 selection pattern](https://m1.material.io/patterns/selection.html)
- Magnifier and smart selection details: no primary source retrieved (see Gaps).

**Flutter API**
- Widgets are not selectable by default; wrap a subtree in SelectionArea (Material) or SelectableRegion; `Text` participates automatically, `RichText` needs a registrar and selectionColor, custom render objects must implement `Selectable`. Nested regions are isolated (child selection cannot extend past its subtree; parent cannot extend into it). Selection follows screen order unless grouped in a SelectionContainer. On touch, long-press selects a word then drag extends. `SelectionContainer.disabled` excludes subtrees (useful for timestamps, buttons). `SelectableRegionSelectionStatus` is `changing` during drag and `finalized` on release (use to avoid showing UI mid-drag). — [SelectableRegion API](https://api.flutter.dev/flutter/widgets/SelectableRegion-class.html)
- `contextMenuBuilder` builds the toolbar; `SelectableRegion.getSelectableButtonItems` returns default buttons; `AdaptiveTextSelectionToolbar.buttonItems` lets you keep defaults and append custom `ContextMenuButtonItem`s. Migration guide and `flutter create --sample=material.SelectionArea.contextMenuBuilder.1` sample exist. — [SelectionArea.contextMenuBuilder](https://api.flutter.dev/flutter/material/SelectionArea/contextMenuBuilder.html); [context-menus migration guide](https://docs.flutter.dev/release/breaking-changes/context-menus)
- To read the selected text for a "Comment" action, `SelectionArea.onSelectionChanged` / SelectedContent is the documented path (a StackOverflow thread on this exists; not opened). The selection is of rendered text only, so mapping back to source offsets (markdown, diff lines) is the app's job. — [SO thread listing](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/74178438/accessing-text-selected-in-selectionarea-flutter)

**Flutter known issues (dated)**
- #120892 (3.7/3.8): scrolling a SelectionArea cleared the selection and handles rendered outside the viewport; fixed by PR #128765 (Jun 2023); cause was `onLongPressCancel` clearing selection; observed on iOS, not on the Android emulator. — [flutter#120892](https://github.com/flutter/flutter/issues/120892)
- #152420 / PR #151138 (Aug 2024): scroll jank when SelectionArea/SelectableRegion is inside a Scrollable (ListView, PageView), tested in both axes; reported as having no app-level workaround; fixed. — [flutter#152420](https://github.com/flutter/flutter/issues/152420)
- PR #147341 (merged May 2024): iOS-only; TextField horizontal drag now loses to parent horizontal scrollables (PageView) unless dragging the collapsed cursor. This concerns TextField, not SelectionArea; I found no equivalent documented rule for SelectionArea handles inside PageView. — [flutter PR 147341](https://www.github.com/flutter/flutter/pull/147341)
- #124078: "Select all" in a ListView throws a null check error; expected behaviour is that items not built at selection time appear unselected when scrolled into view. — [flutter#124078](https://github.com/flutter/flutter/issues/124078) (title via search only)
- #196102 (opened 6 Nov 2026, open, "found in 3.47", team-text-input, on the SelectableRegion Improvements board, fix PR #196141 open): removing a selectable that holds a selection edge throws a null-check error in `MultiSelectableSelectionContainerDelegate._adjustSelection`; repro uses a drag selection across two ListViews, scrolled so no edge is visible. Related #195521 / PR #195619. — [flutter#196102](https://github.com/flutter/flutter/issues/196102)
- ListView.builder virtualisation: a third-party forum post reports selection state is not preserved for rows that scroll off screen even with larger cache extent; unconfirmed for plain SelectionArea. — [Syncfusion forum](https://www.syncfusion.com/forums/195431/sfdatagrid-with-vertical-scrolling-many-rows-not-working-well-with-flutter-selectionarea)

### Inferences
- A per-message `SelectionArea` (one per bubble) avoids cross-lazy-list edge cases but cannot select across messages; one `SelectionArea` over the whole list allows cross-message selection but is exposed to #124078 and #196102-class crashes. For comments anchored to one agent reply, per-message regions are the lower-risk choice.
- Anchoring comments needs the app to keep source offsets: Flutter gives only the selected string (SelectedContent), so code/diff/markdown need either custom Selectable render objects or a mapping (text plus occurrence index) from rendered text to source.
- The "Comment" button belongs in `contextMenuBuilder` buttonItems next to Copy/Select all; on Android it renders as the floating toolbar so it matches platform expectation.
- Horizontal-swipe conflict with PageView: no definitive source for SelectionArea handles; must be tested on-device. The gesture arena decides, and only the iOS TextField case has a documented resolution.

### Gaps
- No primary source on Android magnifier behaviour, smart selection (TextClassifier) behaviour, or Material 3 text selection spec.
- Did not verify Flutter 3.47 behaviour first-hand (no device or code run); relies on issue text.
- Did not read #124078 and #195521 bodies; status unconfirmed.
- No source on selection across markdown widget packages (flutter_markdown, gpt_markdown etc.); not found.

## 3. Annotation UX: highlight-then-note, margin indicators, threads, many annotations

### Takeaway
The proven pattern is: select, then a small action bar offers Highlight or Note/Comment; existing annotations are shown as tinted spans with a marker, tap opens a detail sheet with edit/delete; handles on the highlight edit its range. Mobile review tools collapse margin threads into inline expandable bubbles. Evidence for density handling (many annotations) is thin.

### Cited Findings
- Readwise Reader: highlights can be extended or shortened by dragging handles at the start or end of the highlight, and dragging can merge two highlights into one. Annotations appear in the right margin when the screen is wide enough; on narrow screens the notebook/annotation bar is used. Mobile annotation bar has tag and "jump to original location" icons. Overlap and deletion are not covered in the retrieved text. — [Readwise Reader docs](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes)
- Hypothesis: popup adder offers Annotate (note) or Highlight (no note), so highlight-then-note is two outcomes of one selection. — [Hypothesis basics](https://web.hypothes.is/help/annotation-basics/)
- Hypothesis accessibility test: the adder popup is not keyboard reachable and screen reader users had difficulty with selection (secondary report). — [Hypothesis search result](https://web.hypothes.is/help/annotation-basics/) (finding came from search summary; not verified on page)
- Kindle: after press-hold-drag, popup shows Highlight or Note (secondary). — [Tom's Guide](https://tomsguide.com/how-to/how-to-highlight-text-and-make-notes-on-your-kindle)
- Stylus case: Readwise treats pen touch as immediate highlight, finger as scroll-capable, so input device disambiguates gesture. — [Readwise Reader docs](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes)
- GitHub Mobile (code review): Feb 2026 update lets you comment on unchanged lines in a changed file on iOS and Android (expand the diff to reveal unchanged lines, then add comment or suggestion); comments left on unchanged lines on the web appear in the app. Earlier file-level comments (including deleted, binary, renamed files) are GA on web and mobile. Oct 2020 press says multi-line comments on mobile were accessed by long-pressing lines; the current gesture is not documented in what I found. Jul 2026: "Fix with Copilot" action on Copilot review comments in GitHub Mobile. — [GitHub changelog Feb 2026](https://github.blog/changelog/2026-02-03-github-mobile-comment-on-unchanged-lines-in-pull-request-files); [Jul 2026](https://github.blog/changelog/2026-07-17-github-mobile-fix-pull-request-comments-with-copilot-cloud-agent); [TNW 2020](https://thenextweb.com/news/github-improves-mobile-code-review-with-file-switcher-and-multiple-comments); [expand lines 2022](https://github.blog/changelog/2022-05-17-expand-code-lines-while-you-are-reviewing-a-pull-request-on-github-mobile)
- Readwise "auto-highlighting" (selection becomes highlight immediately) is a toggle, showing that one-step vs two-step is a user preference. — [Readwise Reader docs](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes)

### Inferences
- Line-level comments are the natural phone granularity for code (tap a line or gutter); range-level on phones is awkward, and GitHub's own history (multi-line via long-press) hints at line-first with range as extension. Not directly sourced.
- Because comments are batched before sending, a persistent counter and a review sheet listing pending comments (jump-to, edit, delete) is a likely need; no direct source, derive from GitHub's "pending review" model (not retrieved).

### Gaps
- Nothing retrieved for GitLab and Gerrit mobile web, Google Docs mobile comments, Notion comment anchors, Apple Books, Google Keep, Pocket, NN/g or Smashing write-ups on annotation density; thread-anchoring behaviour when text changes (re-anchoring) not covered.

## 4. Quote-reply of a fragment

### Takeaway
Telegram is the reference: select text, tap Quote, quote appears above the composer, tap on quote jumps to the exact fragment. ChatGPT had no confirmed native mobile equivalent as of mid/late 2026; WhatsApp Android partial quoting was in development.

### Cited Findings
- Telegram: selection then "Quote"; tapping a quote scrolls to and animates the exact spot in the original. Blog does not describe the rendered layout. — [Telegram blog](https://telegram.org/blog/reply-revolution)
- Telegram also lets replies be sent to another chat (relevant to batching or sending fragments elsewhere). — [SamMobile](https://www.sammobile.com/news/telegram-adds-quote-formatting-name-colors-revised-reply-more/)
- ChatGPT: requests for quote reply and inline subthreads still open on the forum in 2026; support gave no timeline (see section 1). Third-party extensions (HighlightGPT, Bubble, Quote & Reply for Gemini) fill the gap, evidence of demand. — [OpenAI forum](https://community.openai.com/t/feature-request-highlight-text-in-responses-to-ask-follow-up-questions-in-a-pop-up-box/1388090); [Quote & Reply for Gemini](https://chromewebstore.google.com/detail/quote-reply-for-gemini/afhcldemoeopplcepdhggglfdebkapfo)
- WhatsApp Android partial quoting: a third-party blog describes steps but says it is not yet available (forecast); WABetaInfo says selection depends on a redesigned context menu. — [green-api blog](https://green-api.com/en/blog/2025/partial-quoting-in-whatsapp-on-android/); [WABetaInfo](https://wabetainfo.com/whatsapp-beta-for-android-2-25-18-3-whats-new/)

### Inferences
- A quote chip with source jump-back is the expected pattern; for this product, a pending-comment chip that jumps to the highlighted fragment mirrors Telegram's tap-to-jump.

### Gaps
- iMessage inline reply and exact visual layout of quotes in Telegram/ChatGPT/Claude not sourced.

## 5. Accessibility of selection

### Takeaway
TalkBack exposes selection through gestures and reading-control "actions", and apps can expose custom actions; custom selection-toolbar behaviour must be reachable by these routes. I found Google's user docs but not developer guidance on making custom Flutter selection actions accessible.

### Cited Findings
- TalkBack 9.1+: two-finger double tap and hold starts/ends selection mode, three-finger double tap copies, three-finger double tap and hold cuts in selection mode; gestures can be reassigned (two-finger swipes cannot); "Show custom actions" is an assignable gesture and "Custom actions" a voice command; since 13.1 actions (cut, copy, paste) are reached through the reading controls "actions" granularity. — [TalkBack gestures](https://support.google.com/accessibility/android/answer/6151827); [TalkBack menu and reading controls](https://support.google.com/accessibility/android/answer/6007066); [TalkBack 13.1 notes](https://support.google.com/accessibility/android/answer/13208602?hl=en-GB)
- Hypothesis's selection adder failed keyboard and screen reader testing (secondary, see section 3).

### Inferences
- A selection-only way to comment is not accessible; a parallel route (a "Comment" custom accessibility action on each message or paragraph, via Semantics custom actions) is likely needed. This is my inference; I found no source on Flutter Semantics custom actions here.
- Switch Access: no sources found.

### Gaps
- No sources found on Switch Access text selection, Flutter SelectionArea with TalkBack, or iOS VoiceOver selection.
