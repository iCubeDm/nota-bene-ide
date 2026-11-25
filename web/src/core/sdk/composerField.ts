import { createContext, useContext, type RefObject } from 'react';
import type { Field } from '../components/field/field.ts';

/** The message field a `composer.pickers` part serves (issue 545): the composer's (`chat`) or a comment popup's. */
export interface ComposerField {
  kind: 'chat' | 'comment';
  field: RefObject<Field | null>;
}

/** Given by each host of a message field around its pickers. */
export const ComposerFieldContext = createContext<ComposerField | null>(null);

export function useComposerField(): ComposerField {
  const f = useContext(ComposerFieldContext);
  if (!f) throw new Error('useComposerField: outside a message field');
  return f;
}
