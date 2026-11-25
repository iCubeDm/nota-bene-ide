import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from 'react';
import type { PromptEntry } from '@nota-bene/shared';
import { useAppDispatch, type Field } from '@/sdk';
import { recallList } from './history.ts';
import { setDraft } from './slice.ts';

/**
 * ↑/↓ through the prompts sent before (newest first), and a prompt picked in the history list. `text` is the draft,
 * `ref` the field.
 */
export function usePromptRecall({ items, sid, text, ref }: { items: PromptEntry[]; sid: string | null; text: string; ref: RefObject<Field | null> }) {
  const dispatch = useAppDispatch();
  // `id` is the recalled one (null = not browsing), `stash` the draft it replaced (a list choice or a search makes one);
  // `query` is the text a search walk started from (null = the whole list is walked)
  const recall = useMemo(() => recallList(items), [items]);
  const recallRef = useRef(recall);
  recallRef.current = recall;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const browse = useRef<{ id: string | null; stash: string; query: string | null }>({ id: null, stash: '', query: null });
  useEffect(() => void (browse.current = { id: null, stash: '', query: null }), [sid]);
  // where the draft is in the list: the recalled entry (by id, so a list that grows under the walk keeps the place), else
  // the entry with that text (a repeat collapsed away); -1 = not browsing, the draft is no recalled prompt any more
  const walkList = (): PromptEntry[] => {
    const query = browse.current.query;
    if (query === null) return recallRef.current;
    const q = query.toLowerCase();
    // the typed text itself is no step: the first ↑ always changes the field
    return recallList(itemsRef.current.filter((x) => x.text !== query && x.text.toLowerCase().includes(q)));
  };
  const placeOf = (value: string): number => {
    const list = walkList();
    const b = browse.current;
    if (b.id === null) return -1;
    const at = list.findIndex((x) => x.id === b.id);
    if (at >= 0 && list[at]!.text === value) return at;
    return list.findIndex((x) => x.text === value);
  };
  // a send ends the walk
  const reset = () => void (browse.current = { id: null, stash: '', query: null });

  // true when the key was a history step. A walk starts from an empty field (the whole list) or from a single-line draft (the
  // prompts containing it; ↓ past the newest brings the draft back); it goes on while the draft is still exactly the recalled
  // prompt: any edit ends it. `always` (Alt+↑/↓) ignores the caret, a selection and a multi-line draft: a multi-line draft
  // is stashed and the whole list walked
  const stepHistory = (e: KeyboardEvent<HTMLElement>, always: boolean): boolean => {
    const el = ref.current;
    if (!el) return false;
    const b = browse.current;
    const { from, to } = el.selection();
    const value = el.text();
    let list = walkList();
    const at = placeOf(value);
    if (at < 0) { b.id = null; b.query = null; list = recallRef.current; }
    if (from !== to && !always) return false;
    const show = (to: number, draft: string) => {
      b.id = to >= 0 ? list[to]!.id : null;
      if (to < 0) b.query = null;
      dispatch(setDraft(draft));
      // the controlled value lands on the next render; the caret goes after it, unless typing changed the value meanwhile
      requestAnimationFrame(() => {
        const el = ref.current;
        if (el?.text() === draft) el.setCaret(draft.length);
      });
    };
    if (e.key === 'ArrowUp') {
      if (!list.length) return false;
      if (at < 0) {
        if (value === '') {
          b.stash = '';
          show(0, list[0]!.text);
          return true;
        }
        if (always) {
          // Alt: the whole list, newest first, whatever the draft (no search, a draft with no match too)
          b.query = null;
          b.stash = value;
          show(0, list[0]!.text);
          return true;
        }
        if (value.includes('\n')) return false;
        // typed text: the prompts that contain it; none = the field's own
        b.query = value;
        list = walkList();
        if (!list.length) { b.query = null; return false; }
        b.stash = value;
        show(0, list[0]!.text);
        return true;
      }
      if (!always && value.slice(0, from).includes('\n')) return false; // not on the first line: the field's own
      if (at + 1 < list.length) show(at + 1, list[at + 1]!.text);
      return true;
    }
    if (at < 0 || (!always && value.indexOf('\n', from) !== -1)) return false; // ↓ is the field's own unless on the last line of a recall
    if (at > 0) show(at - 1, list[at - 1]!.text);
    else show(-1, b.stash);
    return true;
  };

  // a prompt chosen in the history list becomes the draft; the draft it replaced is the stash, so ↓ brings it back
  const pickHistory = (picked: string) => {
    const at = placeOf(text);
    const entry = recallRef.current.find((x) => x.text === picked);
    browse.current = { id: entry?.id ?? null, stash: at >= 0 ? browse.current.stash : text, query: null };
    dispatch(setDraft(picked));
    requestAnimationFrame(() => {
      ref.current?.focus({ preventScroll: true });
      ref.current?.setCaret(picked.length);
    });
  };

  return { stepHistory, pickHistory, placeOf, reset };
}
