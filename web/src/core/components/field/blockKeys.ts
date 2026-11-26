import { insertNewline, isolateHistory } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { Prec, type EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

/** The fenced block around `pos`, if any. */
function blockAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) if (n.name === 'FencedCode') return n;
  return null;
}
const closed = (n: SyntaxNode) => n.getChildren('CodeMark').length > 1;

/**
 * Typing the third backtick of a line that holds only ` `` ` opens a block as Slack does (issue 724): the closing fence
 * goes in and the caret into the block, a separate undo step from the typed backtick. Only typing comes here, never a
 * paste or an insert of the app's.
 */
export function closeFence(view: EditorView, from: number, to: number, text: string): boolean {
  const { state } = view;
  const line = state.doc.lineAt(from);
  if (text !== '`' || from !== to || state.sliceDoc(line.from, from) !== '``' || to !== line.to) return false;
  if (blockAt(state, line.from) && line.from > blockAt(state, line.from)!.from) return false; // the close of an open block
  view.dispatch({ changes: { from, insert: '`' }, selection: { anchor: from + 1 }, userEvent: 'input.type' });
  view.dispatch({ changes: { from: from + 1, insert: '\n\n```' }, selection: { anchor: from + 2 }, annotations: isolateHistory.of('before') });
  return true;
}

/**
 * Enter in a closed block (the kind typing ` ``` ` makes): on the opening fence it goes into the block (after typing its
 * language), in the body it is a newline, on an empty last line after some code it leaves the block (the line goes, the
 * caret after the block). Anywhere else, a fence that never closes (pasted) included, Enter is the host's (it sends).
 */
export function enterInBlock(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const block = blockAt(state, sel.head);
  if (!block || !closed(block)) return false;
  const first = state.doc.lineAt(block.from), last = state.doc.lineAt(block.to);
  const line = state.doc.lineAt(sel.head);
  if (line.number >= last.number) return false;
  if (line.number === first.number) {
    view.dispatch({ selection: { anchor: first.to + 1 }, scrollIntoView: true });
    return true;
  }
  const leaves = line.length === 0 && line.number === last.number - 1 && line.number - 1 > first.number;
  if (!leaves) return insertNewline(view);
  const atEnd = last.to === state.doc.length;
  const after = last.to - (line.length + 1);
  view.dispatch({
    changes: [{ from: line.from - 1, to: line.to }, ...(atEnd ? [{ from: last.to, insert: '\n' }] : [])],
    selection: { anchor: after + 1 },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

/** The field's newline key: a list or quote goes on; on an empty item the mark goes and the list ends there. */
export function newlineContinue(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  if (state.selection.main.empty && /^\s*(?:[-*+]|\d+[.)]|>)\s*$/.test(line.text)) {
    view.dispatch({ changes: { from: line.from, to: line.to }, selection: { anchor: line.from }, userEvent: 'delete' });
    return true;
  }
  return insertNewlineContinueMarkup(view) || insertNewline(view);
}

const ITEM = /^( *)(?:[-*+]|\d+[.)]) +/;
const CODE_INDENT = '  ';

/**
 * Tab (`dir` 1) and Shift+Tab (-1) on the caret's line (issue 727): a list item nests under the item above, at that
 * item's text (so `1. ` nests by three), or goes back to its parent's level; a line in a code block gains or loses an
 * indent. Anything else, or an item with nowhere to go, is the host's (Tab leaves the field, Shift+Tab cycles the mode).
 */
export function indent(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const has = line.text.match(/^ */)![0].length;
  const block = blockAt(state, sel.head);
  const inBlock = block && line.from > block.from && (!closed(block) || line.number < state.doc.lineAt(block.to).number);
  const item = ITEM.exec(line.text);
  const to = inBlock ? Math.max(0, has + dir * CODE_INDENT.length)
    : item ? (dir > 0 ? nestUnder(state, line.number, has) : parentIndent(state, line.number, has))
    : null;
  if (to === null || to === has) return false;
  view.dispatch({ changes: { from: line.from, to: line.from + has, insert: ' '.repeat(to) }, userEvent: 'input.indent' });
  return true;
}

/** the text column of the nearest item above at the same level as `own`, else null */
function nestUnder(state: EditorState, n: number, own: number): number | null {
  for (let l = n - 1; l >= 1; l--) {
    const m = ITEM.exec(state.doc.line(l).text);
    if (!m) return null;
    if (m[1]!.length === own) return m[0].length;
    if (m[1]!.length < own) return null;
  }
  return null;
}

/** the indent of the item above that `own` is nested in, else null */
function parentIndent(state: EditorState, n: number, own: number): number | null {
  if (own === 0) return null;
  for (let l = n - 1; l >= 1; l--) {
    const m = ITEM.exec(state.doc.line(l).text);
    if (!m) break;
    if (m[1]!.length < own) return m[1]!.length;
  }
  return 0;
}

const plainKey = (e: KeyboardEvent) => !e.altKey && !e.ctrlKey && !e.metaKey;

/** Code blocks and lists as in Slack, above the host's keys (`newline`: the key that makes a line in this field). */
export function blockKeys(newline: 'Enter' | 'Shift-Enter'): Extension {
  return [
    EditorView.inputHandler.of((view, from, to, text) => closeFence(view, from, to, text)),
    // a key event, not a keymap: a keymap runs during an IME composition too, where Enter picks a candidate
    Prec.highest(EditorView.domEventHandlers({
      keydown(e, view) {
        if ((e.key !== 'Enter' && e.key !== 'Tab') || e.isComposing || e.keyCode === 229 || !plainKey(e)) return false;
        const done = e.key === 'Tab' ? indent(view, e.shiftKey ? -1 : 1)
          : (!e.shiftKey && enterInBlock(view)) || (e.shiftKey === (newline === 'Shift-Enter') && newlineContinue(view));
        if (done) e.preventDefault();
        return done;
      },
    })),
  ];
}
