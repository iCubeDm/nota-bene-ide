# Phone chat comments (#144) Implementation Plan

**Goal:** On the phone, comment chat messages as on the desktop: long-press a message for quick-label emoji and a menu, select a passage and comment it, see commented passages highlighted and numbered, and send them in the desktop's batch.

**Approach:** Comments already live in the window's set on the host (`WindowTab.comments`, `{type:'comments'}`), and the phone already anchors Markdown files (`comments/anchor.dart`, `renderedText`, `locateSelection`, mark injection in `files/file_markdown.dart`). The same machinery is pointed at feed items: a chat anchor's source is `{kind:'message', id}`, its text is the item's rendered text as the desktop computes it for `[data-item-id]` roots.

**Spec:** `docs/superpowers/specs/2026-11-09-phone-ux-design.md` ("Comments in the chat"). Global constraints of `2026-11-09-phone-layout.md` apply.

## Decisions

- No protocol change: existing `Comment`, `TextAnchor`, `AnchorSourceMessage`.
- Scope: commentable items are user messages and final assistant replies. Tool panels, plans and subagent replies stay desktop-only; their desktop comments still show in the strip and send correctly.
- A reply still streaming (`final_ == false`) has no comment actions, as the desktop excludes `stream:*`.
- Web-owned texts go through `webString` (generator); app texts in all six ARB files.

## Design

- Chat anchors (`comments/chat_anchor.dart`): `chatSource(item)` returns `AnchorSourceMessage(id)` for a user item and a final assistant item, else null. `chatText(item)` is `renderedText(parseMarkdown(text))` for a reply, and the desktop's user-bubble text for a user message. Parity is checked by extending the web fixture test `web/src/anchors/mobileParity.test.tsx`.
- Batch "where": `whereOfChat(id, feed, lang)` mirrors `selectReplyLabel(..., plain = true)` in `web/src/store/store.ts`: user message gives `srcMine`, final reply gives `replyPlain`, unknown gives `srcChat`. `srcMine` and `replyPlain` are added to `WEB_KEYS`. `composeSend` gains a required `Feed feed`.
- Message menu (`chat/message_menu.dart`): an overlay (not a route), Telegram-like: scrim, message lifted in place, emoji row above (below if no room), vertical menu Comment / Select text / Copy / Reply. The row shows the first five labels of the web bar (`looks-good`, `fire`, `clarify`, `verify`, `out-of-scope`) plus a chevron expanding to all eleven; the name is a tooltip on long-press. An emoji adds a whole-message comment (start 0, end = length, empty text). Comment opens the sheet (quote cut to 200 chars in the sheet only). Copy puts the raw text (Markdown source). Reply puts `> line` per line plus an empty line into the draft and focuses it, so `chat_route.dart` owns a shared draft `TextEditingController`. ARB keys: `menuComment`, `menuSelectText`, `menuCopy`, `menuReply`, `menuSelectAll`, `labelsAll`.
- Selecting a passage: "Select text" puts that one message into a `SelectionArea` (word at the press point selected) with a custom vertical toolbar Comment / Copy / Select all. Uses `locateSelection`/`makeAnchor` like `files/file_screen.dart`; the second of two equal quotes gets its own offset. Tapping outside leaves selection mode. `openCode(context, code, lang)` gains optional `{tab, item}` so selecting code in the full-screen code screen anchors into the message.
- Highlights: `NbMarkdown` takes marks (mark injection shared with `file_markdown.dart`). A pending comment gets an accent highlight and a numbered badge equal to its strip number; sent comments are not highlighted; an unresolved quote shows no highlight but stays in the strip; tapping a highlight opens the sheet in edit mode; a whole-message comment shows the badge at the message's top-right.
- Comment sheet: label row is emoji only, 32 px circles, selected one ringed in `accent`, name as tooltip.

## Review focus

- Desktop comment on a reply the phone loaded is highlighted at the same passage.
- A reply compacted away or older than "show earlier": comment stays in the strip, labelled as on the desktop, and sends.
- Long-press on a code block or link in a reply opens the message menu; tapping a link still opens it.

## Files

New: `mobile/app/lib/comments/chat_anchor.dart`, `mobile/app/lib/chat/message_menu.dart`. Changed: `comments/comments.dart`, `comments/comment_sheet.dart`, `chat/{composer,chat_screen,chat_route,code_screen,markdown}.dart`, `files/file_markdown.dart`, `scripts/protocol/mobileStrings.ts` (+ `strings.g.dart`), `web/src/anchors/mobileParity.test.tsx`, six ARB files. Tests: `chat_anchor`, `comments`, `message_menu`, `chat_selection`, `chat_highlight`, `comment_sheet`.

Final check: `npx tsc -b`, `npx vitest run web/src/anchors scripts/protocol`, the Flutter checks, `flutter build apk --release`.
