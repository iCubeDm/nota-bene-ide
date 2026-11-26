import { insertNewline, isolateHistory } from '@codemirror/commands';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { Prec, type ChangeSpec, type EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

/** The fenced block around `pos`, if any. */
export function blockAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) if (n.name === 'FencedCode') return n;
  return null;
}
export const closed = (n: SyntaxNode) => n.getChildren('CodeMark').length > 1;

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
 * item's text (so `1. ` nests by three), or goes back to its parent's level, its children and its continued lines with
 * it, the numbered lists around it numbered again; a line in a code block gains or loses an indent, the caret past it.
 * On an item or in a block the key is the field's even with nowhere to go; anywhere else it is the host's (Tab leaves
 * the field, Shift+Tab cycles the mode).
 */
export function indent(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const has = lead(line.text);
  const block = blockAt(state, sel.head);
  const inBlock = block && line.from > block.from && (!closed(block) || line.number < state.doc.lineAt(block.to).number);
  if (!inBlock && !ITEM.test(line.text)) return false;
  const to = inBlock ? Math.max(0, has + dir * CODE_INDENT.length)
    : dir > 0 ? nestUnder(state, line.number, has) : parentIndent(state, line.number, has);
  if (to === null || to === has) return true;
  const moved = inBlock ? [line] : withChildren(state, line.number, has);
  const by = to - has;
  const shift = state.changes(moved.map((l) => (by > 0 ? { from: l.from, insert: ' '.repeat(by) } : { from: l.from, to: l.from + Math.min(-by, lead(l.text)) })));
  const changes = inBlock ? shift : shift.compose(renumber(state.update({ changes: shift }).state, line.number, moved.at(-1)!.number));
  view.dispatch({ changes, selection: state.selection.map(changes, 1), userEvent: 'input.indent' });
  return true;
}

/**
 * The numbered lists of the outermost list around line `n`, after lines `n`..`last` moved, numbered on from their first
 * item; a list the move began (its first item moved, or the first line after the moved ones) from 1.
 */
function renumber(state: EditorState, n: number, last: number) {
  const tree = ensureSyntaxTree(state, state.doc.length, 50);
  const line = state.doc.line(n);
  let top: SyntaxNode | null = null;
  for (let a = tree?.resolveInner(line.from + lead(line.text), 1) ?? null; a; a = a.parent) {
    if (a.name === 'BulletList' || a.name === 'OrderedList') top = a;
  }
  let next = last + 1;
  while (next <= state.doc.lines && blank(state.doc.line(next).text)) next++;
  const changes: ChangeSpec[] = [];
  if (tree && top) tree.iterate({
    from: top.from, to: top.to,
    enter: (list) => {
      if (list.name !== 'OrderedList' || list.from < top.from || list.to > top.to) return;
      // a mark is the number and its `.` or `)`
      const marks = list.node.getChildren('ListItem').map((i) => i.getChild('ListMark')!);
      const first = state.doc.lineAt(marks[0]!.from).number;
      let k = first >= n && first <= next ? 1 : Number(state.sliceDoc(marks[0]!.from, marks[0]!.to - 1));
      for (const m of marks) {
        const want = String(k++);
        if (state.sliceDoc(m.from, m.to - 1) !== want) changes.push({ from: m.from, to: m.to - 1, insert: want });
      }
    },
  });
  return state.changes(changes);
}

const lead = (text: string): number => text.match(/^ */)![0].length;
const blank = (text: string): boolean => !text.trim();

/** the item's line and the lines under it indented deeper (its children, its continued text), blank ones between them */
function withChildren(state: EditorState, n: number, own: number) {
  const out = [state.doc.line(n)];
  let end = n;
  for (let l = n + 1; l <= state.doc.lines; l++) {
    const text = state.doc.line(l).text;
    if (blank(text)) continue;
    if (lead(text) <= own) break;
    end = l;
  }
  for (let l = n + 1; l <= end; l++) if (!blank(state.doc.line(l).text)) out.push(state.doc.line(l));
  return out;
}

/** the text column of the nearest item above at the same level as `own` (blank, deeper and continued lines passed), else null */
function nestUnder(state: EditorState, n: number, own: number): number | null {
  for (let l = n - 1; l >= 1; l--) {
    const text = state.doc.line(l).text;
    if (blank(text)) continue;
    const m = ITEM.exec(text);
    if (m && m[1]!.length === own) return m[0].length;
    if (lead(text) <= own) return null;
  }
  return null;
}

/** the indent of the item above that `own` is nested in, else 0 */
function parentIndent(state: EditorState, n: number, own: number): number | null {
  if (own === 0) return null;
  for (let l = n - 1; l >= 1; l--) {
    const text = state.doc.line(l).text;
    if (blank(text)) continue;
    const m = ITEM.exec(text);
    if (m && m[1]!.length < own) return m[1]!.length;
    if (!m && lead(text) < own) break;
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
