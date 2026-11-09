# Markdown files with text comments in the app (#89) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the phone, open a Markdown file from the chat, select text, comment on it with the quick labels; the
comments gather above the composer and leave with the next message, exactly as the desktop sends them.

**Architecture:** The phone is a tab of the window, so the comment set is the window's own (`comments` client message
and server event, full replacement). A Dart port of the desktop's anchor model (`web/src/anchors`) builds the same
"rendered text" from the Markdown AST, so an anchor made on the phone resolves on the desktop and back. The batch
text is a port of `composeBatch` for text anchors; the quick labels and the batch strings are generated from the web
sources, so the two clients cannot drift.

**Tech Stack:** Flutter (`mobile/app`), `markdown` + `flutter_markdown_plus` (`MarkdownBuilder` over our own AST),
`nb_protocol` generated types, Vitest + jsdom for the desktop-side fixtures, Node scripts for generation.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` (The app: navigation, comments accumulate,
app strings). Issue #89.

## Global Constraints

- Branch `gh-89-md` from `remote`; PR into `remote`; squash; title and commits `gh-89: …`.
- Every user-visible app string in all six ARB files (en, ru, zh, es, pt, de) with a real translation.
- The batch text and the quick labels are the desktop's: same format (`composeBatch`), same label emoji, texts and
  English instructions (`web/src/comments/labels.ts`, `label_*` keys of `web/src/i18n`), in the phone's language.
- No protocol change. The window must accept the comment the desktop would make (`isComment` in `shared`).
- Tests only on ports 4790–4795; Flutter widget tests use the existing fakes (`test/support`).
- Text anchors only (file sources). Media anchors are #90; comments on chat replies are out of this issue.

## Review Focus

1. A selection the phone turns into an anchor resolves to the same quote on the desktop's rendered text (code
   blocks, lists, tables, math, a mermaid block, repeated words): the fixture parity test covers each.
2. The comment set is a full replacement: adding on the phone keeps comments the desktop made (sent and pending),
   and an echo that arrives while a send is pending does not drop the new one.
3. Send with comments while the agent works (queue and Send now): the comment ids travel with the message and the
   comments move to `sent` only on the server's echo; a refused send leaves them pending.
4. A file that is not Markdown, too large (over 2 MiB), missing (404) or outside the project (403) shows a clear
   state, never a crash or a blank page.
5. A comment whose quote no longer exists in the file (the file changed) stays in the strip and is still sent; it is
   only not highlighted.

---

### Task 1: The anchor model in Dart, checked against the desktop

**Files:**
- Create: `mobile/app/lib/comments/anchor.dart`
- Create: `mobile/app/test/anchor_test.dart`
- Create: `mobile/app/test/fixtures/md/*.md` (5 files: prose, lists and quotes, code and mermaid, table, math)
- Create: `web/src/anchors/mobileParity.test.tsx` (renders each fixture with the desktop's `Markdown` as `TextBody`
  does, `textOf` on the container; compares with `<name>.txt` beside it; `UPDATE_FIXTURES=1` writes them)
- Create: `mobile/app/test/fixtures/md/*.txt` (written by the Vitest test)

**Interfaces:**
- Produces:
  - `class RenderedText { final String text; final List<TextRun> runs; }`, where `TextRun { md.Text node; int start; List<int> map; }` maps a node's raw offsets to normalised ones, as `text.ts` does.
  - `RenderedText renderedText(List<md.Node> nodes)` follows the `text.ts` rules: whitespace runs collapse to one space, ends are trimmed, block boundaries become a space (the same `BLOCKS` set), and mermaid blocks are skipped.
  - `List<md.Node> parseMarkdown(String text)`: the same extension set and math syntaxes as `NbMarkdown`.
  - `TextAnchor makeAnchor(AnchorSource source, String text, int start, int end)` (`CONTEXT = 32`).
  - `({int start, int end})? resolveAnchor(TextAnchor a, String text)`: a line-by-line port of `resolve.ts`.

- [ ] Step 1: port `resolve.test.ts`'s ten cases to `anchor_test.dart` and run them. They fail: nothing is defined yet.
- [ ] Step 2: implement `makeAnchor` and `resolveAnchor`. The ported cases pass.
- [ ] Step 3: write the five fixtures and the Vitest parity test, then run it with `UPDATE_FIXTURES=1`. Read the
      `.txt` files: math is the MathML text, and the mermaid block is absent.
- [ ] Step 4: Dart test `rendered text matches the desktop for <fixture>`: `renderedText(parseMarkdown(md)).text == txt`.
      It fails until step 5.
- [ ] Step 5: implement `parseMarkdown` and `renderedText`. Where math or code cannot match exactly, rule it: the
      test then asserts that every paragraph's text matches, and that an anchor on each paragraph resolves in the
      desktop text.
- [ ] Step 6: commit `gh-89: the desktop's anchor model in Dart, checked against its rendered text`.

### Task 2: Quick labels and batch strings generated from the web

**Files:**
- Create: `scripts/mobile-strings.mjs`, which imports `web/src/comments/labels.ts` and `web/src/i18n/*.ts` through `node --experimental-strip-types`, the way `mobile-assets.mjs` loads web code, and writes `mobile/app/lib/comments/strings.g.dart`.
- Modify: `package.json`: add `gen:mobile-strings` and run it from `gen:protocol`.
- Modify: `.github/workflows/ci.yml`: the protocol job's stale check also covers `strings.g.dart`.
- Create: `mobile/app/test/strings_test.dart`

**Interfaces:**
- Produces:
  - `const quickLabels = <QuickLabel>[…]`, where `QuickLabel { QuickLabelId id; String emoji; String? instruction; Map<String,String> text; }` and `text` maps language to label text for en, ru, zh, es, pt, de.
  - `String batchString(String key, String lang)` for the keys `composeBatch` uses with text anchors: `batchHead`.
- Languages: the web's `zh-CN` and `pt-BR` map to the app's `zh` and `pt`.

- [ ] Step 1: write `strings_test.dart`: 11 labels in `QUICK_LABEL_IDS` order; `fire` has its English instruction; the
      `ru` text of `looks-good` matches `web/src/i18n/ru.ts`. Run it: it fails.
- [ ] Step 2: write the script and generate. The test passes, and running `npm run gen:protocol` a second time
      changes nothing.
- [ ] Step 3: commit `gh-89: quick labels and batch strings generated from the web`.

### Task 3: The window's comments in the tab, and the batch on send

**Files:**
- Create: `mobile/app/lib/comments/comments.dart`
- Modify: `mobile/app/lib/chat/window_tab.dart` (it keeps `ServerEventComments`; `send` takes the comments)
- Modify: `mobile/app/lib/chat/composer.dart`
- Create: `mobile/app/test/comments_test.dart`

**Interfaces:**
- Produces:
  - `class Comments extends ChangeNotifier`, with:
    - `List<Comment> all`, `pending` and `forFile(String path)`;
    - `void apply(List<Comment> items)` (the server's set);
    - `Comment add(TextAnchor a, String text, QuickLabelId? label)`, `void edit(String id, String text, QuickLabelId? label)` and `void remove(String id)`, each sending the full set through `send`.
  - `String composeBatch(String general, List<Comment> items, String lang)`: the text-anchor branch of `compose.ts`. A file source's `whereOf` is its path, or `path @ ref`.
  - `WindowTab.comments`.
  - `WindowTab.sendText(text, {force})`: sends `text` with the pending comments' ids. Nothing changes locally: the server's echo moves them to `sent`.

- [ ] Step 1: tests, which fail:
  - `apply` replaces the set;
  - `add` sends the old set plus the new one, keeping the desktop's;
  - an echo of the old set arriving after `add` but before its own echo keeps the new comment, by an optimistic
    overlay per id until the server's set contains it or 5 s pass;
  - `composeBatch` matches `compose.test.ts`'s text cases (general plus two comments, label and instruction lines);
  - `sendText` with two pending comments sends `commentIds` and the composed text;
  - a send-refused leaves them pending.
- [ ] Step 2: implement. The tests pass.
- [ ] Step 3: commit `gh-89: the window's comments on the phone, sent as the desktop's batch`.

### Task 4: The Markdown file screen with selection, the comment sheet and highlights

**Files:**
- Create: `mobile/app/lib/files/file_screen.dart`
- Create: `mobile/app/lib/comments/comment_sheet.dart`
- Modify: `mobile/app/lib/chat/markdown.dart` (exposes its `MarkdownStyleSheet`, builders and syntaxes, so the file
  screen builds the same look from its own AST through `MarkdownBuilder`)
- Modify: the ARB files: `fileTooLarge`, `fileNotFound`, `fileNotMarkdown`, `fileOutside`, `comment`, `commentHint`, `deleteComment`, `save`.
- Create: `mobile/app/test/file_screen_test.dart`

**Interfaces:**
- Consumes: `parseMarkdown`, `renderedText`, `makeAnchor`, `resolveAnchor` (Task 1); `Comments` (Task 3); `quickLabels` (Task 2).
- Produces:
  - `FileScreen({required WindowTab tab, required String path})`. It reads `GET /file?path=<rel>` through `tab.link.channel.http`. The size limit is 2 MiB, and only `.md` and `.markdown` files are shown.
  - `Future<void> showCommentSheet(BuildContext, {required String quote, Comment? editing})`. It returns `(text, label)`, or null on cancel.
- Highlights: each resolved range of `forFile(path)` is split out of its text nodes in the AST and wrapped in an
  `nbmark` element, which a builder paints with `accent` at 25 % (pending) or `border` (sent). Tapping a mark opens the
  sheet to edit or delete.
- Selection: the body sits in a `SelectionArea`. A "Comment" action in its toolbar takes the selected text,
  collapses its whitespace, and picks the occurrence in `RenderedText.text` closest to the selection's approximate
  offset (`SelectionListener` details). From that it makes the anchor with `makeAnchor`.

- [ ] Step 1: tests with a fake channel serving `/file`, which fail:
  - the file renders;
  - a pending comment's quote is highlighted;
  - selecting a word and choosing Comment, then the 🔍 label and Save, adds a comment whose anchor quote is that word and whose prefix and suffix come from the rendered text;
  - the second occurrence of a repeated word is anchored at the second one;
  - the 404, 403, too large and not-Markdown states each show their text.
- [ ] Step 2: implement. The tests pass.
- [ ] Step 3: commit `gh-89: Markdown files on the phone, commented by selection`.

### Task 5: Entry points, the strip above the composer, docs

**Files:**
- Modify: `mobile/app/lib/chat/chat_screen.dart` (Read, Write and Edit tool lines on a `.md` path under the window root
  open `FileScreen`; a "Files" item in the agent menu lists the session's `.md` paths from the feed's tool calls,
  newest first)
- Create: `mobile/app/lib/comments/comment_strip.dart` (above the composer: the pending count, each comment's label,
  quote and text; tap opens its file; long-press deletes after a confirmation)
- Modify: ARB files (`files`, `noFiles`, `pendingComments`), `docs/guide.md` (the Android section), `mobile/README.md`
- Create: `mobile/app/test/comment_strip_test.dart`, `mobile/app/test/files_menu_test.dart`

- [ ] Step 1: tests, which fail:
  - a Write tool line on `/root/docs/plan.md` opens `FileScreen` with `docs/plan.md`;
  - one on a file outside the root does not;
  - the Files menu lists the paths deduplicated, newest first;
  - the strip shows two pending comments and hides sent ones;
  - Send with the strip full sends the batch, and the strip empties on the echo.
- [ ] Step 2: implement, translations in all six languages. The tests pass.
- [ ] Step 3: run `flutter analyze`, `dart format --set-exit-if-changed`, `flutter test`, `npm test`.
- [ ] Step 4: commit `gh-89: open files from the chat, pending comments above the composer, guide`.
