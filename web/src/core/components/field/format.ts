import { syntaxTree } from '@codemirror/language';
import { Prec, type ChangeSpec, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { closed } from './blockKeys.ts';

export type Inline = '**' | '*' | '~~' | '`';

/** the run of `ch` that ends at `to` (`dir` -1) or starts at `from` (1) */
function run(text: string, at: number, ch: string, dir: 1 | -1): number {
  let n = 0;
  for (let i = dir > 0 ? at : at - 1; text[i] === ch; i += dir) n++;
  return n;
}

const SPAN: Record<Inline, { node: string; mark: string }> = {
  '**': { node: 'StrongEmphasis', mark: 'EmphasisMark' },
  '*': { node: 'Emphasis', mark: 'EmphasisMark' },
  '~~': { node: 'Strikethrough', mark: 'StrikethroughMark' },
  '`': { node: 'InlineCode', mark: 'CodeMark' },
};

/**
 * The span of `mark`'s kind that is the selection: its marks just outside it or just inside it, with nothing but other
 * spans' marks between (`***w***` with `w` selected is italic). A selection over two spans is neither.
 */
function spanOf(state: EditorState, from: number, to: number, mark: Inline): { open: SyntaxNode; close: SyntaxNode } | null {
  const { node, mark: markName } = SPAN[mark];
  const onlyMarks = (a: number, b: number) => /^[*_~`]*$/.test(state.sliceDoc(Math.min(a, b), Math.max(a, b)));
  let found: { open: SyntaxNode; close: SyntaxNode } | null = null;
  syntaxTree(state).iterate({
    from: Math.max(0, from - 1), to: Math.min(state.doc.length, to + 1),
    enter: (n) => {
      if (found || n.name !== node) return;
      const marks = n.node.getChildren(markName);
      const open = marks[0], close = marks.at(-1);
      if (marks.length > 1 && onlyMarks(from, open!.to) && onlyMarks(to, close!.from)) found = { open: open!, close: close! };
    },
  });
  return found;
}

/**
 * Bold, italic, strikethrough or code on the selection (issue 727): wrapped in the mark and kept selected, or, when it is
 * such a span already, unwrapped. With no selection a pair goes in, the caret inside; again, the empty pair goes.
 */
export function toggleInline(view: EditorView, mark: Inline): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const len = mark.length;
  const span = spanOf(state, from, to, mark);
  const empty = from === to && Math.min(run(state.doc.toString(), from, mark[0]!, -1), run(state.doc.toString(), to, mark[0]!, 1)) === len;
  if (span || empty) {
    const changes = state.changes(span ? [{ from: span.open.from, to: span.open.to }, { from: span.close.from, to: span.close.to }] : [{ from: from - len, to: from }, { from: to, to: to + len }]);
    view.dispatch({ changes, selection: { anchor: changes.mapPos(from, 1), head: changes.mapPos(to, -1) }, userEvent: 'input.format' });
  } else {
    view.dispatch({ changes: [{ from, insert: mark }, { from: to, insert: mark }], selection: { anchor: from + len, head: to + len }, userEvent: 'input.format' });
  }
  return true;
}

/** The selection as a link's text, the caret where its address goes. */
export function link(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: [{ from, insert: '[' }, { from: to, insert: ']()' }], selection: { anchor: to + 3 }, userEvent: 'input.format' });
  return true;
}

/**
 * A list's or a quote's mark on every line of the selection that has text, after its indent; off them all (a numbered
 * list's too) when every such line has one. A selection that only reaches the next line's start leaves that line.
 */
export function toggleLines(view: EditorView, prefix: '- ' | '> '): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const MARK = prefix === '- ' ? /^( *)(?:[-*+]|\d+[.)]) / : /^( *)> ?/;
  let last = state.doc.lineAt(to).number;
  if (to > from && to === state.doc.line(last).from) last--;
  const lines = [];
  for (let n = state.doc.lineAt(from).number; n <= last; n++) if (state.doc.line(n).text.trim()) lines.push(state.doc.line(n));
  const off = lines.every((l) => MARK.test(l.text));
  view.dispatch({
    changes: lines.flatMap((l): ChangeSpec[] => {
      const m = MARK.exec(l.text);
      if (off) return [{ from: l.from + m![1]!.length, to: l.from + m![0].length }];
      return m ? [] : [{ from: l.from + l.text.match(/^ */)![0].length, insert: prefix }];
    }),
    userEvent: 'input.format',
  });
  return true;
}

/** The selected lines fenced as a code block; a selection within one block, the fences selected too, unfences it. */
export function codeBlock(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  let block: SyntaxNode | null = null;
  syntaxTree(state).iterate({ from, to, enter: (n) => { if (!block && n.name === 'FencedCode' && n.from <= from && n.to >= to) block = n.node; } });
  if (block) {
    const b: SyntaxNode = block;
    const first = state.doc.lineAt(b.from), last = state.doc.lineAt(b.to);
    view.dispatch({
      changes: [{ from: first.from, to: Math.min(first.to + 1, state.doc.length) }, ...(closed(b) ? [{ from: last.from - 1, to: last.to }] : [])],
      userEvent: 'input.format',
    });
    return true;
  }
  const start = state.doc.lineAt(from), end = state.doc.lineAt(to);
  view.dispatch({
    changes: [{ from: start.from, insert: '```\n' }, { from: end.to, insert: '\n```' }],
    selection: { anchor: start.from + 4, head: end.to + 4 },
    userEvent: 'input.format',
  });
  return true;
}

/** The format keys, named in the format bar's tooltips. */
export const FORMAT_KEYS = { bold: 'Mod-b', italic: 'Mod-i', strike: 'Mod-Shift-x', code: 'Mod-e', link: 'Mod-k' } as const;

export const formatting: Extension = Prec.high(keymap.of([
  { key: FORMAT_KEYS.bold, run: (v) => toggleInline(v, '**') },
  { key: FORMAT_KEYS.italic, run: (v) => toggleInline(v, '*') },
  { key: FORMAT_KEYS.strike, run: (v) => toggleInline(v, '~~') },
  { key: FORMAT_KEYS.code, run: (v) => toggleInline(v, '`') },
  { key: FORMAT_KEYS.link, run: link },
]));
