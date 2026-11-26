import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { blockAt } from './blockKeys.ts';

export type Inline = '**' | '*' | '~~' | '`';

/** the run of `ch` that ends at `to` (`dir` -1) or starts at `from` (1) */
function run(text: string, at: number, ch: string, dir: 1 | -1): number {
  let n = 0;
  for (let i = dir > 0 ? at : at - 1; text[i] === ch; i += dir) n++;
  return n;
}

/** whether runs of `n` mark characters on both sides carry `mark` (`***` is bold and italic, `**` no italic) */
const carries = (n: number, mark: Inline): boolean => (mark === '*' ? n % 2 === 1 : n >= mark.length);

/**
 * Bold, italic, strikethrough or code on the selection (issue 727): wrapped in the mark and kept selected, or, when the
 * mark already wraps it (around or inside the selection), unwrapped. With no selection a pair goes in, the caret inside.
 */
export function toggleInline(view: EditorView, mark: Inline): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const doc = state.doc.toString();
  const ch = mark[0]!;
  const len = mark.length;
  const around = Math.min(run(doc, from, ch, -1), run(doc, to, ch, 1));
  const inner = to - from >= 2 * len ? Math.min(run(doc, from, ch, 1), run(doc, to, ch, -1)) : 0;
  if (carries(around, mark)) {
    view.dispatch({ changes: [{ from: from - len, to: from }, { from: to, to: to + len }], selection: { anchor: from - len, head: to - len }, userEvent: 'input.format' });
  } else if (carries(inner, mark) && inner * 2 <= to - from) {
    view.dispatch({ changes: [{ from, to: from + len }, { from: to - len, to }], selection: { anchor: from, head: to - 2 * len }, userEvent: 'input.format' });
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

/** A list's or a quote's mark on every line of the selection; off them all when every line has it. */
export function toggleLines(view: EditorView, prefix: '- ' | '> '): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const lines = [];
  for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) lines.push(state.doc.line(n));
  const has = (text: string) => (prefix === '- ' ? /^[-*+] /.test(text) : text.startsWith(prefix));
  const off = lines.every((l) => has(l.text));
  view.dispatch({
    changes: lines.map((l) => (off ? { from: l.from, to: l.from + 2 } : has(l.text) ? { from: l.from } : { from: l.from, insert: prefix })),
    userEvent: 'input.format',
  });
  return true;
}

/** The selected lines fenced as a code block; inside a block, its fences taken off. */
export function codeBlock(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const block = blockAt(state, from);
  if (block && block === blockAt(state, to)) {
    const first = state.doc.lineAt(block.from), last = state.doc.lineAt(block.to);
    const closes = last.number > first.number && /^\s*```/.test(last.text);
    view.dispatch({
      changes: [{ from: first.from, to: Math.min(first.to + 1, state.doc.length) }, ...(closes ? [{ from: last.from - 1, to: last.to }] : [])],
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
