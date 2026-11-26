import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, expect, it } from 'vitest';
import { blockKeys, closeFence, enterInBlock, indent, newlineContinue } from './blockKeys.ts';

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

it('Tab nests a list item under the one above, Shift+Tab takes it back out', () => {
  open('- a\n- b');
  expect(indent(view, 1)).toBe(true);
  expect(text()).toBe('- a\n  - b');
  expect(caret()).toBe(text().length);
  expect(indent(view, -1)).toBe(true);
  expect(text()).toBe('- a\n- b');
});

it('a numbered item nests under its number\'s width', () => {
  open('1. a\n2. b');
  expect(indent(view, 1)).toBe(true);
  expect(text()).toBe('1. a\n   1. b');
});

it('on an item with nowhere to go Tab and Shift+Tab are taken and change nothing; plain text is left to the host', () => {
  open('- a');
  expect(indent(view, 1)).toBe(true);
  expect(indent(view, -1)).toBe(true);
  expect(text()).toBe('- a');
  open('- a\n  - b\n    - ');
  expect(indent(view, 1)).toBe(true);
  expect(text()).toBe('- a\n  - b\n    - ');
  open('```\nab\n```', 5);
  expect(indent(view, -1)).toBe(true);
  open('hi');
  expect(indent(view, 1)).toBe(false);
});

it('Tab at the start of a code line puts the caret after the indent', () => {
  open('```\nmain() {\n\n}\n```', 13);
  expect(indent(view, 1)).toBe(true);
  expect(text()).toBe('```\nmain() {\n  \n}\n```');
  expect(caret()).toBe(15);
});

it('a numbered item nested starts its own list at 1, the list it left numbered on; out again, back in sequence', () => {
  open('1. a\n2. b\n3. c\n4. d', 12);
  expect(indent(view, 1)).toBe(true);
  expect(text()).toBe('1. a\n2. b\n   1. c\n3. d');
  expect(indent(view, -1)).toBe(true);
  expect(text()).toBe('1. a\n2. b\n3. c\n4. d');
  undo(view);
  expect(text()).toBe('1. a\n2. b\n   1. c\n3. d');
});

it('an item taken out of the middle of a nested list leaves the ones after it as its own list from 1', () => {
  open('1. a\n   1. b\n   2. c\n   3. d', 16);
  expect(indent(view, -1)).toBe(true);
  expect(text()).toBe('1. a\n   1. b\n2. c\n   1. d');
});

it('Tab in a code block indents its line, Shift+Tab takes the indent back', () => {
  open('```\nab\n```', 5);
  expect(indent(view, 1)).toBe(true);
  expect(text()).toBe('```\n  ab\n```');
  expect(indent(view, -1)).toBe(true);
  expect(text()).toBe('```\nab\n```');
});

it('the Tab key nests an item and is taken; on plain text it is left to the browser', () => {
  const tab = () => {
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(e);
    return e.defaultPrevented;
  };
  open('- a\n- b');
  expect(tab()).toBe(true);
  expect(text()).toBe('- a\n  - b');
  open('hi');
  expect(tab()).toBe(false);
});

it('Tab and Shift+Tab move an item with its children', () => {
  open('- a\n- b\n  - c', 7);
  expect(indent(view, 1)).toBe(true);
  expect(text()).toBe('- a\n  - b\n    - c');
  expect(indent(view, -1)).toBe(true);
  expect(text()).toBe('- a\n- b\n  - c');
});

it('an item nests over a blank line or a continuation line above it', () => {
  open('- a\n  more\n- b');
  expect(indent(view, 1)).toBe(true);
  expect(text()).toBe('- a\n  more\n  - b');
  open('- a\n\n- b');
  expect(indent(view, 1)).toBe(true);
  expect(text()).toBe('- a\n\n  - b');
});
