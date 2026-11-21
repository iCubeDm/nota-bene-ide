import { act, cleanup, renderHook } from '@testing-library/react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Provider } from 'react-redux';
import { afterEach, expect, it, vi } from 'vitest';
import { testStore } from '@/core/testing';
import { selectDraft } from './slice.ts';
import { useComposerKeys, type ComposerKeys } from './useComposerKeys.ts';

afterEach(cleanup);

type Mods = Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'isComposing', boolean>>;
const ev = (key: string, m: Mods = {}) => {
  const { isComposing = false, ...mods } = m;
  return { key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods, nativeEvent: { isComposing }, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement> & { preventDefault: ReturnType<typeof vi.fn> };
};

function setup(o: Partial<ComposerKeys> = {}) {
  const { store } = testStore();
  const opts: ComposerKeys = {
    ref: { current: document.createElement('textarea') },
    suggestion: null,
    pickNextMode: vi.fn(),
    askForce: false,
    setAskForce: vi.fn(),
    stepHistory: vi.fn(() => false),
    submit: vi.fn(),
    ...o,
  };
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  const { result } = renderHook(() => useComposerKeys(opts), { wrapper });
  const press = (e: ReturnType<typeof ev>) => (act(() => result.current(e)), e);
  return { store, opts, press };
}

it('Enter sends, Cmd/Ctrl+Enter forces, Shift+Enter and a composing Enter are the field\'s own', () => {
  const { opts, press } = setup();
  expect(press(ev('Enter')).preventDefault).toHaveBeenCalled();
  press(ev('Enter', { metaKey: true }));
  press(ev('Enter', { ctrlKey: true, shiftKey: true }));
  expect(press(ev('Enter', { shiftKey: true })).preventDefault).not.toHaveBeenCalled();
  press(ev('Enter', { isComposing: true }));
  expect(vi.mocked(opts.submit).mock.calls).toEqual([[false], [true], [true]]);
});

it('Tab takes a shown suggestion; without one it does nothing', () => {
  const shown = setup({ suggestion: 'run the tests' });
  expect(shown.press(ev('Tab')).preventDefault).toHaveBeenCalled();
  expect(selectDraft(shown.store.getState())).toBe('run the tests');
  const none = setup();
  expect(none.press(ev('Tab')).preventDefault).not.toHaveBeenCalled();
  expect(selectDraft(none.store.getState())).toBe('');
});

it('Shift+Tab picks the next mode, only when there is one', () => {
  const { opts, press } = setup();
  expect(press(ev('Tab', { shiftKey: true })).preventDefault).toHaveBeenCalled();
  expect(opts.pickNextMode).toHaveBeenCalledOnce();
  const one = setup({ pickNextMode: null });
  expect(one.press(ev('Tab', { shiftKey: true })).preventDefault).not.toHaveBeenCalled();
});

it('Esc closes the force question; ↑/↓ go to the history (Alt = always), a step ends the key', () => {
  const asked = setup({ askForce: true });
  expect(asked.press(ev('Escape')).preventDefault).toHaveBeenCalled();
  expect(asked.opts.setAskForce).toHaveBeenCalledWith(false);
  const stepped = setup({ stepHistory: vi.fn(() => true) });
  expect(stepped.press(ev('ArrowUp', { altKey: true })).preventDefault).toHaveBeenCalled();
  stepped.press(ev('ArrowDown'));
  stepped.press(ev('ArrowUp', { metaKey: true })); // Cmd+↑ is the field's own
  expect(vi.mocked(stepped.opts.stepHistory).mock.calls.map(([e, always]) => [e.key, always])).toEqual([['ArrowUp', true], ['ArrowDown', false]]);
});
