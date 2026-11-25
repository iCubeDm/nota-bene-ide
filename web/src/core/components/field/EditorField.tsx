import { history, historyKeymap, insertNewline, standardKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type ClipboardEventHandler, type KeyboardEventHandler, type Ref } from 'react';
import { fieldOf, fromHost, type Field, type Listeners } from './field.ts';

// the host's keys own these: Enter sends (composer), Mod-Enter forces or sends; the newline key is the field's own below
const HOST_KEYS = new Set(['Enter', 'Mod-Enter', 'Shift-Enter']);
const BASE_KEYS = standardKeymap.filter((b) => !HOST_KEYS.has(b.key ?? ''));

const bare = EditorView.theme({
  '&': { background: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
  '.cm-content': { padding: '0', caretColor: 'currentColor' },
  '.cm-line': { padding: '0' },
});

/**
 * The message field (issue 724): a CodeMirror editor whose text is the markdown that is sent. `value` comes in from the
 * host (a draft, a recalled prompt) without an `onChange` back; what the person types goes out through `onChange`.
 */
export function EditorField({ fieldRef, id, value, onChange, onKeyDown, onPaste, readOnly, placeholder, ariaLabel, newline, className }: {
  fieldRef: Ref<Field | null>;
  id?: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  onPaste?: ClipboardEventHandler<HTMLElement>;
  readOnly?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /** the key that makes a new line: the composer's Enter sends, so its newline is Shift+Enter */
  newline: 'Enter' | 'Shift-Enter';
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const listeners = useRef<Listeners>(new Set());
  const change = useRef(onChange);
  change.current = onChange;
  const lock = useRef(new Compartment());

  useLayoutEffect(() => {
    const ext: Extension[] = [
      history(),
      markdown(),
      EditorView.lineWrapping,
      bare,
      keymap.of([{ key: newline, run: insertNewline }, ...historyKeymap, ...BASE_KEYS]),
      EditorView.contentAttributes.of({ role: 'textbox', 'aria-multiline': 'true', ...(id ? { id } : {}), ...(ariaLabel ? { 'aria-label': ariaLabel } : {}) }),
      placeholder ? placeholderExt(placeholder) : [],
      lock.current.of(locked(!!readOnly)),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged && !u.selectionSet) return;
        if (u.docChanged && !u.transactions.some((t) => t.annotation(fromHost))) change.current(u.state.doc.toString());
        for (const fn of listeners.current) fn({ doc: u.docChanged, selection: u.selectionSet });
      }),
    ];
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions: ext }) });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // one editor per mount: the value and the lock follow through the effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newline, id, ariaLabel, placeholder]);

  useImperativeHandle(fieldRef, () => fieldOf(view.current!, listeners.current), [newline, id, ariaLabel, placeholder]);

  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: value },
      selection: { anchor: value.length },
      annotations: [fromHost.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: lock.current.reconfigure(locked(!!readOnly)) });
  }, [readOnly]);

  return <div ref={host} onKeyDown={onKeyDown} onPaste={onPaste} className={className} />;
}

const locked = (on: boolean): Extension => [EditorState.readOnly.of(on), EditorView.editable.of(!on)];
