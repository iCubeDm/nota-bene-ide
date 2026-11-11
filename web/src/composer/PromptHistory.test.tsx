import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, PromptEntry } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { installKeymap } from '@/shell/keymap.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Composer } from './Composer.tsx';
import { historySlice, searchPrompts } from './history.ts';
import { promptHistoryModal } from './historyModal.ts';

beforeEach(() => { setLang('en'); vi.stubGlobal('fetch', vi.fn(async () => new Response('{"prompts":[]}'))); });
afterEach(() => { cleanup(); promptHistoryModal.close(); vi.unstubAllGlobals(); });

const p = (id: string, text: string, extra: Partial<PromptEntry> = {}): PromptEntry => ({ id, ts: Date.now(), text, src: 'typed', ...extra });

function setup(items: PromptEntry[]) {
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (_m: ClientMessage) => true, close() {} })) as never });
  act(() => {
    store.dispatch(serverEvent({ kind: 'session', id: 's1', root: '/p', title: null, model: null }));
    store.dispatch(historySlice.actions.loaded(items));
  });
  const off = installKeymap(store);
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  return { store, off, box: screen.getByRole('textbox') as HTMLTextAreaElement };
}
const opts = () => screen.queryAllByRole('option').map((o) => o.textContent ?? '');

it('searchPrompts: a substring hit comes before a fuzzy one, newest first, each text once, capped at 30', () => {
  const items = [p('1', 'refactor the parser'), p('2', 'fix a bug in the parser'), p('3', 'rapid fire test run'), p('4', 'fix a bug in the parser')];
  expect(searchPrompts(items, 'parser').map((x) => x.id)).toEqual(['4', '1']);
  // "rfr" is no substring anywhere; a subsequence of two of them
  expect(searchPrompts(items, 'rft').map((x) => x.id)).toEqual(expect.arrayContaining(['1', '3']));
  expect(searchPrompts(items, 'fix bug').map((x) => x.id)).toEqual(['4']); // fuzzy: scattered words
  expect(searchPrompts(items, 'zzz')).toEqual([]);
  expect(searchPrompts(items, '  ').map((x) => x.id)).toEqual(['4', '3', '1']);
  const many = Array.from({ length: 50 }, (_, i) => p(`m${i}`, `match ${i}`));
  expect(searchPrompts(many, 'match')).toHaveLength(30);
});

it('the button is disabled with no history and carries its shortcut in the tooltip', async () => {
  setup([]);
  expect(screen.getByTestId('prompt-history')).toBeDisabled();
  cleanup();
  setup([p('a', 'x')]);
  const btn = screen.getByTestId('prompt-history');
  expect(btn).toBeEnabled();
  await userEvent.hover(btn.parentElement!);
  expect((await screen.findAllByText(/Prompt history \((Ctrl|⌥|Alt)/)).length).toBeGreaterThan(0);
});

it('opens a list newest first; typing filters it (substring first); Enter puts the prompt in the draft without sending', async () => {
  const { box, store } = setup([p('a', 'write the docs'), p('b', 'fix the parser', { src: 'voice' }), p('c', 'run the tests')]);
  await userEvent.click(screen.getByTestId('prompt-history'));
  expect(opts()).toHaveLength(3);
  expect(opts()[0]).toContain('run the tests');
  expect(within(screen.getAllByRole('option')[1]!).getByLabelText('Voice message')).toBeInTheDocument();
  const filter = screen.getByRole('combobox');
  expect(filter).toHaveFocus();
  await userEvent.type(filter, 'parser');
  expect(opts()).toHaveLength(1);
  await userEvent.keyboard('{Enter}');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(box.value).toBe('fix the parser');
  await waitFor(() => expect(box).toHaveFocus());
  expect(store.getState().composer.unconfirmed).toBeNull();
});

it('↑/↓ move the selection; a click picks; the previous draft comes back with ↓ in the field', async () => {
  const { box } = setup([p('a', 'first prompt'), p('b', 'second prompt')]);
  await userEvent.type(box, 'my draft');
  await userEvent.click(screen.getByTestId('prompt-history'));
  await userEvent.keyboard('{ArrowDown}{ArrowUp}{ArrowDown}');
  expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  await userEvent.click(screen.getAllByRole('option')[0]!);
  expect(box.value).toBe('second prompt');
  await waitFor(() => expect(box).toHaveFocus());
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('my draft');
});

it('Esc closes without touching the draft; no match and an empty history say so', async () => {
  const { box } = setup([p('a', 'alpha')]);
  await userEvent.type(box, 'keep');
  await userEvent.click(screen.getByTestId('prompt-history'));
  await userEvent.type(screen.getByRole('combobox'), 'qqq');
  expect(screen.getByText('No prompt matches')).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(box.value).toBe('keep');
});

it('Alt+H toggles the list, also from the composer', async () => {
  const { box, off } = setup([p('a', 'alpha')]);
  box.focus();
  await userEvent.keyboard('{Alt>}h{/Alt}');
  expect(await screen.findByRole('combobox')).toBeInTheDocument();
  await userEvent.keyboard('{Alt>}h{/Alt}');
  expect(screen.queryByRole('combobox')).toBeNull();
  off();
});
