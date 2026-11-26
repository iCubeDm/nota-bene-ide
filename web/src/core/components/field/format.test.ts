import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, expect, it } from 'vitest';
import { codeBlock, formatting, link, toggleInline, toggleLines } from './format.ts';

let view: EditorView;
afterEach(() => view?.destroy());

/** `[` and `]` in `doc` mark the selection */
function open(doc: string) {
  const from = doc.indexOf('['), to = doc.indexOf(']') - 1;
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: doc.replace('[', '').replace(']', ''), selection: EditorSelection.range(from, to), extensions: [history(), markdown({ base: markdownLanguage }), formatting] }),
  });
}
/** the text with the selection marked back */
const shown = () => {
  const { from, to } = view.state.selection.main;
  const d = view.state.doc.toString();
  return d.slice(0, from) + '[' + d.slice(from, to) + ']' + d.slice(to);
};

it('wraps the selection in a mark and keeps it selected', () => {
  open('a [word] b');
  toggleInline(view, '**');
  expect(shown()).toBe('a **[word]** b');
});

it('takes the mark off a selection already wrapped, the selection with or without its marks', () => {
  open('a **[word]** b');
  toggleInline(view, '**');
  expect(shown()).toBe('a [word] b');
  open('a [**word**] b');
  toggleInline(view, '**');
  expect(shown()).toBe('a [word] b');
});

it('italic on a bold word adds its own mark rather than taking one of bold\'s', () => {
  open('**[w]**');
  toggleInline(view, '*');
  expect(shown()).toBe('***[w]***');
  toggleInline(view, '*');
  expect(shown()).toBe('**[w]**');
});

it('with no selection, a pair goes in with the caret inside; again, the empty pair goes', () => {
  open('a []');
  toggleInline(view, '~~');
  expect(shown()).toBe('a ~~[]~~');
  toggleInline(view, '~~');
  expect(shown()).toBe('a []');
});

it('a link: the text in brackets, the caret where the address goes', () => {
  open('see [docs] now');
  link(view);
  expect(shown()).toBe('see [docs]([]) now');
});

it('a list and a quote mark every selected line, and come off when all have them', () => {
  open('[a\nb]');
  toggleLines(view, '- ');
  expect(view.state.doc.toString()).toBe('- a\n- b');
  toggleLines(view, '- ');
  expect(view.state.doc.toString()).toBe('a\nb');
  open('x[]');
  toggleLines(view, '> ');
  expect(shown()).toBe('> x[]');
});

it('a code block fences the selected lines; inside a block it takes the fences off', () => {
  open('[let a\nlet b]');
  codeBlock(view);
  expect(view.state.doc.toString()).toBe('```\nlet a\nlet b\n```');
  codeBlock(view);
  expect(view.state.doc.toString()).toBe('let a\nlet b');
});

it('a code block on an empty line opens one with the caret inside', () => {
  open('[]');
  codeBlock(view);
  expect(shown()).toBe('```\n[]\n```');
});

it('a format is one undo step', () => {
  open('a [word] b');
  toggleInline(view, '**');
  undo(view);
  expect(view.state.doc.toString()).toBe('a word b');
});

it('the keys format: Mod-B bolds the selection', () => {
  open('a [word] b');
  const e = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(e);
  expect(shown()).toBe('a **[word]** b');
});

it('a selection over two spans is wrapped, never unwrapped by their outer marks', () => {
  open('[*a* and *b*]');
  toggleInline(view, '*');
  expect(view.state.doc.toString()).toBe('**a* and *b**');
  open('[`a` and `b`]');
  toggleInline(view, '`');
  expect(view.state.doc.toString()).toBe('``a` and `b``');
});

it('a whole block selected, from its opening fence, is unfenced; a ~~~ block too', () => {
  open('x\n[```\na\n```]');
  codeBlock(view);
  expect(view.state.doc.toString()).toBe('x\na');
  open('~~~\n[a]\n~~~');
  codeBlock(view);
  expect(view.state.doc.toString()).toBe('a');
});

it('the list button: a numbered list comes off, a nested one keeps its indent, blank lines and a line only reached stay', () => {
  open('[1. a\n2. b]');
  toggleLines(view, '- ');
  expect(view.state.doc.toString()).toBe('a\nb');
  open('[- a\n  - b]');
  toggleLines(view, '- ');
  expect(view.state.doc.toString()).toBe('a\n  b');
  open('[a\n\nb]');
  toggleLines(view, '- ');
  expect(view.state.doc.toString()).toBe('- a\n\n- b');
  open('[a\nb\n]c');
  toggleLines(view, '- ');
  expect(view.state.doc.toString()).toBe('- a\n- b\nc');
});
