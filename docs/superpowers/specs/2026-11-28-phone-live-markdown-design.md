# Live markdown in the phone's message field — design

Issue 726, the phone's half of issue 724 (web: `docs/superpowers/specs/2026-11-25-live-markdown-field-design.md`).

## Intent

The phone's message field (`mobile/app/lib/chat/message_field.dart`, used by the chat composer and the comment sheet)
reads like the web field while it is typed: ` ``` ` turns into a code block, `**bold**` looks bold, the marks get out
of the way. The text stays the markdown that is sent, saved as the shared draft and shown on the computer.

## Goals, non-goals, anti-goals

- Same rendered set and rules as the web field: fenced code blocks (highlighted by the fence's language), inline code,
  bold, italic, strikethrough, links (styled, not tappable), block quotes, bulleted and numbered lists. Headings and
  tables stay plain. A `!` draft renders nothing.
- Marks hide while the caret is outside their construct and show when the caret or selection touches it; a closing
  fence shows only while the caret is on it, an opening fence while the caret is in its block.
- Typing ` ``` ` at the start of a line inserts the closing fence and puts the caret inside. A newline on an empty last
  line of a block removes that line and puts the caret after the block. A newline in a list item or quote continues
  it; a newline on an empty item ends it, also when the keyboard sends it with its word (a correction, a suggestion,
  a voice "new line"). A pasted text goes in as is.
- Non-goals: a formatting toolbar; other phone inputs (search, rename, permission answers).
- Anti-goals: any change to the text itself (no document model); worse plain typing (IME, autocorrect, spellcheck,
  selection handles, the shared draft's minimal-diff apply).

## Approaches

1. **A `TextEditingController` that draws its own text** (`buildTextSpan`): the controller's text is the markdown; the
   span it builds has exactly the same characters at the same offsets, styled, with hidden marks drawn transparent
   and zero-width, and a list's `-`/`*` drawn as `•` (one character for one, as `obscureText` does). The block rules
   are a `TextInputFormatter` on the field. Nothing new in `pubspec.yaml`.
2. A rich editor package (super_editor, fleather, flutter_quill): a document model converted to markdown and back;
   the anti-goal the web rejected too.

**Picked: 1** (agent's call; the only one that keeps the text exact, as the person picked for the web).

## Decided

- One `MarkdownText extends TextEditingController` in `mobile/app/lib/chat/`, used by `DraftSync.text` and the comment
  sheet's field; `MessageField` adds the formatter. The parse is a small scanner over the text (lines, fences, inline
  spans), not the `markdown` package: that one gives no source offsets.
- Code blocks use the feed's `highlightSpans` (`lib/chat/code.dart`) and monospace with the code background
  (`c.muted`); the background is per line, not a full-width box (builder's call: a `TextField` has no block layout).
- The composing (IME) range keeps its underline; hiding never applies inside it.
- The opening fence (the language) shows while the caret is anywhere in its block: the phone has no ArrowUp (the
  web's way) to reach a hidden line.
- Enter on the phone is a newline everywhere (the keyboard's action); Send stays the button.

## Left to the builder

- How hidden marks are drawn zero-width (font size, letter spacing) so the caret and the selection handles stay
  usable next to them.
- Re-scan cost: the field holds a prompt, a full re-scan per build is fine unless measured otherwise.
