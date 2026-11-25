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
 * Enter in a block's body: a newline; on an empty last line after some code, it leaves the block (the line goes, the
 * caret after the block). Anywhere else Enter is the host's (the composer sends).
 */
export function enterInBlock(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const block = blockAt(state, sel.head);
  if (!block) return false;
  const first = state.doc.lineAt(block.from), last = state.doc.lineAt(block.to);
  const line = state.doc.lineAt(sel.head);
  if (line.number === first.number || (closed(block) && line.number >= last.number)) return false;
  const leaves = closed(block) && line.length === 0 && line.number === last.number - 1 && line.number - 1 > first.number;
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

const plainKey = (e: KeyboardEvent) => !e.altKey && !e.ctrlKey && !e.metaKey;

/** Code blocks and lists as in Slack, above the host's keys (`newline`: the key that makes a line in this field). */
export function blockKeys(newline: 'Enter' | 'Shift-Enter'): Extension {
  return [
    EditorView.inputHandler.of((view, from, to, text) => closeFence(view, from, to, text)),
    // a key event, not a keymap: a keymap runs during an IME composition too, where Enter picks a candidate
    Prec.highest(EditorView.domEventHandlers({
      keydown(e, view) {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || !plainKey(e)) return false;
        const done = (!e.shiftKey && enterInBlock(view)) || (e.shiftKey === (newline === 'Shift-Enter') && newlineContinue(view));
        if (done) e.preventDefault();
        return done;
      },
    })),
  ];
}
