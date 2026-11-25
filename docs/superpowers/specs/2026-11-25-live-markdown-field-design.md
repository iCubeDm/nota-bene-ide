# Live markdown in the message fields — design

Issue 724. Web only; the phone is a follow-up issue.

## Intent

The person wants the message fields to read like Slack's while they type: ` ``` ` turns into a code block at once,
`**bold**` looks bold, and the marks themselves get out of the way. Today both fields are a plain `<textarea>`, so a
long prompt with code and emphasis is a wall of raw marks until it is sent.

## Goals

- The chat composer and the comment popup (both built on `MessageInput`) render markdown as it is typed.
- The marks hide; the construct shows as what it is.
- The text stays markdown: what the field holds is exactly what is sent, saved as a draft, recalled from history.
- Everything the fields do today keeps working: `@` mentions, `/` commands, `:` shortcodes, the emoji menu, prompt
  recall (↑/↓, Alt+↑/↓), Tab suggestion, Shift+Tab mode, shell mode, dictation and voice insertion, pasted and dropped
  files, paths dropped from the Files tree, autosize, Enter to send (composer), ⌘/Ctrl+Enter (comment).

## Non-goals

- The phone's field (`mobile/app/lib/chat/message_field.dart`): a separate issue after this one.
- A formatting toolbar or new formatting shortcuts (⌘B and the like).
- Rendering in other text inputs (file editor, search, rename).

## Anti-goals

- Any loss or rewrite of the person's text: no conversion to a document model and back.
- A field that behaves worse than the textarea for plain text (IME, undo, spellcheck, paste, screen readers).

## Approaches

1. **CodeMirror 6, markdown as the document, marks hidden by decorations** (Obsidian's live preview). The editor's
   text is the markdown; a view plugin parses it (`@codemirror/lang-markdown`, Lezer) and hides marks with replace
   decorations, styles the spans with mark decorations and draws fenced blocks as block lines. Nothing to convert, so
   nothing to lose. About 150 KB more in the bundle.
2. **ProseMirror (Tiptap) or Lexical, a rich document serialized to markdown on send** (Slack's model). Marks never
   show, but whatever the schema lacks (tables, raw HTML, odd nesting) is mangled or dropped on the round trip, and
   pasted markdown, recalled prompts and dictation each need a parse into the document.
3. A highlight layer under the textarea, marks shown but styled. Rejected: the person wants the marks gone.

**Picked: 1** (by the person, 2026-11-25), because the agent gets exactly what the person sees and any text survives
editing.

## Decided

- **Editor:** CodeMirror 6 (`@codemirror/state`, `view`, `commands`, `language`, `lang-markdown`), no other editor.
- **Where:** one field component replaces the textarea inside `MessageInput`; the composer and the comment popup get it
  together.
- **What renders** (Slack's set): fenced code blocks, inline code, bold, italic, strikethrough, links, block quotes,
  bulleted and numbered lists. Headings and tables stay plain text with no hiding.
- **Marks:** hidden while the caret is outside the construct; shown when the caret or selection is inside it, so they
  can be edited or deleted. A fence's lines (` ``` ` and ` ```lang `) show only while the caret is on them; the block
  body keeps its background and monospace font either way.
- **Lists and quotes** (builder's call): `- ` and `* ` show as a bullet, numbers stay as typed, `> ` shows as a bar;
  each is one unit for the caret and Backspace. A newline in an item continues the list or quote; a newline on an empty
  item ends it.
- **Shell mode** (builder's call): a `!` draft renders nothing; it shows exactly what runs.
- **Links** (builder's call): styled, not clickable in the field.
- **Code inside blocks:** highlighted with the `highlight.js` the feed already uses, by the fence's language. No
  highlighting without a language (builder's call: the feed guesses one, the field does not guess on every keystroke).
- **Code blocks as in Slack** (the person, 2026-11-25): typing ` ``` ` inserts the closing fence and puts the caret
  in the block between them (one undo step takes the closing fence back out). Inside a block Enter is a newline; Enter
  on an empty last line of the block removes that line and puts the caret after the block. Elsewhere the keys stay as
  they are (composer: Enter sends, Shift+Enter newline; comment: ⌘/Ctrl+Enter sends). ⌘/Ctrl+Enter keeps its meaning
  in a block too (the composer's forced send); there is no new key (builder's call): to send normally, leave the block,
  then Enter. Paste and dictation never insert a closing fence: only typing ` ``` ` does.
- **Paste:** plain text only, inserted as is.
- **The seam:** `ComposerField.field` (`web/src/core/sdk/composerField.ts`) stops being a textarea ref and becomes a
  small field interface the pickers and helpers use: the text, the selection, replace a range and place the caret, the
  caret's screen rectangle, focus, and change and selection events. `insertText.ts`, `autosize.ts`, the pickers,
  `usePromptRecall`, `useComposerKeys`, `EmojiMenu`, the attachments paste, the composer's `composerField()` and the
  callers of `ComposerService.field()` (`ComposerAttachments.tsx`, `SessionPicker.tsx`) move to it. CodeMirror's
  default keys that clash with the field's own (Alt+↑/↓, Mod-Enter) are left out. No textarea shim that imitates `selectionStart` and `value`.
- **Ids and roles stay:** the composer keeps `id="composer-input"`; both fields stay `role="textbox"` with their
  current accessible names and placeholders, so tests and the keymap find them as before.
- **Tests:** unit tests and e2e specs that drive the textarea move to the field interface or to role-based queries;
  new unit tests cover hiding and showing marks by caret position and Enter inside a code block.

## Left to the builder

- The field interface's exact names and how React state (`setDraft`) stays in sync with the editor.
- How the view plugin limits re-decoration to the visible range and changed lines.
- Styling details within the existing theme tokens (block background, code font, link colour).
- Whether jsdom covers the unit tests or a few move to e2e where layout is needed (caret rectangle).
