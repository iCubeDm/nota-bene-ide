import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/core/components/ui/tooltip.tsx';
import { setLang } from '@/core/i18n/index.ts';
import { makeStore, select, setValue, valueOf } from '@/core/testing';
import { fieldFor } from '@/sdk';
import { CommentPopup } from './CommentPopup.tsx';
import { loadEmoji } from './emoji.ts';
import type { PendingSelection } from './SelectionButton.tsx';

const pending: PendingSelection = {
  anchor: { source: { kind: 'message', id: 'a1' }, start: 6, end: 17, quote: 'brave world', prefix: 'hello ', suffix: '' },
  rect: { left: 10, right: 50, top: 20, bottom: 40, width: 40, height: 20, x: 10, y: 20, toJSON() {} } as DOMRect,
};

beforeAll(() => loadEmoji());
beforeEach(() => setLang('en'));
afterEach(() => cleanup());

function setup() {
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, s: (x: 'open') => void) => (s('open'), { send: () => true, close() {} })) as never });
  const onClose = vi.fn();
  render(
    <Provider store={store}>
      <TooltipProvider>
        <CommentPopup pending={pending} onClose={onClose} />
      </TooltipProvider>
    </Provider>,
  );
  const box = screen.getByRole('textbox', { name: 'Comment…' });
  const type = (value: string) => setValue(box, value);
  return { store, onClose, box, type };
}

it('":+1" then Enter inserts 👍', () => {
  const { box, type, store } = setup();
  type('nice :+1');
  expect(screen.getByRole('listbox')).toBeInTheDocument();
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(valueOf(box)).toBe('nice 👍');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(store.getState().comments.items).toHaveLength(0);
});

it('Tab inserts, arrows move the selection', () => {
  const { box, type } = setup();
  type(':smile');
  const rows = screen.getAllByRole('option');
  expect(rows.length).toBeLessThanOrEqual(8);
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  const second = screen.getAllByRole('option')[1].textContent!.match(/^(\S+?):/)?.[1] ?? '';
  fireEvent.keyDown(box, { key: 'Tab' });
  expect(valueOf(box)).toBe(second);
  expect(caret(box)).toBe(second.length);
});

it('caret lands right after the inserted emoji', () => {
  const { box, type } = setup();
  type('a :+1');
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(caret(box)).toBe('a 👍'.length);
});

it('a stale token is never corrupted: caret moved away, Enter does nothing', () => {
  const { box, type } = setup();
  type(':smil');
  select(box, 0);
  fireEvent.keyDown(box, { key: 'Home' });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(valueOf(box)).toBe('\n:smil'); // Enter is the popup's newline, at the caret; the token stays as typed
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('does not trigger inside http://x', () => {
  const { type } = setup();
  type('see http://x');
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('":thumbsup:" is replaced on the closing colon', () => {
  const { box, type } = setup();
  type(':thumbsup:');
  expect(valueOf(box)).toBe('👍');
});

it('an unknown closed code is left alone', () => {
  const { box, type } = setup();
  type(':nopenotacode:');
  expect(valueOf(box)).toBe(':nopenotacode:');
});

it('does not trigger mid-word (12:30)', () => {
  const { type } = setup();
  type('at 12:30');
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('Esc closes the picker but not the popup', () => {
  const { box, type, onClose } = setup();
  type(':smile');
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('Enter without an open picker adds the comment only with ⌘', () => {
  const { box, type, store } = setup();
  type('plain');
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(store.getState().comments.items).toHaveLength(0);
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  expect(store.getState().comments.items).toHaveLength(1);
});

it('mouse click inserts the row', () => {
  const { box, type } = setup();
  type(':+1');
  const row = screen.getAllByRole('option')[0];
  fireEvent.mouseDown(row);
  fireEvent.click(row);
  expect(valueOf(box)).toBe('👍');
});

it('caret jump to a closed :+1: elsewhere does not replace it', () => {
  const { box, type } = setup();
  type(':+1: x :smil');
  expect(screen.getByRole('listbox')).toBeInTheDocument();
  select(box, 4);
  expect(document.activeElement).toBe(box);
  fireEvent(document, new Event('selectionchange'));
  expect(valueOf(box)).toBe(':+1: x :smil');
});

it('selectionchange away from the token closes the list', () => {
  const { box, type } = setup();
  type(':smil');
  select(box, 0);
  expect(document.activeElement).toBe(box);
  fireEvent(document, new Event('selectionchange'));
  expect(screen.queryByRole('listbox')).toBeNull();
});

const caret = (el: HTMLElement) => fieldFor(el)!.selection().from;
