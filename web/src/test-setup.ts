import '@testing-library/jest-dom/vitest';
import { EditorView } from '@codemirror/view';

// jsdom has no layout: the message field (CodeMirror) measures text ranges, which jsdom's Range lacks
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= noRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

// Typing into the message field as a browser does: user-event edits a contenteditable's DOM itself, and jsdom drops a
// trailing space there. Its text input goes through the field instead (its input handlers first, as a keystroke would).
document.addEventListener('beforeinput', (e) => {
  const view = EditorView.findFromDOM(e.target as HTMLElement);
  const text = e.inputType === 'insertText' ? e.data : e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph' ? '\n' : null;
  if (!view || text === null || !view.state.facet(EditorView.editable)) return;
  e.preventDefault();
  const { from, to } = view.state.selection.main;
  const plain = () => view.state.update({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' });
  if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, text, plain))) view.dispatch(plain());
}, true);
