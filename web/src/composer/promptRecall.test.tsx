import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, PromptEntry } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Composer } from './Composer.tsx';
import { historySlice } from './history.ts';

beforeEach(() => { setLang('en'); vi.stubGlobal('fetch', vi.fn(async () => new Response('{"prompts":[]}'))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const p = (id: string, text: string): PromptEntry => ({ id, ts: 1, text, src: 'typed' });

function setup(items: PromptEntry[]) {
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (_m: ClientMessage) => true, close() {} })) as never });
  act(() => {
    store.dispatch(serverEvent({ kind: 'session', id: 's1', root: '/p', title: null, model: null }));
    store.dispatch(historySlice.actions.loaded(items));
  });
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  return { store, box: screen.getByRole('textbox') as HTMLTextAreaElement };
}
const caret = (box: HTMLTextAreaElement, at: number) => act(() => box.setSelectionRange(at, at));
const raf = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

it('↑ in an empty field recalls the newest prompt, ↑ again an older one, ↓ goes back and past the newest restores the draft', async () => {
  const { box } = setup([p('a', 'first'), p('b', 'second'), p('c', 'third')]);
  box.focus();
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('third');
  await raf();
  expect(box.selectionStart).toBe(5);
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('second');
  await userEvent.keyboard('{ArrowUp}{ArrowUp}');
  expect(box.value).toBe('first'); // the oldest stays
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('second');
  await userEvent.keyboard('{ArrowDown}{ArrowDown}');
  expect(box.value).toBe('');
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('');
});

it('a non-empty draft is never replaced: ↑ and ↓ stay the field\'s own, caret at the start or not', async () => {
  const { box } = setup([p('a', 'old one')]);
  await userEvent.type(box, 'half typed');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('half typed');
  caret(box, 0);
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('half typed');
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('half typed');
});

it('a list change while browsing (a prompt arrives) does not lose the place: ↓ still walks back to the empty draft', async () => {
  const { store, box } = setup([p('a', 'one'), p('b', 'two'), p('c', 'three')]);
  box.focus();
  await userEvent.keyboard('{ArrowUp}{ArrowUp}');
  expect(box.value).toBe('two');
  act(() => void store.dispatch(historySlice.actions.appended(p('d', 'four'))));
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('three');
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('four');
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('');
});

it('a recalled slash command does not open the / menu, which would take the arrows', async () => {
  const { store, box } = setup([p('a', 'older'), p('b', '/ping')]);
  act(() => void store.dispatch(serverEvent({ kind: 'commands', commands: [{ name: 'ping', description: 'Reply PONG' }] })));
  box.focus();
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('/ping');
  await raf();
  act(() => void document.dispatchEvent(new Event('selectionchange'))); // what the caret move after the recall fires in a browser
  expect(screen.queryByRole('listbox')).toBeNull();
  caret(box, 0);
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('older');
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('/ping');
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('');
});

it('a multi-line prompt: ↑ moves the caret within it, and goes older only from its first line', async () => {
  const { box } = setup([p('a', 'older'), p('b', 'line one\nline two')]);
  box.focus();
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('line one\nline two');
  await waitFor(() => expect(box.selectionStart).toBe(box.value.length)); // the recall puts the caret at the end on the next frame: wait for it before moving it
  await userEvent.keyboard('{ArrowUp}'); // the caret is on the last line: left to the field
  expect(box.value).toBe('line one\nline two');
  caret(box, 3);
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('older');
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('line one\nline two');
});

it('↓ inside a multi-line recall leaves the key to the field until the last line', async () => {
  const { box } = setup([p('a', 'x'), p('b', 'line one\nline two')]);
  box.focus();
  await userEvent.keyboard('{ArrowUp}');
  caret(box, 2);
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('line one\nline two'); // on the first line: not a step newer
});

it('an edit ends the browsing: the next ↑ is the field\'s own', async () => {
  const { box } = setup([p('a', 'older'), p('b', 'newer')]);
  box.focus();
  await userEvent.keyboard('{ArrowUp}');
  await userEvent.keyboard('!');
  expect(box.value).toBe('newer!');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('newer!');
});

it('a prompt repeated right after itself is walked once', async () => {
  const { box } = setup([p('a', 'other'), p('b', 'same'), p('c', 'same')]);
  box.focus();
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('same');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('other');
});

it('with a modifier, or no history, ↑ does nothing', async () => {
  const { box } = setup([p('a', 'x')]);
  box.focus();
  await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
  expect(box.value).toBe('');
  cleanup();
  const none = setup([]);
  none.box.focus();
  await userEvent.keyboard('{ArrowUp}');
  expect(none.box.value).toBe('');
});

it('another session\'s history is not recalled: the browsing stops with the switch', async () => {
  const { store, box } = setup([p('a', 'mine')]);
  box.focus();
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('mine');
  act(() => void store.dispatch(serverEvent({ kind: 'session', id: 's2', root: '/p', title: null, model: null })));
  await userEvent.clear(box);
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('');
});

it('↑ with typed text walks the prompts that contain it (case-insensitive, newest first); ↓ past the newest restores the typed text', async () => {
  const { box } = setup([p('a', 'fix the Build'), p('b', 'unrelated'), p('c', 'rebuild all'), p('d', 'other'), p('e', 'build docs')]);
  box.focus();
  await userEvent.type(box, 'build');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('build docs');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('rebuild all'); // the query stays the typed one, not the recalled text
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('fix the Build');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('fix the Build'); // the oldest match stays
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('rebuild all');
  await userEvent.keyboard('{ArrowDown}{ArrowDown}');
  expect(box.value).toBe('build');
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('build');
});

it('a search collapses repeated texts, also ones made adjacent by the filter', async () => {
  const { box } = setup([p('a', 'same x'), p('b', 'nope'), p('c', 'same x'), p('d', 'older x')]);
  box.focus();
  await userEvent.type(box, 'x');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('older x');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('same x');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('same x'); // the two copies are one step; it is the oldest
});

it('typed text with no match: ↑ changes nothing; a multi-line draft keeps the native arrows', async () => {
  const { box } = setup([p('a', 'alpha'), p('b', 'beta')]);
  box.focus();
  await userEvent.type(box, 'zzz');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('zzz');
  await userEvent.clear(box);
  await userEvent.type(box, 'a{Shift>}{Enter}{/Shift}t');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('a\nt');
});

it('editing a recalled match ends the walk; the edited text is a new query on the next ↑', async () => {
  const { box } = setup([p('a', 'foo one'), p('b', 'foo two'), p('c', 'bar')]);
  box.focus();
  await userEvent.type(box, 'foo');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('foo two');
  await userEvent.keyboard('{Backspace}{Backspace}{Backspace}');
  expect(box.value).toBe('foo ');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('foo two'); // 'foo ' is the new query
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('foo one');
  await userEvent.keyboard('{ArrowDown}{ArrowDown}');
  expect(box.value).toBe('foo ');
});

it('a recalled /command found by search keeps the / menu closed', async () => {
  const { store, box } = setup([p('a', '/ping now'), p('b', 'x')]);
  act(() => void store.dispatch(serverEvent({ kind: 'commands', commands: [{ name: 'ping', description: 'Reply PONG' }] })));
  box.focus();
  await userEvent.type(box, 'ping');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('/ping now');
  await raf();
  act(() => void document.dispatchEvent(new Event('selectionchange')));
  expect(screen.queryByRole('listbox')).toBeNull();
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('ping');
});

it('a search skips the typed text itself: the first ↑ always changes the field, and only equal matches means no match', async () => {
  const { box } = setup([p('a', 'build docs'), p('b', 'build'), p('c', 'x')]);
  box.focus();
  await userEvent.type(box, 'build');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('build docs');
  await userEvent.keyboard('{ArrowUp}');
  expect(box.value).toBe('build docs');
  await userEvent.keyboard('{ArrowDown}');
  expect(box.value).toBe('build');
  cleanup();
  const only = setup([p('a', 'build'), p('b', 'x')]);
  only.box.focus();
  await userEvent.type(only.box, 'build');
  await userEvent.keyboard('{ArrowUp}');
  expect(only.box.value).toBe('build');
  await userEvent.keyboard('{ArrowDown}');
  expect(only.box.value).toBe('build');
});
