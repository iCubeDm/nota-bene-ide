import { act, cleanup, renderHook } from '@testing-library/react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Provider } from 'react-redux';
import { afterEach, expect, it } from 'vitest';
import type { PromptEntry } from '@nota-bene/shared';
import { testStore } from '@/testing';
import { selectDraft } from './slice.ts';
import { usePromptRecall } from './usePromptRecall.ts';

afterEach(cleanup);

const p = (id: string, text: string): PromptEntry => ({ id, ts: 1, text, src: 'typed' });

function setup(items: PromptEntry[]) {
  const { store } = testStore();
  const el = document.body.appendChild(document.createElement('textarea'));
  const ref = { current: el };
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  const hook = renderHook((props: { items: PromptEntry[]; sid: string | null }) => usePromptRecall({ ...props, text: selectDraft(store.getState()), ref }), {
    wrapper,
    initialProps: { items, sid: 's1' },
  });
  // the field as the controlled value leaves it: the draft, the caret at its end
  const key = (k: 'ArrowUp' | 'ArrowDown', always = false) => {
    el.value = selectDraft(store.getState());
    el.setSelectionRange(el.value.length, el.value.length);
    let r = false;
    act(() => void (r = hook.result.current.stepHistory({ key: k, currentTarget: el } as KeyboardEvent<HTMLTextAreaElement>, always)));
    return r;
  };
  return { store, hook, key, draft: () => selectDraft(store.getState()) };
}

it('↑ walks the prompts newest first and ↓ past the newest brings the draft back; placeOf follows the walk', () => {
  const { hook, key, draft } = setup([p('a', 'one'), p('b', 'two')]);
  expect(key('ArrowUp')).toBe(true);
  expect(draft()).toBe('two');
  expect(hook.result.current.placeOf('two')).toBe(0);
  key('ArrowUp');
  expect(draft()).toBe('one');
  key('ArrowDown');
  key('ArrowDown');
  expect(draft()).toBe('');
  expect(hook.result.current.placeOf('')).toBe(-1);
  expect(key('ArrowDown')).toBe(false); // not browsing: the field's own
});

it('reset and a new session end the walk', () => {
  const { hook, key, draft } = setup([p('a', 'one')]);
  key('ArrowUp');
  act(() => hook.result.current.reset());
  expect(hook.result.current.placeOf(draft())).toBe(-1);
  expect(key('ArrowDown')).toBe(false);
  act(() => hook.result.current.pickHistory('one'));
  expect(hook.result.current.placeOf(draft())).toBe(0);
  hook.rerender({ items: [p('a', 'one')], sid: 's2' });
  expect(hook.result.current.placeOf(draft())).toBe(-1);
});

it('a picked prompt replaces the draft, which ↓ brings back', () => {
  const { store, hook, key, draft } = setup([p('a', 'one'), p('b', 'two')]);
  act(() => void store.dispatch({ type: 'composer/setDraft', payload: 'mine' }));
  hook.rerender({ items: [p('a', 'one'), p('b', 'two')], sid: 's1' });
  act(() => hook.result.current.pickHistory('one'));
  expect(draft()).toBe('one');
  expect(hook.result.current.placeOf('one')).toBe(1);
  key('ArrowDown');
  expect(draft()).toBe('two');
  key('ArrowDown');
  expect(draft()).toBe('mine');
});

it('typed text searches: ↑ walks only the prompts containing it', () => {
  const { store, key, draft } = setup([p('a', 'fix tests'), p('b', 'other'), p('c', 'tests again')]);
  act(() => void store.dispatch({ type: 'composer/setDraft', payload: 'test' }));
  key('ArrowUp');
  expect(draft()).toBe('tests again');
  key('ArrowUp');
  expect(draft()).toBe('fix tests');
  key('ArrowUp');
  expect(draft()).toBe('fix tests');
});
