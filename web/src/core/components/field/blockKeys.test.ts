import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, expect, it } from 'vitest';
import { blockKeys, closeFence, enterInBlock, newlineContinue } from './blockKeys.ts';

let view: EditorView;
afterEach(() => view?.destroy());

function open(doc: string, caret = doc.length) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: EditorSelection.cursor(caret), extensions: [history(), markdown({ base: markdownLanguage }), blockKeys('Shift-Enter')] }),
  });
  return view;
}
const text = () => view.state.doc.toString();
const caret = () => view.state.selection.main.head;
/** what typing one character does: the input handlers first, else the plain insert */
function type(ch: string) {
  const { from, to } = view.state.selection.main;
  if (!closeFence(view, from, to, ch)) view.dispatch({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: 'input.type' });
}

it('typing the third backtick at a line start closes the fence', () => {
  open('``');
  type('`');
  expect(text()).toBe('```\n\n```');
  expect(caret()).toBe(4);
  undo(view);
  expect(text()).toBe('```');
});

it('the closing fence of an open block is not closed again', () => {
  open('```\nab\n``');
  type('`');
  expect(text()).toBe('```\nab\n```');
});

it('a pasted fence is not closed', () => {
  open('');
  view.dispatch({ changes: { from: 0, insert: '```' }, userEvent: 'input.paste' });
  expect(text()).toBe('```');
});

it('Enter inside a block is a newline', () => {
  open('```\nab\n```', 6);
  expect(enterInBlock(view)).toBe(true);
  expect(text()).toBe('```\nab\n\n```');
});

it('Enter on an empty last line leaves the block', () => {
  open('```\nab\n\n```', 7);
  expect(enterInBlock(view)).toBe(true);
  expect(text()).toBe('```\nab\n```\n');
  expect(caret()).toBe(text().length);
});

it('Enter on the empty line of a new block is a newline', () => {
  open('```\n\n```', 4);
  expect(enterInBlock(view)).toBe(true);
  expect(text()).toBe('```\n\n\n```');
});

it('Enter outside a block is left to the host', () => {
  open('hi');
  expect(enterInBlock(view)).toBe(false);
});

it('Enter while composing is left alone', () => {
  open('```\nab\n```', 6);
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
  expect(text()).toBe('```\nab\n```');
});

it('the newline key continues a list and ends it on an empty item', () => {
  open('- a');
  newlineContinue(view);
  expect(text()).toBe('- a\n- ');
  newlineContinue(view);
  expect(text()).toBe('- a\n');
});

it('Enter on the opening fence of a block goes into the block', () => {
  open('```js\nlet a\n```', 5);
  expect(enterInBlock(view)).toBe(true);
  expect(text()).toBe('```js\nlet a\n```');
  expect(caret()).toBe(6);
});

it('Enter in a fence that never closes (pasted) is the host\'s', () => {
  open('```\nlet a', 9);
  expect(enterInBlock(view)).toBe(false);
});
