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
  /** a `- ` or `* ` drawn as a bullet */
  bullets: Span[];
  marks: { from: number; to: number; cls: string }[];
  lines: { at: number; cls: string }[];
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
  const p: Preview = { hide: [], bullets: [], marks: [], lines: [] };
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
        if (n.name === 'ListMark' && /^[-*+]$/.test(state.sliceDoc(n.from, n.to)) && n.node.parent?.parent?.name === 'BulletList') {
          p.bullets.push([n.from, Math.min(n.to + 1, state.doc.lineAt(n.from).to)]);
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
  const order = (a: Span, b: Span) => a[0] - b[0];
  p.hide.sort(order);
  return p;
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

/** A fenced block: each line a block line, the fences hidden off the caret, the code highlighted by its language. */
function fenced(state: EditorState, node: SyntaxNode, p: Preview, touched: (from: number, to: number) => boolean): false {
  const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
  for (let l = first.number; l <= last.number; l++) p.lines.push({ at: state.doc.line(l).from, cls: 'nb-md-block' });
  const marks = children(node, ['CodeMark']);
  const fences = [first, ...(marks.length > 1 ? [last] : [])];
  for (const line of fences) if (!touched(line.from, line.to) && line.to > line.from) p.hide.push([line.from, line.to]);
  const info = children(node, ['CodeInfo'])[0];
  const text = children(node, ['CodeText'])[0];
  const lang = info && state.sliceDoc(info.from, info.to).trim();
  if (text && lang && hljs.getLanguage(lang)) highlight(state.sliceDoc(text.from, text.to), lang, text.from, p);
  return false;
}

/** highlight.js's spans as marks: its HTML walked for the text offsets each class covers. */
function highlight(code: string, language: string, at: number, p: Preview): void {
  const box = document.createElement('div');
  box.innerHTML = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  let pos = at;
  const walk = (n: Node, cls: string[]) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = n.textContent!.length;
      if (cls.length && len) p.marks.push({ from: pos, to: pos + len, cls: cls.join(' ') });
      pos += len;
      return;
    }
    const own = n instanceof HTMLElement && n.className ? [...cls, n.className] : cls;
    n.childNodes.forEach((c) => walk(c, own));
  };
  walk(box, []);
}

class Bullet extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'nb-md-bullet';
    s.textContent = '•';
    return s;
  }
}
const bullet = Decoration.replace({ widget: new Bullet() });
const hidden = Decoration.replace({});

function build(view: EditorView): { all: DecorationSet; atoms: DecorationSet } {
  const p = previewRanges(view.state, view.visibleRanges);
  const atoms = p.bullets.map(([a, b]) => bullet.range(a, b));
  const all: Range<Decoration>[] = [
    ...p.lines.map((l) => Decoration.line({ class: l.cls }).range(l.at)),
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
  '.nb-md-code': { fontFamily: 'var(--font-mono)', fontSize: '0.9em', background: 'var(--code-bg)', borderRadius: '4px', padding: '0 3px' },
  '.nb-md-link': { color: 'var(--primary)', textDecoration: 'underline' },
  '.nb-md-block': { fontFamily: 'var(--font-mono)', fontSize: '0.9em', background: 'var(--code-bg)', padding: '0 8px !important' },
  '.nb-md-quote': { borderLeft: '3px solid var(--border)', paddingLeft: '8px !important' },
  '.nb-md-bullet': { padding: '0 6px 0 2px' },
});

/** Live markdown: the field's decorations, a bullet as one unit for the caret, and their look. */
export const livePreview: Extension = [
  plugin,
  look,
  EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atoms ?? Decoration.none),
];
