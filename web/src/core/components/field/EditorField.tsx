import { history, historyKeymap, standardKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Compartment, EditorState, Prec, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type MouseEvent, type Ref } from 'react';
import { draggedPaths, hasFiles } from '../../lib/drag.ts';
import { fieldOf, fromHost, type Field, type Listeners } from './field.ts';
import { blockKeys } from './blockKeys.ts';
import { livePreview } from './livePreview.ts';

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
export function EditorField({ fieldRef, id, value, onChange, onKeyDown, onPaste, readOnly, plain, placeholder, ariaLabel, newline, className }: {
  fieldRef: Ref<Field | null>;
  id?: string;
  value: string;
  onChange: (v: string) => void;
  /** the host's keys (send, the history), after the field's own block keys and before its editing keys: a key the host
   * prevents is done */
  onKeyDown?: (e: KeyboardEvent) => void;
  /** before the field's own paste: a paste it prevents (files) is not pasted as text */
  onPaste?: (e: ClipboardEvent) => void;
  readOnly?: boolean;
  /** shows the text as is (a shell command): no markdown drawn */
  plain?: boolean;
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
  const paste = useRef(onPaste);
  paste.current = onPaste;
  const keys = useRef(onKeyDown);
  keys.current = onKeyDown;
  const lock = useRef(new Compartment());
  const look = useRef(new Compartment());
  const naming = useRef(new Compartment());
  const names = (): Extension => named(id, ariaLabel, placeholder);

  useLayoutEffect(() => {
    const ext: Extension[] = [
      history(),
      markdown({ base: markdownLanguage }),
      EditorView.lineWrapping,
      bare,
      blockKeys(newline),
      // after the block keys (an Enter in a code block is theirs), before the keymap (↑ on the first line is the history's)
      Prec.highest(EditorView.domEventHandlers({ keydown: (e) => { if (!e.defaultPrevented) keys.current?.(e); return e.defaultPrevented; } })),
      keymap.of([...historyKeymap, ...BASE_KEYS]),
      naming.current.of(names()),
      Prec.highest(EditorView.domEventHandlers({
        paste: (e) => { paste.current?.(e); return e.defaultPrevented; },
        // files and the Files tree's paths are the host's drop (an attachment, a path at the caret), never text dropped in
        drop: (e) => hasFiles(e) || !!draggedPaths(e.dataTransfer),
      })),
      lock.current.of(locked(!!readOnly)),
      look.current.of(plain ? [] : livePreview),
      EditorView.updateListener.of((u) => {
        // the host's own value coming in is neither an edit nor something the pickers look at (a textarea's `input` was not either)
        if ((!u.docChanged && !u.selectionSet) || u.transactions.some((t) => t.annotation(fromHost))) return;
        if (u.docChanged) change.current(u.state.doc.toString());
        const pointer = u.transactions.some((t) => t.isUserEvent('select.pointer'));
        for (const fn of listeners.current) fn({ doc: u.docChanged, selection: u.selectionSet, pointer });
      }),
    ];
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions: ext }) });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // one editor per mount: the value, the names and the switches follow through the effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newline]);

  useImperativeHandle(fieldRef, () => fieldOf(view.current!, listeners.current), [newline]);

  useEffect(() => {
    view.current?.dispatch({ effects: naming.current.reconfigure(names()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ariaLabel, placeholder]);

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
    view.current?.dispatch({ effects: look.current.reconfigure(plain ? [] : livePreview) });
  }, [plain]);

  useEffect(() => {
    view.current?.dispatch({ effects: lock.current.reconfigure(locked(!!readOnly)) });
  }, [readOnly]);

  // a press on the padding around the text is a press in the field
  const toText = (e: MouseEvent) => {
    if (e.target !== host.current || !view.current) return;
    e.preventDefault();
    view.current.focus();
  };
  return <div ref={host} onMouseDown={toText} className={className} />;
}

/** The field's id, its name (the label, else the placeholder, as a textarea's) and its placeholder. */
const named = (id: string | undefined, label: string | undefined, placeholder: string | undefined): Extension => [
  EditorView.contentAttributes.of({
    role: 'textbox',
    'aria-multiline': 'true',
    ...(id ? { id } : {}),
    ...(label ?? placeholder ? { 'aria-label': (label ?? placeholder)! } : {}),
    ...(placeholder ? { 'aria-placeholder': placeholder } : {}),
  }),
  placeholder ? placeholderExt(placeholder) : [],
];

const locked = (on: boolean): Extension => [EditorState.readOnly.of(on), EditorView.editable.of(!on)];
