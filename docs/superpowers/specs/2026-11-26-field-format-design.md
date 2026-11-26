# The message field, round two (issue 727)

Follow-up to issue 724 after the user tried the live-markdown field. A small change: four parts of one module
(`web/src/core/components/field/`).

## What and why

The field drew markdown, but nested lists could not be made, numbered lists did not line up, a code block looked bare
next to the chat's, a span showed its format only once closed ("not responsive"), and every format had to be typed.

## Decided with the user

- **Tab / Shift+Tab** indent and outdent a list item, and a line in a code block. Elsewhere Tab leaves the field as before.
- **Lists line up.** Numbered items as bullets do: the number muted, a hanging indent; each nesting level one step in.
- **A code block looks like the chat's** (`markdown.css` `.md pre`): rounded, bordered, 12.5px mono. Its fence lines are
  thin off the caret, not empty bands. Highlighted without a language too (detected, as the chat does); the highlight is
  cached by its text, so moving the caret does not redo it.
- **Format as you type.** On the caret's line, an opening `**`, `__`, `*`, `_`, `~~` or `` ` `` followed by a word
  formats the text up to the caret before it is closed. The text is never changed: what is typed is sent.
- **A format bar over a selection** (the user's pick over a right-click menu, which would cost the system menu's
  spelling, and a fixed Slack-like row, which costs a line of height): bold, italic, strikethrough, code, link, code
  block, list, quote. Keys Mod-B, Mod-I, Mod-Shift-X, Mod-E, Mod-K, named in its tooltips; every string in all languages.

## Approaches

The bar as a CodeMirror tooltip over the selection (chosen: CodeMirror places it and keeps it in the field), against a
React popover anchored to the selection rectangle (a second positioning path next to the pickers'). A button toggles:
a selection already wrapped is unwrapped.

## Left to the builder

The icons; how a nesting level is drawn (the leading spaces hidden behind a padding); the cache's size; with no
selection, a key wraps an empty pair and puts the caret inside.
