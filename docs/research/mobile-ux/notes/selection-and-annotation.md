# Text selection, quoting and annotation of fragments on mobile (Android first, iOS comparison)

Research date 2026-11-10. Evidence varies: primary = docs, vendor, issue tracker; secondary = forum, press, third-party. Where only a search snippet was seen, it is said.

## 1. Default-selectable text vs long-press message menu

**Takeaway.** Chat apps mostly put whole-message actions behind long press, with partial selection as a second step in that menu or flow (Telegram, WhatsApp, Slack). Reading and annotation apps (Kindle, Readwise Reader, Hypothesis) make the text selectable and turn selection into a highlight or note. No primary source documents how ChatGPT, Claude or Gemini mobile resolve this; for Claude the only evidence is complaints that selection is not possible, a known pain point in the category.

**Findings**
- Telegram (Oct 2023, "Replies 2.0"): tap the message (iOS: press and hold), hold and drag to select, choose "Quote", write the reply; tapping the quote later jumps with animation to the exact place. Selection is reached via the message-level tap, then a drag; the toolbar carries "Quote". Quote formatting is separate (any text in your reply, several quotes per reply); the layout of a quote in the chat is not described ([blog](https://telegram.org/blog/reply-revolution)). Tracker: a long-standing "partial reply" request; an older flow was "long-press message, select text, tap reply, selection appears as a quote above the input" (user report, snippet only: [thread](https://bugs.telegram.org/c/1050/39)).
- WhatsApp: partial selection and copy live on iOS (press and hold, drag). On Android in development at beta 2.25.18.3 (mid 2025), tied to a redesigned message context menu; shipping not confirmed ([WABetaInfo](https://wabetainfo.com/whatsapp-beta-for-android-2-25-18-3-whats-new/), [Digit](https://www.digit.in/news/apps/whatsapp-for-ios-finally-lets-you-copy-just-part-of-message-heres-how-it-works.html/amp/)).
- Slack mobile: tap-and-hold opens the action menu (reactions, thread, share, mark unread, save, copy link, edit); partial selection not mentioned and unconfirmed; a forum post assumes iMessage and Slack allow range selection (secondhand) ([Slack](https://slack.com/blog/productivity/get-more-from-slack-on-mobile), [Cursor forum](https://forum.cursor.com/t/grok-bot-ios-cannot-select-text-in-a-message-long-press-only-copies-the-whole-thing/168474)).
- Claude mobile: user reports say only whole-message or one-paragraph copy works and ask for "normal text selection inside rendered messages, drag on desktop and long-press on mobile, or per-paragraph copy buttons", including a Remote Control mobile session (same product class as this app) where selected text copies incorrectly. User reports on a third-party aggregator, pages not opened ([75155](https://claudeissues.com/issue/75155-feature-request-selective-text-copy-within-messages-mobile-app-desktop-not-only), [71718](https://claudeissues.com/issue/71718-bug-cannot-copy-text-correctly-from-code-tab-remote-control-session-on-mobile-ap), [63676](https://claudeissues.com/issue/63676-bug-cannot-selectively-copy-text-from-assistant-response-only-full-message-copy)).
- ChatGPT: forum threads (Jul-Oct 2026) request highlight-to-ask pop-ups, inline subthreads, quote-reply; support said (24 Jul 2026) it would pass it on, no timeline. Reply-with-quote reportedly exists in the web app and was requested for macOS; a third-party highlight-then-quote how-to is unverified ([Jul 2026](https://community.openai.com/t/feature-request-highlight-text-in-responses-to-ask-follow-up-questions-in-a-pop-up-box/1388090), [quote reply](https://community.openai.com/t/ability-to-use-forum-style-quoted-reply-feature/1379172), [macOS](https://community.openai.com/t/quoting-feature-in-macos-app/763816)).
- Kindle (secondary, maybe dated): press and hold first word, drag to last, popup offers Highlight or Note; one request says drag highlights at once in the last colour ([Tom's Guide](https://tomsguide.com/how-to/how-to-highlight-text-and-make-notes-on-your-kindle)).
- Readwise Reader mobile: selection can become a highlight immediately ("auto-highlighting", toggle in the "..." menu). Stylus starts highlighting on touch while a swipe in the side margin scrolls, a deliberate gesture-conflict resolution. Single colour, tags instead ([docs](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes)).
- Hypothesis: desktop adder popup (Annotate / Highlight) on selection. A design doc says it cannot be used on mobile because Android/iOS show their own selection popup, and proposes buttons popping out of the system toolbar (proposal, shipping unconfirmed). The Chrome extension is unsupported on mobile; workaround is a proxy link ([basics](https://web.hypothes.is/help/annotation-basics/), [Pomona](https://servicedesk.pomona.edu/support/solutions/articles/18000023532), [mobile help](https://web.hypothes.is/help/how-to-use-hypothesis-on-mobile-devices/)).
- Flutter maintainer: "native apps clear selection only on tap" ([flutter#120892](https://github.com/flutter/flutter/issues/120892)).

**Inferences**
- Dominant resolution: two-stage. Long press opens the message menu; "Select text"/"Quote" enters selection mode on that message (Telegram, WhatsApp iOS). The alternative is long press on text = selection with the app's action added to the system toolbar (reading apps). Default-selectable chat text is rare; the user's wish matches the reading-app model.
- Implied hybrid: long press on a word starts selection; long press on bubble chrome (padding, avatar, timestamp) or a "..." affordance opens the message menu. No chat app documented doing this: a design hypothesis.
- Selection/copy complaints for AI chat (Claude, Grok-bot) suggest default-selectable rendered markdown is an unmet expectation, supporting the user's request.

**Gaps.** No primary docs for Gemini, Notion, Google Docs, Apple Books, Pocket, Google Keep selection; Slack and ChatGPT/Claude mobile selection unconfirmed from vendors; GitHub Mobile line-range gesture unknown (section 3).

## 2. Android text selection and Flutter selection

**Takeaway.** Android's floating toolbar is an ActionMode of TYPE_FLOATING; custom items come via ActionMode.Callback or PROCESS_TEXT. In Flutter, SelectionArea/SelectableRegion with `contextMenuBuilder` lets an app add an action (e.g. "Comment") to the toolbar and read the selection, but selection across lazy lists and horizontal swipe conflicts have had a stream of bugs, with an open crash as of Nov 2026.

**Android platform**
- ActionMode is a contextual mode replacing parts of the UI (text selection is the canonical case). TYPE_FLOATING (API 23+) = floating toolbar; Callback2 supplies content-rect info; `invalidateContentRect()` repositions; `hide(duration)` hides it briefly; `setTextSelection()`/`clearTextSelection()` feed smart selection from support library 37.2 ([ActionMode](https://developer.android.com/reference/android/view/ActionMode)).
- ACTION_PROCESS_TEXT: an activity with category DEFAULT appears in the toolbar under its `android:label` (keep short); text arrives in EXTRA_PROCESS_TEXT (`..._READONLY` marks non-editable). With AppCompatActivity, native floating toolbar on API 23+ needs `getDelegate().setHandleNativeActionModesEnabled(false)`. 2015 post (snippet only, page 403): check current docs. PROCESS_TEXT items launch another activity, not in-app callbacks ([post](https://medium.com/androiddevelopers/custom-text-selection-actions-with-action-process-text-191f792d2999)).
- Material (only M1/M2 pages): toolbar appears on selection, disappears on action or outside tap, shows Cut/Copy/Paste and a "More" overflow; handles 22x22 dp in the old spec. No current M3 text-selection guidance retrieved ([M2](https://m2.material.io/design/platform-guidance/android-text-selection-toolbar/), [M1](https://m1.material.io/patterns/selection.html)). Magnifier and smart selection: no primary source.

**Flutter API**
- Widgets are not selectable by default: wrap a subtree in SelectionArea (Material) or SelectableRegion. `Text` participates automatically, `RichText` needs a registrar and selectionColor, custom render objects implement `Selectable`. Nested regions are isolated. Selection follows screen order unless grouped in a SelectionContainer. On touch, long press selects a word, drag extends. `SelectionContainer.disabled` excludes subtrees (timestamps, buttons). `SelectableRegionSelectionStatus` is `changing` during drag, `finalized` on release (avoid UI mid-drag) ([API](https://api.flutter.dev/flutter/widgets/SelectableRegion-class.html)).
- `contextMenuBuilder` builds the toolbar; `SelectableRegion.getSelectableButtonItems` returns defaults; `AdaptiveTextSelectionToolbar.buttonItems` keeps defaults and appends custom `ContextMenuButtonItem`s ([docs](https://api.flutter.dev/flutter/material/SelectionArea/contextMenuBuilder.html), [migration](https://docs.flutter.dev/release/breaking-changes/context-menus)).
- To read the selection for "Comment", use `SelectionArea.onSelectionChanged` / SelectedContent (StackOverflow thread not opened). It is rendered text only: mapping to source offsets (markdown, diff lines) is the app's job ([SO](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/74178438/accessing-text-selected-in-selectionarea-flutter)).

**Flutter known issues**
- #120892 (3.7/3.8): scrolling a SelectionArea cleared the selection, handles drawn outside the viewport; fixed by PR #128765 (Jun 2023); cause `onLongPressCancel`; seen on iOS, not the Android emulator ([issue](https://github.com/flutter/flutter/issues/120892)).
- #152420 / PR #151138 (Aug 2024): scroll jank with SelectionArea in a Scrollable (ListView, PageView), both axes, no app-level workaround; fixed ([issue](https://github.com/flutter/flutter/issues/152420)).
- PR #147341 (May 2024): iOS-only; TextField horizontal drag loses to parent horizontal scrollables (PageView) unless dragging the collapsed cursor. TextField only; no documented equivalent for SelectionArea handles in PageView ([PR](https://www.github.com/flutter/flutter/pull/147341)).
- #124078: "Select all" in a ListView throws a null check; expected: items not built at selection time appear unselected when scrolled in (title only) ([issue](https://github.com/flutter/flutter/issues/124078)).
- #196102 (opened 6 Nov 2026, open, found in 3.47, fix PR #196141 open): removing a selectable holding a selection edge throws a null check in `MultiSelectableSelectionContainerDelegate._adjustSelection`; repro: drag selection across two ListViews, scrolled so no edge is visible. Related #195521 / PR #195619 ([issue](https://github.com/flutter/flutter/issues/196102)).
- A forum post says ListView.builder rows lose selection state when scrolled off even with larger cache extent; unconfirmed for plain SelectionArea ([Syncfusion](https://www.syncfusion.com/forums/195431/sfdatagrid-with-vertical-scrolling-many-rows-not-working-well-with-flutter-selectionarea)).

**Inferences**
- One `SelectionArea` per bubble avoids cross-lazy-list edge cases but cannot select across messages; one over the whole list allows cross-message selection but is exposed to #124078/#196102-class crashes. For comments anchored to one agent reply, per-message regions are lower risk.
- Anchoring needs source offsets, and Flutter gives only the selected string: code/diff/markdown need custom Selectable render objects or a mapping (text plus occurrence index) from rendered text to source.
- "Comment" belongs in `contextMenuBuilder` buttonItems next to Copy/Select all; on Android it renders as the floating toolbar, matching platform expectation.
- Horizontal-swipe conflict with PageView: no definitive source for SelectionArea handles; test on-device (the gesture arena decides; only the iOS TextField case is documented).

**Gaps.** No primary source on Android magnifier, smart selection (TextClassifier) or M3 selection spec; Flutter 3.47 behaviour not verified first-hand; #124078 and #195521 bodies not read; nothing on selection in markdown packages (flutter_markdown, gpt_markdown).

## 3. Annotation UX: highlight-then-note, margin indicators, threads, many annotations

**Takeaway.** Proven pattern: select, then a small action bar offers Highlight or Note/Comment; existing annotations are tinted spans with a marker; tap opens a detail sheet with edit/delete; handles on the highlight edit its range. Mobile review tools collapse margin threads into inline expandable bubbles. Evidence on density (many annotations) is thin.

**Findings**
- Readwise Reader: drag handles at highlight ends to extend/shorten; dragging can merge two highlights. Annotations show in the right margin on wide screens, else in the notebook/annotation bar; mobile bar has tag and "jump to original location" icons; overlap/deletion not covered. Pen touch = immediate highlight, finger = scroll-capable: input device disambiguates gestures. "Auto-highlighting" is a toggle, so one-step vs two-step is a user preference ([docs](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes)).
- Hypothesis: the adder offers Annotate (note) or Highlight (no note): two outcomes of one selection ([basics](https://web.hypothes.is/help/annotation-basics/)). Its adder was not keyboard reachable and screen-reader users struggled with selection (secondary, from a search summary, unverified on page). Kindle: popup after press-hold-drag shows Highlight or Note (secondary).
- GitHub Mobile: Feb 2026 comment on unchanged lines (expand diff, then comment or suggestion; web comments on them show in the app); earlier file-level comments (deleted, binary, renamed) GA; Oct 2020 press says multi-line comments by long-pressing lines, current gesture undocumented; Jul 2026 "Fix with Copilot" on Copilot review comments ([Feb 2026](https://github.blog/changelog/2026-02-03-github-mobile-comment-on-unchanged-lines-in-pull-request-files), [Jul 2026](https://github.blog/changelog/2026-07-17-github-mobile-fix-pull-request-comments-with-copilot-cloud-agent), [TNW 2020](https://thenextweb.com/news/github-improves-mobile-code-review-with-file-switcher-and-multiple-comments), [2022](https://github.blog/changelog/2022-05-17-expand-code-lines-while-you-are-reviewing-a-pull-request-on-github-mobile)).

**Inferences.** Line-level comments are the natural phone granularity for code (tap a line or gutter); range selection is awkward, and GitHub's history hints at line-first with range as extension (not directly sourced). With comments batched before sending, a persistent counter and a review sheet of pending comments (jump-to, edit, delete) is a likely need, derived from GitHub's "pending review" model (not retrieved).

**Gaps.** GitLab/Gerrit mobile web, Google Docs mobile comments, Notion anchors, Apple Books, Google Keep, Pocket, NN/g or Smashing on annotation density; re-anchoring when text changes.

## 4. Quote-reply of a fragment

**Takeaway.** Telegram is the reference: select text, tap Quote, the quote appears above the composer, tapping it jumps to the exact fragment. ChatGPT had no confirmed native mobile equivalent as of mid/late 2026; WhatsApp Android partial quoting was in development.

**Findings**
- Telegram: selection then "Quote"; tapping a quote scrolls to and animates the exact spot ([blog](https://telegram.org/blog/reply-revolution)); replies can go to another chat, relevant to sending fragments elsewhere ([SamMobile](https://www.sammobile.com/news/telegram-adds-quote-formatting-name-colors-revised-reply-more/)).
- ChatGPT: quote-reply and inline-subthread requests still open in 2026, no timeline. Extensions (HighlightGPT, Bubble, Quote & Reply for Gemini) fill the gap, evidence of demand ([forum](https://community.openai.com/t/feature-request-highlight-text-in-responses-to-ask-follow-up-questions-in-a-pop-up-box/1388090), [extension](https://chromewebstore.google.com/detail/quote-reply-for-gemini/afhcldemoeopplcepdhggglfdebkapfo)).
- WhatsApp Android partial quoting: a third-party blog gives steps but says not yet available; WABetaInfo says selection depends on a redesigned context menu ([green-api](https://green-api.com/en/blog/2025/partial-quoting-in-whatsapp-on-android/), [WABetaInfo](https://wabetainfo.com/whatsapp-beta-for-android-2-25-18-3-whats-new/)).

**Inference.** A quote chip with source jump-back is the expected pattern; here a pending-comment chip that jumps to the highlighted fragment mirrors Telegram's tap-to-jump.

**Gaps.** iMessage inline reply; the visual layout of quotes in Telegram/ChatGPT/Claude.

## 5. Accessibility of selection

**Takeaway.** TalkBack exposes selection through gestures and reading-control "actions", and apps can expose custom actions; custom selection-toolbar behaviour must be reachable by these routes. Google's user docs were found, but no developer guidance on accessible custom Flutter selection actions.

**Findings.** TalkBack 9.1+: two-finger double tap and hold starts/ends selection mode, three-finger double tap copies, three-finger double tap and hold cuts; gestures can be reassigned (two-finger swipes cannot); "Show custom actions" is an assignable gesture and "Custom actions" a voice command; since 13.1 cut/copy/paste are reached through the reading controls "actions" granularity ([gestures](https://support.google.com/accessibility/android/answer/6151827), [menu](https://support.google.com/accessibility/android/answer/6007066), [13.1](https://support.google.com/accessibility/android/answer/13208602?hl=en-GB)). Hypothesis's adder failed keyboard and screen-reader testing (section 3).

**Inference.** A selection-only way to comment is not accessible; a parallel route (a "Comment" custom action on each message or paragraph, via Semantics custom actions) is likely needed. My inference; no source on Flutter Semantics custom actions here.

**Gaps.** Switch Access selection, Flutter SelectionArea with TalkBack, iOS VoiceOver selection.
