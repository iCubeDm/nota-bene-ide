import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ModelOption, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { ModelPill } from './ModelPill.tsx';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => setLang('en'));
afterEach(cleanup);

const MODELS: ModelOption[] = [
  { value: 'sonnet', name: 'Sonnet 5', description: 'Everyday', resolved: 'claude-sonnet-5', efforts: ['low', 'medium', 'high'] },
  { value: 'opus', name: 'Opus 5', description: 'Hardest tasks', resolved: 'claude-opus-5', efforts: ['high', 'max'] },
  { value: 'haiku', name: 'Haiku 5', description: 'Fast', resolved: 'claude-haiku-5' },
];

function setup() {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  const connect = vi.fn((_u: unknown, onEvent: (e: ServerEvent) => void, onState: (s: 'open' | 'closed') => void) => {
    ev = onEvent;
    onState('open');
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  render(<Provider store={store}><TooltipProvider><ModelPill /></TooltipProvider></Provider>);
  const emit = (...es: ServerEvent[]) => act(() => es.forEach(ev));
  const ready = (used = 120_000, turns = true) => emit(
    { kind: 'hello', protocol: 6 }, { kind: 'models', models: MODELS }, { kind: 'model', model: 'claude-sonnet-5', effort: 'medium' },
    { kind: 'stats', stats: { context: { used, max: 200_000, pct: 60 }, limits: null, cost: null } },
    ...(turns ? [{ kind: 'user', id: 'u1', text: 'hi', ts: 1 } as ServerEvent] : []),
  );
  return { sent, emit, ready, store };
}
const pill = () => screen.getByRole('button', { name: /Model and effort/ });
const open = async () => { await userEvent.click(pill()); return screen.findByRole('menu'); };

it('renders nothing until a model or a list is known', () => {
  setup();
  expect(screen.queryByRole('button', { name: /Model and effort/ })).toBeNull();
});

it('shows the current model by its list name (the CLI reports the resolved id) and the effort', () => {
  const { ready } = setup();
  ready();
  expect(pill()).toHaveTextContent('Sonnet 5 · Medium');
});

it('without a list (an older server) it shows the reported name and is disabled', () => {
  const { emit } = setup();
  emit({ kind: 'hello', protocol: 5 }, { kind: 'session', id: null, root: '/p', title: null, model: 'claude-opus-5' });
  expect(pill()).toHaveTextContent('claude-opus-5');
  expect(pill()).toBeDisabled();
});

it('lists the models compactly: one row each with a check on the current one, and ONE effort row for the current model', async () => {
  const { ready } = setup();
  ready();
  const menu = await open();
  const rows = within(menu).getAllByRole('menuitem').filter((e) => !e.closest('[role="group"]'));
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveAttribute('aria-current', 'true');
  expect(rows[0]).toHaveTextContent('Sonnet 5Everyday✓');
  expect(rows[1]).not.toHaveAttribute('aria-current');
  expect(within(menu).getAllByRole('group', { name: 'Effort' })).toHaveLength(1);
  expect(within(within(menu).getByRole('group', { name: 'Effort' })).getAllByRole('menuitem').map((e) => e.textContent)).toEqual(['Low', 'Medium', 'High']);
});

it('no effort row when the current model has no levels', async () => {
  const { emit } = setup();
  emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: MODELS }, { kind: 'model', model: 'claude-haiku-5' });
  const menu = await open();
  expect(within(menu).queryByRole('group', { name: 'Effort' })).toBeNull();
});

it('picking another model sends it (keeping the effort when the model has it); the pill waits for the echo', async () => {
  const { sent, ready, emit } = setup();
  ready();
  const menu = await open();
  await userEvent.click(within(menu).getByText('Haiku 5'));
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'haiku', id: expect.any(String) });
  expect(sent.at(-1)).not.toHaveProperty('effort');
  expect(pill()).toHaveTextContent('Sonnet 5');
  emit({ kind: 'model', model: 'haiku', ack: (sent.at(-1) as { id: string }).id });
  expect(pill()).toHaveTextContent(/^Haiku 5$/);
  const m2 = await open();
  await userEvent.click(within(m2).getByText('Sonnet 5'));
  expect(sent.at(-1)).toMatchObject({ model: 'sonnet' });
});

it('two rows resolving to one id (default and opus): only the alias in use is current, the other can still be picked', async () => {
  const { sent, emit } = setup();
  const twin: ModelOption[] = [{ value: 'default', name: 'Default', description: 'd', resolved: 'claude-opus-5' }, { value: 'opus', name: 'Opus 5', description: 'o', resolved: 'claude-opus-5' }];
  emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: twin }, { kind: 'model', model: 'claude-opus-5' });
  expect(pill()).toHaveTextContent(/^Default$/); // the CLI's default: the first row with that id
  const menu = await open();
  await userEvent.click(within(menu).getByText('Opus 5'));
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'opus' });
});

it('picking an effort of the current model sends model + effort; the current choice sends nothing', async () => {
  const { sent, ready } = setup();
  ready();
  const menu = await open();
  const n = sent.length;
  await userEvent.click(within(within(menu).getByRole('group', { name: 'Effort' })).getByRole('menuitem', { name: 'Medium' }));
  expect(sent).toHaveLength(n);
  const m2 = await open();
  await userEvent.click(within(within(m2).getByRole('group', { name: 'Effort' })).getByRole('menuitem', { name: 'High' }));
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'sonnet', effort: 'high' });
});

it('the cache warning: ONE line at the bottom, in tokens/1000, once the session has had a turn', async () => {
  const { ready } = setup();
  ready(123_400);
  const menu = await open();
  expect(within(menu).getAllByTestId('cache-warn')).toHaveLength(1);
  expect(within(menu).getByTestId('cache-warn')).toHaveTextContent('The next reply re-reads the context: ~123k tokens');
  expect(within(menu).getByTestId('cache-warn').closest('[role="group"]')).toBeNull();
});

it('no warning before the first turn, even with a context baseline (the meter shows the system prompt)', async () => {
  const { ready, emit } = setup();
  ready(28_000, false);
  let menu = await open();
  expect(within(menu).queryByTestId('cache-warn')).toBeNull();
  await userEvent.keyboard('{Escape}');
  emit({ kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  menu = await open();
  expect(within(menu).getByTestId('cache-warn')).toHaveTextContent('~28k');
});

it('no warning with an empty context; the Russian text', async () => {
  const { ready } = setup();
  ready(0);
  let menu = await open();
  expect(within(menu).queryByTestId('cache-warn')).toBeNull();
  await userEvent.keyboard('{Escape}');
  act(() => setLang('ru'));
  ready(120_000);
  await userEvent.click(screen.getByRole('button', { name: /Модель и усилие/ }));
  menu = await screen.findByRole('menu');
  expect(within(menu).getByTestId('cache-warn')).toHaveTextContent('Следующий ответ перечитает контекст: ~120 тыс. токенов');
});

it('the pill before the CLI reported a model: the pref\'s model, else "Default" (never the bare "Model")', () => {
  const { emit } = setup();
  emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: MODELS }, { kind: 'model', model: null });
  expect(pill()).toHaveTextContent(/^Default$/);
  emit({ kind: 'model', model: 'opus', effort: 'max' });
  expect(pill()).toHaveTextContent('Opus 5 · Max');
  act(() => setLang('ru'));
  emit({ kind: 'model', model: null });
  expect(screen.getByRole('button', { name: /Модель и усилие/ })).toHaveTextContent(/^По умолчанию$/);
});

it('is disabled and sends nothing for a server older than protocol 6', async () => {
  const { sent, emit } = setup();
  emit({ kind: 'hello', protocol: 5 }, { kind: 'models', models: MODELS }, { kind: 'model', model: 'sonnet' });
  expect(pill()).toBeDisabled(); // protocol 5: the server would not know the message
  expect(sent).toEqual([]);
});

it('M3: no warning when hovering a row that resolves to the model in use (default and opus); an unmatched model warns for any', async () => {
  const { emit } = setup();
  const twin: ModelOption[] = [{ value: 'default', name: 'Default', description: 'd', resolved: 'claude-opus-5' }, { value: 'opus', name: 'Opus 5', description: 'o', resolved: 'claude-opus-5' }, { value: 'haiku', name: 'Haiku 5', description: 'h', resolved: 'claude-haiku-5' }];
  emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: twin }, { kind: 'model', model: 'claude-opus-5' }, { kind: 'stats', stats: { context: { used: 50_000, max: 200_000, pct: 25 }, limits: null, cost: null } }, { kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  let menu = await open();
  expect(within(menu).getByTestId('cache-warn')).toBeInTheDocument(); // neutral hint: Haiku would re-read
  await userEvent.hover(within(menu).getByText('Opus 5'));
  expect(within(menu).queryByTestId('cache-warn')).toBeNull();
  await userEvent.hover(within(menu).getByText('Haiku 5'));
  expect(within(menu).getByTestId('cache-warn')).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  emit({ kind: 'model', model: 'claude-mystery' });
  menu = await open();
  await userEvent.hover(within(menu).getByText('Opus 5'));
  expect(within(menu).getByTestId('cache-warn')).toBeInTheDocument();
});

it('13 rows are too long: aliases first, explicit ids under a collapsed "Other versions"; open when the current model is one of them', async () => {
  const { emit } = setup();
  const list: ModelOption[] = [
    { value: 'sonnet', name: 'Sonnet', description: 's', resolved: 'claude-sonnet-5-5' },
    { value: 'claude-sonnet-5', name: 'Sonnet 5', description: 'old', resolved: 'claude-sonnet-5' },
  ];
  emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: list }, { kind: 'model', model: 'claude-sonnet-5-5' });
  const menu = await open();
  expect(within(menu).getByText('Sonnet')).toBeInTheDocument();
  expect(within(menu).queryByText('Sonnet 5')).toBeNull();
  await userEvent.click(within(menu).getByText(/Other versions/));
  expect(within(menu).getByText('Sonnet 5')).toBeInTheDocument();
  await userEvent.click(within(menu).getByText(/Other versions/));
  expect(within(menu).queryByText('Sonnet 5')).toBeNull();
  await userEvent.keyboard('{Escape}');
  emit({ kind: 'model', model: 'claude-sonnet-5' });
  const m2 = await open();
  expect(within(m2).getByText('Sonnet 5')).toBeInTheDocument(); // the model in use is listed there: shown open
});

const ROUTER: ModelOption[] = [
  ...['fable-5', 'haiku-5-5', 'opus-5', 'opus-5-5', 'sonnet-5', 'sonnet-5-5'].map((m) => ({ value: `anthropic/claude-${m}`, name: `Claude ${m}`, description: `anthropic/claude-${m}` })),
  ...['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-flash'].map((m) => ({ value: `google/${m}`, name: m, description: `google/${m}` })),
  { value: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', description: 'openai/gpt-oss-120b' },
  { value: 'local-model', name: 'Local', description: 'no provider' },
];

it('a router\'s list: grouped by provider, the provider in use first; it scrolls inside the menu', async () => {
  const { emit } = setup();
  emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: ROUTER }, { kind: 'model', model: 'google/gemini-3-flash' });
  const menu = await open();
  const groups = within(menu).getAllByRole('group').filter((g) => g.getAttribute('aria-label') !== 'Effort');
  expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['google', 'anthropic', 'openai']);
  expect(within(groups[0]!).getAllByRole('menuitem').map((r) => r.querySelector('b')?.textContent)).toEqual(['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-flash']);
  expect(within(menu).getByText('Local')).toBeInTheDocument(); // no provider: listed too, without a header
  expect(within(menu).queryByText(/Other versions/)).toBeNull();
  expect(screen.getByTestId('model-list').className).toMatch(/overflow-y-auto/);
});

it('a long list has a search field, focused on open: every word must match the name, id or description', async () => {
  const { emit, sent } = setup();
  emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: ROUTER }, { kind: 'model', model: 'anthropic/claude-opus-5' });
  const menu = await open();
  const search = within(menu).getByRole('searchbox', { name: 'Search models' });
  await vi.waitFor(() => expect(search).toHaveFocus());
  await userEvent.type(search, 'opus 5-5');
  expect(within(menu).getAllByRole('menuitem').map((r) => r.querySelector('b')?.textContent)).toEqual(['Claude opus-5-5']);
  await userEvent.clear(search);
  await userEvent.type(search, 'google flash');
  expect(within(menu).getAllByRole('menuitem').map((r) => r.querySelector('b')?.textContent)).toEqual(['gemini-3-flash', 'gemini-2.5-flash']);
  await userEvent.keyboard('{ArrowDown}');
  expect(within(menu).getByText('gemini-3-flash').closest('[role="menuitem"]')).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'google/gemini-3-flash' });
});

it('search: nothing found says so; Esc clears the query first, then closes', async () => {
  const { emit } = setup();
  emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: ROUTER }, { kind: 'model', model: 'anthropic/claude-opus-5' });
  const menu = await open();
  const search = within(menu).getByRole('searchbox');
  await userEvent.type(search, 'zzz');
  expect(within(menu).getByText('No model matches')).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(search).toHaveValue('');
  expect(screen.getByRole('menu')).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
});

it('a short list has no search field', async () => {
  const { ready } = setup();
  ready();
  const menu = await open();
  expect(within(menu).queryByRole('searchbox')).toBeNull();
});
