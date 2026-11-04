import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { Composer } from './Composer.tsx';

beforeEach(() => setLang('en'));
afterEach(cleanup);

function setup(open: boolean) {
  const sent: ClientMessage[] = [];
  let flip!: (s: 'open' | 'closed') => void;
  const connect = vi.fn((_u: unknown, _e: unknown, onState: (s: 'open' | 'closed') => void) => {
    flip = onState;
    if (open) onState('open');
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  render(
    <Provider store={store}>
      <TooltipProvider>
        <Composer />
      </TooltipProvider>
    </Provider>,
  );
  return { sent, store, flip: (s: 'open' | 'closed') => act(() => flip(s)), box: screen.getByRole('textbox') as HTMLTextAreaElement };
}

it('Enter sends and clears', async () => {
  const { sent, box } = setup(true);
  await userEvent.type(box, 'hello{Enter}');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: 'send', text: 'hello', force: false });
  expect(box.value).toBe('');
  expect(box).toHaveFocus();
});

it('Shift+Enter adds a newline', async () => {
  const { sent, box } = setup(true);
  await userEvent.type(box, 'a{Shift>}{Enter}{/Shift}b');
  expect(box.value).toBe('a\nb');
  expect(sent).toHaveLength(0);
});

it('keeps text when send fails', async () => {
  const { sent, box } = setup(false);
  await userEvent.type(box, 'hello{Enter}');
  expect(sent).toHaveLength(0);
  expect(box.value).toBe('hello');
  expect(screen.getByText('no connection to the server…')).toBeVisible();
});

it('Stop is disabled when idle and Esc does nothing', async () => {
  const { sent, box } = setup(true);
  expect(screen.getByRole('button', { name: 'Stop the agent' })).toBeDisabled();
  await userEvent.type(box, '{Escape}');
  expect(sent).toHaveLength(0);
});

const busyNow = (store: ReturnType<typeof setup>['store']) => act(() => {
  store.dispatch({ type: 'server/event', payload: { kind: 'user', id: 'u1', text: 'x', ts: 0 } });
});

it('when busy: status shows, Ctrl+Enter twice forces, only the stop button stops (Esc does not)', async () => {
  const { sent, store, box } = setup(true);
  busyNow(store);
  expect(screen.getByText('agent is working…')).toBeInTheDocument();
  await userEvent.type(box, 'now{Control>}{Enter}{Enter}{/Control}');
  expect(sent[0]).toMatchObject({ type: 'send', text: 'now', force: true });
  await userEvent.keyboard('{Escape}');
  box.blur();
  await userEvent.keyboard('{Escape}');
  expect(sent).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Stop the agent' }));
  expect(sent[1]).toEqual({ type: 'interrupt' });
});

it('offline label disappears when the socket reconnects, text stays', async () => {
  const { box, flip } = setup(false);
  await userEvent.type(box, 'hello{Enter}');
  expect(screen.getByText('no connection to the server…')).toBeVisible();
  flip('open');
  expect(screen.queryByText('no connection to the server…')).toBeNull();
  expect(box.value).toBe('hello');
});

it('a failed send is forgotten once the socket reopens: a later drop shows no stale offline label', async () => {
  const { box, flip } = setup(false);
  await userEvent.type(box, 'hello{Enter}');
  expect(screen.getByText('no connection to the server…')).toBeVisible();
  flip('open');
  flip('closed');
  expect(screen.queryByText('no connection to the server…')).toBeNull();
});

it('Ctrl+Shift+Enter forces, after the same confirmation', async () => {
  const { sent, store, box } = setup(true);
  busyNow(store);
  await userEvent.type(box, 'go{Control>}{Shift>}{Enter}{Enter}{/Shift}{/Control}');
  expect(sent[0]).toMatchObject({ text: 'go', force: true });
});

it('when busy, the first Ctrl+Enter only warns; the button confirms', async () => {
  const { sent, store, box } = setup(true);
  busyNow(store);
  await userEvent.type(box, 'now{Control>}{Enter}{/Control}');
  expect(sent).toHaveLength(0);
  expect(screen.getByRole('alert')).toHaveTextContent('The agent will be interrupted');
  expect(box.value).toBe('now');
  await userEvent.click(screen.getByRole('button', { name: 'Interrupt and send' }));
  expect(sent).toEqual([expect.objectContaining({ type: 'send', text: 'now', force: true })]);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('the warning is cancelled by Esc, by its Cancel button, or by a plain Enter that injects instead', async () => {
  const { sent, store, box } = setup(true);
  busyNow(store);
  await userEvent.type(box, 'a{Control>}{Enter}{/Control}{Escape}');
  expect(screen.queryByRole('alert')).toBeNull();
  await userEvent.keyboard('{Control>}{Enter}{/Control}');
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(sent).toHaveLength(0);
  box.focus();
  await userEvent.keyboard('{Control>}{Enter}{/Control}{Enter}');
  expect(sent).toEqual([expect.objectContaining({ text: 'a', force: false })]);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('the warning goes when the turn ends; idle, Ctrl+Enter sends at once', async () => {
  const { sent, store, box } = setup(true);
  busyNow(store);
  await userEvent.type(box, 'a{Control>}{Enter}{/Control}');
  expect(screen.getByRole('alert')).toBeInTheDocument();
  act(() => {
    store.dispatch({ type: 'server/event', payload: { kind: 'agent', e: { t: 'turn-end', stop: 'done', secs: 1, answers: 'all', queued: 0 }, ts: 1 } });
  });
  expect(screen.queryByRole('alert')).toBeNull();
  await userEvent.keyboard('{Control>}{Enter}{/Control}');
  expect(sent).toEqual([expect.objectContaining({ text: 'a', force: false })]); // nothing to interrupt: a plain send
});
