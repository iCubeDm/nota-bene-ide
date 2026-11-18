# Markdown files with text comments in the app (#89) Implementation Plan

**Goal:** On the phone, open a Markdown file from the chat, select text, comment on it with the quick labels; the comments gather above the composer and leave with the next message, exactly as the desktop sends them.

**Approach:** The phone is a tab of the window, so the comment set is the window's own (`comments` client message and server event, full replacement). A Dart port of the desktop's anchor model (`web/src/anchors`) builds the same "rendered text" from the Markdown AST, so an anchor made on the phone resolves on the desktop and back. The batch text ports `composeBatch` for text anchors; quick labels and batch strings are generated from the web sources so the clients cannot drift.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` (The app: navigation, comments accumulate, app strings).

## Decisions

- Branch `gh-89-md` from `remote`, PR into `remote`, squash, commits `gh-89: ...`. Six ARB languages with real translations. Tests only on ports 4790-4795.
- Batch text and quick labels are the desktop's: same format, emoji, texts and English instructions (`web/src/comments/labels.ts`, `label_*` keys of `web/src/i18n`), in the phone's language. Web `zh-CN`/`pt-BR` map to app `zh`/`pt`.
- No protocol change; the comment must pass `isComment` in `shared`.
- Scope: text anchors on file sources only. Media anchors are #90; comments on chat replies are out of scope here.
- The comment set is a full replacement; the phone keeps comments the desktop made. An optimistic overlay per id keeps a new comment when an older echo arrives, until the server's set contains it or 5 s pass.
- A comment moves to `sent` only on the server's echo; a refused send leaves it pending. A comment whose quote no longer exists stays in the strip and is still sent, just not highlighted.
- Files: only `.md`/`.markdown`, at most 2 MiB; 404, 403, too large and not-Markdown each show a clear state.

## Contracts

- `lib/comments/anchor.dart`: `RenderedText {text, runs}` with `TextRun {node, start, map}` (raw-to-normalised offsets, as `text.ts`); `renderedText(nodes)` (whitespace runs collapse to one space, ends trimmed, block boundaries become a space with the same `BLOCKS` set, mermaid skipped); `parseMarkdown(text)` (same extensions and math syntaxes as `NbMarkdown`); `makeAnchor(source, text, start, end)` with `CONTEXT = 32`; `resolveAnchor(anchor, text)`, a line-by-line port of `resolve.ts`.
- Parity: `web/src/anchors/mobileParity.test.tsx` renders five fixtures (`mobile/app/test/fixtures/md/*.md`: prose, lists and quotes, code and mermaid, table, math) with the desktop `Markdown` and writes `<name>.txt` (`UPDATE_FIXTURES=1`); Dart asserts `renderedText(parseMarkdown(md)).text == txt`. Where math or code cannot match exactly, the test asserts every paragraph matches and an anchor on each resolves in the desktop text.
- Strings: `scripts/mobile-strings.mjs` (loads web code via `node --experimental-strip-types`, as `mobile-assets.mjs`) writes `lib/comments/strings.g.dart` with `quickLabels` (`QuickLabel {id, emoji, instruction, text per language}`, 11 labels in `QUICK_LABEL_IDS` order) and `batchString(key, lang)` (`batchHead`). `package.json` gets `gen:mobile-strings`, run from `gen:protocol`; the CI stale check covers the file.
- `Comments extends ChangeNotifier` (`lib/comments/comments.dart`): `all`, `pending`, `forFile(path)`, `apply(items)`, `add(anchor, text, label)`, `edit`, `remove` (each sends the full set). `composeBatch(general, items, lang)` is the text-anchor branch of `compose.ts`; a file source's where is its path or `path @ ref`. `WindowTab.comments`; `WindowTab.sendText(text, {force})` sends text with the pending comments' ids and changes nothing locally.
- `FileScreen({tab, path})` (`lib/files/file_screen.dart`) reads `GET /file?path=<rel>` via `tab.link.channel.http`. `showCommentSheet(context, {quote, editing})` returns `(text, label)` or null (`lib/comments/comment_sheet.dart`). `chat/markdown.dart` exposes its stylesheet, builders and syntaxes so the file screen builds the same look from its own AST via `MarkdownBuilder`.
- Highlights: each resolved range of `forFile(path)` is split out of text nodes and wrapped in an `nbmark` element painted `accent` at 25% (pending) or `border` (sent); tapping edits or deletes. Selection: body in a `SelectionArea`; a "Comment" toolbar action collapses the selection's whitespace and picks the occurrence in `RenderedText.text` nearest the selection's approximate offset (`SelectionListener`), so a repeated word anchors at the selected one.
- Entry points: Read/Write/Edit tool lines on a `.md` path under the window root open `FileScreen`; a "Files" item in the agent menu lists the session's `.md` paths (deduplicated, newest first). `lib/comments/comment_strip.dart` above the composer shows the pending count and each comment's label, quote and text; tap opens its file, long-press deletes after confirmation.
- ARB keys: `fileTooLarge`, `fileNotFound`, `fileNotMarkdown`, `fileOutside`, `comment`, `commentHint`, `deleteComment`, `save`, `files`, `noFiles`, `pendingComments`. `docs/guide.md` (Android section) and `mobile/README.md` updated.

## Review focus

- Selection-to-anchor resolves to the same quote on the desktop (code, lists, tables, math, mermaid, repeated words).
- Send while the agent works (queue and Send now): comment ids travel with the message.

Final check: `flutter analyze`, `dart format --set-exit-if-changed`, `flutter test`, `npm test`.
