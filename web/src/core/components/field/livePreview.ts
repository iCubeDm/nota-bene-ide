import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import hljs from 'highlight.js';
import '../markdown/hljs.css';

type Span = [number, number];
export interface Preview {
  /** text that does not show */
  hide: Span[];
  /** a list's mark drawn as its bullet or its number (`label`) */
  markers: { from: number; to: number; label: string; cls: string }[];
  marks: { from: number; to: number; cls: string }[];
  /** `level`: a list item's nesting */
  lines: { at: number; cls: string; level?: number }[];
}

const SPANS: Record<string, { cls: string; marks: string[] }> = {
  StrongEmphasis: { cls: 'nb-md-strong', marks: ['EmphasisMark'] },
  Emphasis: { cls: 'nb-md-em', marks: ['EmphasisMark'] },
  Strikethrough: { cls: 'nb-md-strike', marks: ['StrikethroughMark'] },
  InlineCode: { cls: 'nb-md-code', marks: ['CodeMark'] },
};

/**
 * What the field draws over the markdown in `visible` (issue 724): the marks of a span hide unless the caret or the
 * selection touches the span, a fence hides unless the caret is on its line. The text itself is never changed.
 */
export function previewRanges(state: EditorState, visible: readonly { from: number; to: number }[]): Preview {
  const p: Preview = { hide: [], markers: [], marks: [], lines: [] };
  const sel = state.selection.ranges;
  const touched = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  const tree = syntaxTree(state);
  for (const { from, to } of visible) {
    tree.iterate({
      from, to,
      enter: (n) => {
        const span = SPANS[n.name];
        if (span) {
          const kids = children(n.node, span.marks);
          if (kids.length < 2) return;
          const open = kids[0]!, close = kids[kids.length - 1]!;
          p.marks.push({ from: open.to, to: close.from, cls: span.cls });
          if (!touched(n.from, n.to)) for (const k of kids) p.hide.push([k.from, k.to]);
          return false;
        }
        if (n.name === 'Link') return link(n.node, p, touched(n.from, n.to));
        if (n.name === 'FencedCode') return fenced(state, n.node, p, touched);
        if (n.name === 'ListItem') item(state, n.node, p);
        if (n.name === 'ListMark') {
          const end = Math.min(n.to + 1, state.doc.lineAt(n.from).to);
          const list = n.node.parent?.parent;
          const mark = state.sliceDoc(n.from, n.to);
          if (list?.name === 'BulletList' && /^[-*+]$/.test(mark)) p.markers.push({ from: n.from, to: end, label: '•', cls: 'nb-md-bullet' });
          if (list?.name === 'OrderedList') p.markers.push({ from: n.from, to: end, label: number(list, mark), cls: 'nb-md-num' });
        }
        if (n.name === 'QuoteMark') {
          const line = state.doc.lineAt(n.from);
          p.lines.push({ at: line.from, cls: 'nb-md-quote' });
          p.hide.push([n.from, Math.min(n.to + (state.sliceDoc(n.to, n.to + 1) === ' ' ? 1 : 0), line.to)]);
        }
        return undefined;
      },
    });
  }
  pending(state, p);
  const order = (a: Span, b: Span) => a[0] - b[0];
  p.hide.sort(order);
  return p;
}

/** A list item's line: a hanging item at its nesting level, the spaces that nest it hidden (the level draws them). */
function item(state: EditorState, node: SyntaxNode, p: Preview): void {
  let level = 0;
  for (let a = node.parent; a; a = a.parent) if (a.name === 'ListItem') level++;
  const line = state.doc.lineAt(node.from);
  p.lines.push({ at: line.from, cls: 'nb-md-item', level });
  if (node.from > line.from) p.hide.push([line.from, node.from]);
}

/** an item's number as the chat draws it (markdown.css): 1. at the top, a. in a numbered list, i. deeper */
function number(list: SyntaxNode, mark: string): string {
  let depth = 0;
  for (let a = list.parent; a; a = a.parent) if (a.name === 'OrderedList') depth++;
  let n = parseInt(mark, 10);
  const delim = mark.slice(-1);
  if (depth === 0 || n < 1) return mark;
  if (depth === 1) {
    let s = '';
    for (; n > 0; n = Math.floor(n / 26)) s = String.fromCharCode(97 + (--n % 26)) + s;
    return s + delim;
  }
  let s = '';
  for (const [v, r] of ROMAN) for (; n >= v; n -= v) s += r;
  return s + delim;
}
const ROMAN: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

const PENDING: [RegExp, string][] = [[/~~/g, 'nb-md-strike'], [/\*\*|__/g, 'nb-md-strong'], [/\*|(?<!\w)_|_(?!\w)/g, 'nb-md-em']];

/**
 * Format as you type (issue 727): on the caret's line, a mark opened and not yet closed formats what follows it up to the
 * caret. A mark is open when its kind comes an odd number of times before the caret and the last is followed by a word.
 */
function pending(state: EditorState, p: Preview): void {
  const caret = state.selection.main.head;
  const line = state.doc.lineAt(caret);
  const tree = syntaxTree(state);
  if (tree.resolveInner(caret, -1).parent?.name === 'FencedCode') return;
  // a list's `* ` is no mark
  let text = line.text.slice(0, caret - line.from).replace(/^ *(?:[-*+]|\d+[.)]) /, (m) => ' '.repeat(m.length));
  const open = (re: RegExp, cls: string): boolean => {
    const hits = [...text.matchAll(re)];
    const last = hits.at(-1);
    if (hits.length % 2 === 0 || !last) return false;
    const from = last.index + last[0].length;
    if (from >= text.length || /\s/.test(text[from]!)) return false;
    // a mark the parser already paired (its close after the caret) is drawn as its span
    for (let n: SyntaxNode | null = tree.resolveInner(line.from + from, 1); n; n = n.parent) if (n.name in SPANS) return false;
    p.marks.push({ from: line.from + from, to: caret, cls });
    return true;
  };
  if (open(/`/g, 'nb-md-code')) return; // inside code, nothing else is a mark
  text = text.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
  for (const [re, cls] of PENDING) {
    open(re, cls);
    text = text.replace(re, (m) => ' '.repeat(m.length)); // `**` is no `*` to the next kind
  }
}

const children = (node: SyntaxNode, names: string[]): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (names.includes(c.name)) out.push(c);
  return out;
};

/** `[text](url)`: the text shows as a link, the brackets and the URL hide. */
function link(node: SyntaxNode, p: Preview, inside: boolean): false {
  const marks = children(node, ['LinkMark']);
  if (marks.length < 2) return false;
  const textEnd = marks[1]!.from;
  p.marks.push({ from: marks[0]!.to, to: textEnd, cls: 'nb-md-link' });
  if (!inside) p.hide.push([marks[0]!.from, marks[0]!.to], [textEnd, node.to]);
  return false;
}

/**
 * A fenced block, drawn as the chat draws one: its lines one box (the first and the last close it), a fence off the caret
 * a thin edge, the code highlighted by its language or, with none, by a guess.
 */
function fenced(state: EditorState, node: SyntaxNode, p: Preview, touched: (from: number, to: number) => boolean): false {
  const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
  for (let l = first.number; l <= last.number; l++) p.lines.push({ at: state.doc.line(l).from, cls: 'nb-md-block' });
  p.lines.push({ at: first.from, cls: 'nb-md-top' }, { at: last.from, cls: 'nb-md-bottom' });
  const marks = children(node, ['CodeMark']);
  const fences = [first, ...(marks.length > 1 ? [last] : [])];
  for (const line of fences) {
    if (touched(line.from, line.to)) continue;
    p.lines.push({ at: line.from, cls: 'nb-md-fence' });
    if (line.to > line.from) p.hide.push([line.from, line.to]);
  }
  const info = children(node, ['CodeInfo'])[0];
  const text = children(node, ['CodeText'])[0];
  const lang = info ? state.sliceDoc(info.from, info.to).trim() : '';
  if (text && (!lang || hljs.getLanguage(lang))) {
    for (const [from, to, cls] of highlight(state.sliceDoc(text.from, text.to), lang)) p.marks.push({ from: text.from + from, to: text.from + to, cls });
  }
  return false;
}

// the languages a message's code is likely in: a guess among all of highlight.js's takes ~20 ms a keystroke, these ~3
const LIKELY = ['javascript', 'typescript', 'python', 'bash', 'json', 'yaml', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'css', 'xml', 'sql', 'diff', 'ruby', 'php', 'dart'];

/** the language of code with none named, guessed from its start (a long block costs no more to guess than a short one) */
const guess = (code: string): string | undefined => hljs.highlightAuto(code.slice(0, 600), LIKELY).language;

/** highlighted code by its language and text: typing elsewhere or moving the caret does not highlight it again */
const highlighted = new Map<string, [number, number, string][]>();
const KEEP = 32;

/** highlight.js's spans as offsets in `code`: its HTML walked for the text each class covers. */
function highlight(code: string, language: string): [number, number, string][] {
  const key = `${language}\n${code}`;
  const known = highlighted.get(key);
  if (known) return known;
  const lang = language || guess(code);
  if (!lang) return [];
  const box = document.createElement('div');
  box.innerHTML = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  const out: [number, number, string][] = [];
  let pos = 0;
  const walk = (n: Node, cls: string[]) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = n.textContent!.length;
      if (cls.length && len) out.push([pos, pos + len, cls.join(' ')]);
      pos += len;
      return;
    }
    const own = n instanceof HTMLElement && n.className ? [...cls, n.className] : cls;
    n.childNodes.forEach((c) => walk(c, own));
  };
  walk(box, []);
  if (highlighted.size >= KEEP) highlighted.delete(highlighted.keys().next().value!);
  highlighted.set(key, out);
  return out;
}

class Marker extends WidgetType {
  readonly label: string;
  readonly cls: string;
  constructor(label: string, cls: string) { super(); this.label = label; this.cls = cls; }
  eq(o: Marker) { return o.label === this.label && o.cls === this.cls; }
  toDOM() {
    const s = document.createElement('span');
    s.className = this.cls;
    s.textContent = this.label;
    return s;
  }
}
const hidden = Decoration.replace({});

function build(view: EditorView): { all: DecorationSet; atoms: DecorationSet } {
  const p = previewRanges(view.state, view.visibleRanges);
  const atoms = p.markers.map((m) => Decoration.replace({ widget: new Marker(m.label, m.cls) }).range(m.from, m.to));
  const all: Range<Decoration>[] = [
    ...p.lines.map((l) => Decoration.line({ class: l.cls, ...(l.level === undefined ? {} : { attributes: { style: `--nb-level: ${l.level}` } }) }).range(l.at)),
    ...p.marks.filter((m) => m.to > m.from).map((m) => Decoration.mark({ class: m.cls }).range(m.from, m.to)),
    ...p.hide.filter(([a, b]) => b > a).map(([a, b]) => hidden.range(a, b)),
    ...atoms,
  ];
  return { all: Decoration.set(all, true), atoms: Decoration.set(atoms, true) };
}

const plugin = ViewPlugin.fromClass(class {
  all: DecorationSet;
  atoms: DecorationSet;
  constructor(view: EditorView) { ({ all: this.all, atoms: this.atoms } = build(view)); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) ({ all: this.all, atoms: this.atoms } = build(u.view));
  }
}, { decorations: (v) => v.all });

const look = EditorView.theme({
  '.nb-md-strong': { fontWeight: '600' },
  '.nb-md-em': { fontStyle: 'italic' },
  '.nb-md-strike': { textDecoration: 'line-through' },
  // the chat's look (markdown.css): its inline code and its block
  '.nb-md-code': { fontFamily: 'var(--font-mono)', fontSize: '0.75rem', background: 'var(--code-inline-bg)', color: 'var(--code-inline-fg)', borderRadius: '4px', padding: '1px 5px' },
  '.nb-md-link': { color: 'var(--link)', textDecoration: 'underline' },
  '.nb-md-block': {
    font: '12.5px/1.5 var(--font-mono)', background: 'var(--code-bg)',
    borderLeft: '1px solid var(--border-soft)', borderRight: '1px solid var(--border-soft)',
    paddingLeft: '12px !important', paddingRight: '12px !important',
  },
  '.nb-md-top': { borderTop: '1px solid var(--border-soft)', borderRadius: '8px 8px 0 0', paddingTop: '6px !important' },
  '.nb-md-bottom': { borderBottom: '1px solid var(--border-soft)', borderBottomLeftRadius: '8px', borderBottomRightRadius: '8px', paddingBottom: '6px !important' },
  '.nb-md-top.nb-md-bottom': { borderRadius: '8px' },
  // a fence off the caret: only the box's edge (its padding) shows
  '.nb-md-fence': { fontSize: '0', lineHeight: '0' },
  '.nb-md-quote': { borderLeft: '2px solid var(--border)', paddingLeft: '12px !important', color: 'var(--muted-fg)' },
  // an item hangs: its mark in a column of its own, the lines it wraps onto under its text, one column in per level
  '.nb-md-item': { paddingLeft: 'calc((var(--nb-level) + 1) * 1.5em) !important', textIndent: '-1.5em' },
  '.nb-md-bullet, .nb-md-num': { display: 'inline-block', minWidth: '1.5em', textIndent: '0', color: 'var(--muted-fg)' },
  '.nb-md-bullet': { textAlign: 'center' },
  // a number ends where the chat's does, a little before its text
  '.nb-md-num': { textAlign: 'right', paddingRight: '0.4em', boxSizing: 'border-box' },
});

/** Live markdown: the field's decorations, a list's mark as one unit for the caret, and their look. */
export const livePreview: Extension = [
  plugin,
  look,
  EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atoms ?? Decoration.none),
];
