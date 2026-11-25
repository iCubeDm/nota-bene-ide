import { isolateHistory } from '@codemirror/commands';
import { Annotation } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * A message field as its pickers, keys and hosts use it (issue 724): the text and the caret of a CodeMirror field, never
 * the editor itself. The text is the markdown that is sent.
 */
export interface Field {
  /** the editable element (CodeMirror's contentDOM): focus, events, its rectangle */
  readonly element: HTMLElement;
  text(): string;
  selection(): { from: number; to: number };
  /** replaces [from, to) with `insert`, the caret at `caret` (default: after the insert); one undo step */
  replace(from: number, to: number, insert: string, caret?: number): void;
  setCaret(pos: number): void;
  focus(opts?: FocusOptions): void;
  /** a change of the text or the selection; returns the unsubscribe */
  onUpdate(fn: (u: { doc: boolean; selection: boolean }) => void): () => void;
}

/** Marks a transaction that brings the host's value in: not the person's edit, so no `onChange` and no undo step. */
export const fromHost = Annotation.define<boolean>();

export type Listeners = Set<(u: { doc: boolean; selection: boolean }) => void>;

export function fieldOf(view: EditorView, listeners: Listeners): Field {
  return {
    element: view.contentDOM,
    text: () => view.state.doc.toString(),
    selection: () => ({ from: view.state.selection.main.from, to: view.state.selection.main.to }),
    replace(from, to, insert, caret = from + insert.length) {
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: caret },
        scrollIntoView: true,
        userEvent: 'input',
        annotations: isolateHistory.of('full'),
      });
    },
    setCaret: (pos) => view.dispatch({ selection: { anchor: pos }, scrollIntoView: true }),
    focus: (opts) => view.contentDOM.focus(opts),
    onUpdate(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
