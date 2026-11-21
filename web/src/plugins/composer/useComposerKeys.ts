import type { KeyboardEvent, RefObject } from 'react';
import { useAppDispatch } from '@/sdk';
import { setDraft } from './slice.ts';

export interface ComposerKeys {
  ref: RefObject<HTMLTextAreaElement | null>;
  /** the suggestion shown in the empty field, null when none is */
  suggestion: string | null;
  /** Shift+Tab: the next of the agent's modes, null when there is no other */
  pickNextMode: (() => void) | null;
  /** the question before a forced send interrupts the agent is open */
  askForce: boolean;
  setAskForce: (v: boolean) => void;
  stepHistory: (e: KeyboardEvent<HTMLTextAreaElement>, always: boolean) => boolean;
  submit: (force: boolean) => void;
}

/** The composer field's keys: Tab takes the suggestion, Shift+Tab the next mode, Esc, ↑/↓ the history, Enter sends. */
export function useComposerKeys({ ref, suggestion, pickNextMode, askForce, setAskForce, stepHistory, submit }: ComposerKeys) {
  const dispatch = useAppDispatch();
  return (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // an open @ / : / picker takes Tab at window capture and stops it, so this is only reached with no picker to serve
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.nativeEvent.isComposing && suggestion !== null) {
      e.preventDefault();
      dispatch(setDraft(suggestion));
      // the controlled value lands on the next render; put the caret after it
      requestAnimationFrame(() => ref.current?.setSelectionRange(suggestion.length, suggestion.length));
      return;
    }
    if (e.key === 'Tab' && e.shiftKey && !e.nativeEvent.isComposing && pickNextMode) {
      e.preventDefault();
      pickNextMode();
      return;
    }
    if (e.key === 'Escape' && askForce) {
      e.preventDefault(); // the document hotkeys skip it
      setAskForce(false);
      return;
    }
    // Alt+↑/↓ (Option on a Mac) always walk the history; an open / or @ list took the key at window capture before this
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing && stepHistory(e, e.altKey)) {
      e.preventDefault();
      return;
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const force = e.metaKey || e.ctrlKey;
    if (e.shiftKey && !force) return;
    e.preventDefault();
    submit(force);
  };
}
