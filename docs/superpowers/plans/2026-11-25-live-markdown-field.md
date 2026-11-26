# Live markdown in the message fields — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the chat composer and the comment popup render markdown as it is typed (marks hidden, code blocks as in Slack), while the text stays markdown.

**Architecture:** one CodeMirror 6 field replaces the textarea inside `MessageInput`. A view plugin decorates the markdown (Lezer tree) and hides marks outside the caret's construct; a small keymap and input handler give the Slack code-block behaviour. Everything that used the textarea moves to one `Field` interface exported from `@/sdk`.

**Tech Stack:** React 19, TypeScript, `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/lang-markdown`, `highlight.js` (already a dependency), Vitest + jsdom, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-25-live-markdown-field-design.md`

## Global Constraints

- The field's text is exactly what is sent, saved as a draft and recalled: no transformation on any path.
- Composer: Enter sends, Shift+Enter newline, ⌘/Ctrl+Enter forced send. Comment: ⌘/Ctrl+Enter sends, Enter newline.
- The composer keeps `id="composer-input"`; both fields stay `role="textbox"` with `aria-multiline="true"`, their accessible names and placeholders.
- Shell mode (a draft starting with `!`) renders nothing.
- Only typing ` ``` ` inserts a closing fence; paste, dictation, pickers and recall never do.
- No new user-visible strings are expected; any that appear go through `web/src/core/i18n` in all `LANGS`.
- Run vitest from the repo root: `npx vitest run web`. Test output through `rtk test …`.
- Commits: subject `gh-724: …`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. IME composition (Chinese, Japanese): Enter that confirms a candidate never sends and never leaves a code block. Test in Task 3.
2. Undo after a programmatic insert (dictation, a path drop, a picker): one ⌘Z takes back exactly that insert. Test in Task 1.
3. A draft swapped from outside (session switch, Tab suggestion, recall) replaces the text and puts the caret at its end without firing `onChange` back. Test in Task 1.
4. A long draft (2,000 lines with blocks) stays responsive: decorations are built for the visible ranges only. Test in Task 2 (decorations limited to `view.visibleRanges`).
5. A fence that never closes (pasted) renders as a block to the end and does not break the marks after it on the next close. Test in Task 2.

---

### Task 1: the `Field` and a plain CodeMirror field

**Files:**
- Modify: `web/package.json` (add the five `@codemirror/*` packages, exact versions)
- Create: `web/src/core/components/field/field.ts`
- Create: `web/src/core/components/field/EditorField.tsx`
- Test: `web/src/core/components/field/EditorField.test.tsx`

**Interfaces:**
- Produces, in `field.ts` and re-exported from `@/sdk`:
  ```ts
  export interface Field {
    readonly element: HTMLElement;            // the editable element (CodeMirror's contentDOM): focus, events, rect
    text(): string;
    selection(): { from: number; to: number };
    /** replaces [from, to) with `insert`, caret at `caret` (default: after the insert); one undo step; fires onUpdate */
    replace(from: number, to: number, insert: string, caret?: number): void;
    setCaret(pos: number): void;
    focus(opts?: FocusOptions): void;
    /** a change of the text or the selection made in the field; returns the unsubscribe */
    onUpdate(fn: (u: { doc: boolean; selection: boolean }) => void): () => void;
  }
  ```
- Produces `EditorField` props: `{ fieldRef: Ref<Field | null>; id?; value: string; onChange(v: string): void; onKeyDown?: KeyboardEventHandler<HTMLElement>; onPaste?: ClipboardEventHandler<HTMLElement>; readOnly?; placeholder?; ariaLabel?; plain?: boolean; newline: 'Enter' | 'Shift-Enter'; className?: string }`.

- [ ] **Step 1:** add the packages (`npm i -w web @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/lang-markdown --save-exact`).
- [ ] **Step 2: Write the failing tests** in `EditorField.test.tsx`:
  - `typing updates the value`: render with `value=""`, `field.replace(0, 0, 'hi')` → `onChange` called with `'hi'`.
  - `an outside value replaces the text and puts the caret at its end, without onChange`: rerender with `value="abc"` → `field.text() === 'abc'`, `field.selection()` is `{from: 3, to: 3}`, `onChange` not called.
  - `one undo takes back one replace`: `replace(0,0,'a')`, `replace(1,1,' path')`, run `undo(view)` → text `'a'`.
  - `the element is a labelled multiline textbox`: `getByRole('textbox', { name: 'Message' })` has `id="composer-input"`, `aria-multiline="true"`.
  - `readOnly refuses typing`: with `readOnly`, `EditorState.readOnly` is true.
- [ ] **Step 3: Run** `rtk test npx vitest run web/src/core/components/field` — FAIL (module missing).
- [ ] **Step 4: Implement** `EditorField`: one `EditorView` per mount; extensions `history()`, `markdown()`, `EditorView.lineWrapping`, `placeholder`, `contentAttributes` (`id`, `role`, `aria-label`, `aria-multiline`), a `Compartment` for `readOnly` and `plain`, an update listener that calls `onChange` only for user transactions (annotate outside syncs with a `Transaction.addToHistory.of(false)` plus an own annotation it skips). Keymap: `historyKeymap` and `standardKeymap` minus `Enter` and `Mod-Enter`; no `defaultKeymap` (its Alt-↑/↓ moves lines). React `onKeyDown`/`onPaste` attach to the wrapper `div` (events bubble from contentDOM). Height: no JS autosize; the scroller gets `max-h-[40vh] overflow-y-auto`. `field.ts` holds `fieldOf(view): Field`.
- [ ] **Step 5: Run** the same command — PASS.
- [ ] **Step 6: Commit** `gh-724: a CodeMirror message field behind one Field interface`.

### Task 2: live markdown decorations

**Files:**
- Create: `web/src/core/components/field/livePreview.ts`
- Test: `web/src/core/components/field/livePreview.test.ts`

**Interfaces:**
- Consumes: `EditorField`'s `plain` compartment (Task 1).
- Produces: `livePreview: Extension` (added by `EditorField` unless `plain`), and for tests `previewRanges(state: EditorState, visible: readonly {from:number; to:number}[]): { hide: [number, number][]; marks: { from: number; to: number; cls: string }[]; lines: { at: number; cls: string }[] }`.

- [ ] **Step 1: Write the failing tests** (state built with `EditorState.create({ doc, selection, extensions: [markdown()] })`, `visible = [{from: 0, to: doc.length}]`):
  - `**a** b`, caret 7 → `hide` `[[0,2],[3,5]]`, a mark `nb-md-strong` over `[2,3]`.
  - same doc, caret 3 → `hide` empty (caret inside the construct).
  - `` `x` and _y_ and ~~z~~ ``, caret at end → hides the backticks, `_`, `~~`; marks `nb-md-code`, `nb-md-em`, `nb-md-strike`.
  - `[site](https://example.com)`, caret at end → hides `[` and `](https://example.com)`, mark `nb-md-link` over `site`.
  - ` ```ts\nlet a\n``` `, caret at end of doc → both fence lines in `hide`, `lines` has `nb-md-block` on every line of the block; caret on line 1 → the opening fence is not hidden.
  - `- one\n> two`, caret at end → `- ` replaced by a bullet (in `hide`, widget `nb-md-bullet`), `> ` by a bar (`nb-md-quote` line class).
  - `` ```\nopen `` (no closing fence), caret at end → `lines` mark the rest as block; after appending `\n```\n**b**` the `**` are hidden.
  - only visible ranges: a 2,000-line doc with `visible = [{from: 0, to: 100}]` → no range starts beyond 100.
- [ ] **Step 2: Run** `rtk test npx vitest run web/src/core/components/field/livePreview.test.ts` — FAIL.
- [ ] **Step 3: Implement** `previewRanges` over `syntaxTree(state).iterate` within the visible ranges: node names `StrongEmphasis`, `Emphasis`, `Strikethrough`, `InlineCode`, `Link`, `FencedCode`, `ListMark`, `QuoteMark`, with `EmphasisMark`, `CodeMark`, `LinkMark`, `URL`, `CodeInfo` as the marks to hide; "inside" means the selection's head or any range touches `[node.from, node.to]` (fences: the fence's own line). `livePreview` is a `ViewPlugin` turning them into `Decoration.replace` / `mark` / `line`, rebuilt on doc, selection or viewport change. Code in a block with a `CodeInfo` language that `hljs.getLanguage` knows gets `hljs.highlight` classes as mark decorations (`hljs-*`, the feed's theme). Styles (`nb-md-*`) in the field's CSS, from existing theme tokens.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `gh-724: the field hides markdown marks outside the caret's construct`.

### Task 3: code blocks and lists as in Slack

**Files:**
- Create: `web/src/core/components/field/blockKeys.ts`
- Test: `web/src/core/components/field/blockKeys.test.ts`

**Interfaces:**
- Consumes: `EditorField`'s `newline` prop (Task 1).
- Produces: `blockKeys(newline: 'Enter' | 'Shift-Enter'): Extension` (highest precedence), and the commands `enterInBlock(view): boolean`, `newlineContinue(view): boolean`, plus the input handler `closeFence`.

- [ ] **Step 1: Write the failing tests** (an `EditorView` in jsdom, simulating typing through `view.dispatch` with `userEvent: 'input.type'` or the input handler directly):
  - `typing the third backtick at a line start closes the fence`: doc ` `` `, caret 2, type `` ` `` → doc `` "```\n\n```" ``, caret 4; one `undo` → ` ``` `.
  - `a pasted fence is not closed`: dispatch `userEvent: 'input.paste'` of ` ``` ` → doc ` ``` `.
  - `Enter inside a block is a newline`: doc `` "```\nab\n```" ``, caret 6, `enterInBlock` → true, doc `` "```\nab\n\n```" ``.
  - `Enter on an empty last line leaves the block`: doc `` "```\nab\n\n```" ``, caret 7 → doc `` "```\nab\n```\n" ``, caret at end.
  - `Enter outside a block is left to the host`: doc `hi`, `enterInBlock` → false.
  - `Enter while composing is left alone`: a keydown with `isComposing` inside a block → not handled.
  - `the newline key continues a list and ends it on an empty item`: `- a` + `newlineContinue` → `- a\n- `; again → `- a\n`.
- [ ] **Step 2: Run** `rtk test npx vitest run web/src/core/components/field/blockKeys.test.ts` — FAIL.
- [ ] **Step 3: Implement**: `closeFence` via `EditorView.inputHandler` (only when the inserted text is `` ` `` and the line before the caret is exactly ` `` `); `enterInBlock` finds `FencedCode` at the caret with `syntaxTree`; `newlineContinue` = `insertNewlineContinueMarkup` from `@codemirror/lang-markdown`, else `insertNewline`. Keymap: `Enter` → `enterInBlock`, and the `newline` key → `newlineContinue`; `Mod-Enter` is not bound. Wire into `EditorField`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `gh-724: code blocks close and leave as in Slack; lists continue`.

### Task 4: every caller moves to the Field

**Files:**
- Modify: `web/src/core/sdk/composerField.ts` (`field: RefObject<Field | null>`), `web/src/core/sdk/index.ts` (export `Field`, drop `autosize`/`useAutosize` if unused)
- Modify: `web/src/core/components/MessageInput.tsx` (`EditorField` in place of the textarea; `textareaRef` → `fieldRef`; `newline` prop from the host)
- Modify: `web/src/core/lib/insertText.ts` (`insertPaths(field: Field, paths)`; `setValueAndCaret` removed)
- Modify: `web/src/plugins/composer/{Composer.tsx,plugin.ts,commands.ts,useComposerKeys.ts,usePromptRecall.ts,MentionPicker.tsx,SlashPicker.tsx}`
- Modify: `web/src/plugins/comments/{CommentPopup.tsx,ShortcodePicker.tsx,EmojiMenu.tsx}`, `web/src/plugins/attachments/{plugin.ts,ComposerAttachments.tsx}`, `web/src/plugins/controls/SessionPicker.tsx`
- Trash: `web/src/core/lib/autosize.ts` and its test, once nothing imports them
- Test: the unit tests that drive the textarea (`grep -rl -E "composer-input|textarea|selectionStart|setSelectionRange" web/src --include='*.test.ts*'`)

**Interfaces:**
- Consumes: `Field`, `EditorField` (Task 1).
- Produces: `ComposerService.field(): Field | null`; `composerField(): Field | null`; `insertPaths(field: Field, paths: readonly string[]): void`; `ComposerKeys.ref: RefObject<Field | null>` and `KeyboardEvent<HTMLElement>`.

- [ ] **Step 1:** port the pickers: `input`/`click`/`selectionchange` listeners become one `field.onUpdate`; `document.activeElement === ta` becomes `field.element.contains(document.activeElement)`; `ta.value`/`selectionStart` become `field.text()`/`field.selection().from`; writes become `field.replace`. `blur` and window-capture `keydown` stay on `field.element`/`window`.
- [ ] **Step 2:** port the hosts (`Composer`, `CommentPopup`), `useComposerKeys` (`setCaret(suggestion.length)` after the draft lands), `usePromptRecall`, the attachments paste (`onPaste` on the wrapper; a paste with files calls `preventDefault`, which CodeMirror honours) and the `field()` callers. Composer passes `newline="Shift-Enter"`, the popup `newline="Enter"`; shell mode passes `plain`. The field's keymap runs on contentDOM before the event bubbles to the host's React `onKeyDown`, so `useComposerKeys` returns at once when `e.defaultPrevented` (an Enter the code block took must not also send); test: `Enter inside a code block does not send` in `Composer.test.tsx`.
- [ ] **Step 3:** port the unit tests to `getByRole('textbox')` and the `Field` (a test helper `typeIn(field, text)` in `web/src/core/testing` that calls `field.replace` at the caret with `userEvent: 'input.type'`).
- [ ] **Step 4: Run** `npx tsc -b` — exit 0; `rtk test npx vitest run web scripts` — exit 0.
- [ ] **Step 5: Commit** `gh-724: the message fields are the CodeMirror field`.

### Task 5: e2e, docs, full check

**Files:**
- Modify: the e2e specs that `fill`/`type` the composer or the popup (`grep -rl -E "composer-input|textarea" e2e`)
- Create: `e2e/live-markdown.spec.ts`
- Modify: `docs/guide.md` (the composer section: one paragraph on live markdown and code blocks)

- [ ] **Step 1: Write the e2e test** `live-markdown.spec.ts`: type `` ``` ``, `let a = 1`, Enter, Enter, `**done**`, Enter → the sent message's text in the scripted agent's input is exactly `` "```\nlet a = 1\n```\n**done**" ``; before sending, the field shows a `.nb-md-block` line and no visible `**`.
- [ ] **Step 2:** port the other specs: `fill` works on the contenteditable; replace `inputValue()` with `textContent` of `.cm-content` or the draft through the app.
- [ ] **Step 3: Run** `npm run build -w web` then `npm run e2e` (holds the full-suite lock, ports 4790–4795) — exit 0.
- [ ] **Step 4:** add the guide paragraph; commit `gh-724: e2e and the guide for live markdown`.
