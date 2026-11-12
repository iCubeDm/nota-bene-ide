import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
const stopsOf = (menu: HTMLElement) => Array.from(within(menu).getByRole('slider', { name: 'Effort' }).querySelectorAll<HTMLElement>('[data-stop]'));
const open = async () => { await userEvent.click(pill()); return screen.findByRole('menu'); };

it('renders nothing until a model or a list is known', () => {
  setup();
  expect(screen.queryByRole('button', { name: /Model and effort/ })).toBeNull();
});

it('shows the current model by its list name (the CLI reports the resolved id); the effort is in the accessible name', () => {
  const { ready } = setup();
  ready();
  expect(pill()).toHaveTextContent(/^Sonnet 5$/); // the effort is a mini bar, not text
  expect(pill()).toHaveAccessibleName(/^Sonnet 5 · Medium · Model and effort/);
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
  expect(within(menu).getAllByRole('slider', { name: 'Effort' })).toHaveLength(1);
  expect(within(menu).getByRole('slider', { name: 'Effort' })).toHaveAttribute('aria-valuetext', 'Medium');
  expect(stopsOf(menu)).toHaveLength(4); // Auto + Low, Medium, High
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
  expect(pill()).toHaveTextContent(/^Opus 5$/); // the CLI's default: the first row with that id, named by its sibling
  const menu = await open();
  await userEvent.click(within(menu).getByText('Opus 5'));
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'opus' });
});

it('picking an effort of the current model sends model + effort; the current choice sends nothing', async () => {
  const { sent, ready } = setup();
  ready();
  const menu = await open();
  const n = sent.length;
  await userEvent.click(stopsOf(menu)[2]!); // Medium
  expect(sent).toHaveLength(n);
  await userEvent.click(stopsOf(menu)[3]!); // High
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
  expect(pill()).toHaveTextContent(/^Opus 5$/);
  expect(pill()).toHaveAccessibleName(/^Opus 5 · Max · /);
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

const SUFFIXED: ModelOption[] = [
  { value: 'default', name: 'Default', description: 'd', resolved: 'claude-sonnet-5', efforts: ['low', 'medium'] },
  { value: 'opus', name: 'Opus 5.5', description: 'o', resolved: 'claude-opus-5-5', efforts: ['low', 'high', 'max'] },
];
const suffixed = (model: string, models = SUFFIXED) => {
  const s = setup();
  s.emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models }, { kind: 'model', model, effort: 'high' });
  return s;
};

it('a session id with a [1m] suffix finds its row: the name, the check and the effort row', async () => {
  suffixed('claude-opus-5-5[1m]');
  expect(pill()).toHaveTextContent(/^Opus 5\.5\s*1M$/);
  expect(pill()).toHaveAccessibleName(/^Opus 5\.5 1M · High · /);
  const menu = await open();
  const rows = within(menu).getAllByRole('menuitem').filter((e) => !e.closest('[role="group"]'));
  expect(rows[1]).toHaveAttribute('aria-current', 'true');
  expect(rows[0]).not.toHaveAttribute('aria-current');
  expect(stopsOf(menu)).toHaveLength(4); // Auto + Low, High, Max
});

it('an effort click on a suffixed session model keeps its exact id (no switch to the alias)', async () => {
  const { sent } = suffixed('claude-opus-5-5[1m]');
  const menu = await open();
  await userEvent.click(stopsOf(menu)[3]!); // Max
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'claude-opus-5-5[1m]', effort: 'max' });
});

it('with no matching row the default row\'s effort levels stay selectable, sent for the session id', async () => {
  const { sent } = suffixed('claude-mystery-9[1m]');
  expect(pill()).toHaveTextContent(/^claude-mystery-9\s*1M$/); // the id without its suffix, and the tag
  expect(pill()).toHaveAccessibleName(/^claude-mystery-9 1M · High · /);
  const menu = await open();
  expect(stopsOf(menu)).toHaveLength(3); // Auto + Low, Medium
  await userEvent.click(stopsOf(menu)[1]!); // Low
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'claude-mystery-9[1m]', effort: 'low' });
});

it('an unsuffixed session on Default: an effort click sends the row value, default', async () => {
  const { sent } = suffixed('claude-sonnet-5');
  expect(pill()).toHaveTextContent(/^Default$/); // no row shares its model: the default row's name, its parenthetical dropped
  expect(pill()).toHaveAccessibleName(/^Default · High · /);
  const menu = await open();
  await userEvent.click(stopsOf(menu)[1]!); // Low
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'default', effort: 'low' });
});

const WIDE: ModelOption[] = [{ value: 'sonnet', name: 'Sonnet 5', description: 'd', resolved: 'claude-sonnet-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }];
const slider = (menu: HTMLElement) => within(menu).getByRole('slider', { name: 'Effort' });

it('the effort slider shows the current level and its stops, Auto first', async () => {
  const s = setup();
  s.emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: WIDE }, { kind: 'model', model: 'claude-sonnet-5', effort: 'high' });
  const sl = slider(await open());
  expect(sl).toHaveAttribute('aria-valuetext', 'High');
  expect(sl).toHaveAttribute('aria-valuemax', '5');
  expect(sl).toHaveTextContent('High');
});

it('the fill reaches the current stop: High of Auto/Low/Medium/High/Xhigh/Max is 3/5, Auto is empty', async () => {
  const s = setup();
  s.emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: WIDE }, { kind: 'model', model: 'claude-sonnet-5', effort: 'high' });
  const menu = await open();
  const fill = () => slider(menu).querySelector<HTMLElement>('[data-fill]')!;
  expect(stopsOf(menu)).toHaveLength(6);
  expect(fill().style.width).toBe('60%');
  s.emit({ kind: 'model', model: 'claude-sonnet-5' });
  expect(slider(menu)).toHaveAttribute('aria-valuetext', 'Auto');
  expect(fill().style.width).toBe('0%');
});

it('ArrowRight from High picks Extra high through pickEffort, keeping the session model id', async () => {
  const s = setup();
  s.emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: WIDE }, { kind: 'model', model: 'claude-sonnet-5[1m]', effort: 'high' });
  const sl = slider(await open());
  act(() => sl.focus());
  await userEvent.keyboard('{ArrowRight}');
  expect(s.sent.at(-1)).toMatchObject({ type: 'model', model: 'claude-sonnet-5[1m]', effort: 'xhigh' });
  await userEvent.keyboard('{End}');
  expect(s.sent.at(-1)).toMatchObject({ effort: 'max' });
});

it('Auto clears the effort: a model message with no effort', async () => {
  const { sent, ready } = setup();
  ready();
  const sl = slider(await open());
  act(() => sl.focus());
  await userEvent.keyboard('{Home}');
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'sonnet' });
  expect(sent.at(-1)).not.toHaveProperty('effort');
  expect(sl).toHaveAttribute('aria-valuetext', 'Auto');
});

it('a click on a stop picks it, and the menu stays open', async () => {
  const s = setup();
  s.emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: WIDE }, { kind: 'model', model: 'claude-sonnet-5', effort: 'high' });
  const menu = await open();
  await userEvent.click(stopsOf(menu)[1]!);
  expect(s.sent.at(-1)).toMatchObject({ type: 'model', model: 'sonnet', effort: 'low' });
  expect(screen.queryByRole('menu')).not.toBeNull();
});

it('left/right/home/end keep the focus on the slider', async () => {
  const { ready } = setup();
  ready();
  const sl = slider(await open());
  act(() => sl.focus());
  await userEvent.keyboard('{ArrowLeft}{ArrowRight}{Home}{End}');
  expect(sl).toHaveFocus();
});

const wideSetup = (effort?: 'high') => {
  const s = setup();
  s.emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: WIDE }, { kind: 'model', model: 'claude-sonnet-5', ...(effort && { effort }) });
  return s;
};

it('a quick reversal before the echo sends the way back', async () => {
  const s = wideSetup('high');
  const sl = slider(await open());
  act(() => sl.focus());
  await userEvent.keyboard('{ArrowRight}{ArrowLeft}');
  expect(s.sent.at(-1)).toMatchObject({ type: 'model', effort: 'high' });
});

it('Auto, right, left before the echo ends on Auto', async () => {
  const s = wideSetup();
  const sl = slider(await open());
  act(() => sl.focus());
  await userEvent.keyboard('{ArrowRight}{ArrowLeft}');
  expect(s.sent.at(-1)).toMatchObject({ type: 'model', model: 'sonnet' });
  expect(s.sent.at(-1)).not.toHaveProperty('effort');
});

it('a press on the label or the name slot sends nothing', async () => {
  const s = wideSetup('high');
  const sl = slider(await open());
  const n = s.sent.length;
  const [label, track, slot] = Array.from(sl.children) as HTMLElement[];
  track!.getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 20, height: 20, x: 0, y: 0, toJSON() {} });
  for (const target of [label!, slot!]) {
    await userEvent.pointer([{ keys: '[MouseLeft>]', target, coords: { clientX: 100 } }, { keys: '[/MouseLeft]', coords: { clientX: 100 } }]);
  }
  expect(s.sent).toHaveLength(n);
});

it('a refused change: the echo with the unchanged level returns the slider to the actual level', async () => {
  const s = wideSetup('high');
  const sl = slider(await open());
  act(() => sl.focus());
  await userEvent.keyboard('{ArrowRight}');
  expect(sl).toHaveAttribute('aria-valuetext', 'Extra high');
  s.emit({ kind: 'model', model: 'claude-sonnet-5', effort: 'high' });
  expect(sl).toHaveAttribute('aria-valuetext', 'High');
  expect(sl).toHaveAttribute('aria-valuenow', '3');
});

it('the slider and its group have different accessible names', async () => {
  const s = wideSetup('high');
  const menu = await open();
  expect(within(menu).getAllByLabelText('Effort')).toHaveLength(1);
  void s;
});

// the pill label: a short name, a 1M tag, the effort as a mini bar; the full text is the accessible name and the tooltip
const effortBar = () => within(pill()).queryByTestId('effort-bar');
const fillOf = () => effortBar()!.querySelector<HTMLElement>('[data-fill]')!.style.width;
const LEVELS: ModelOption['efforts'] = ['low', 'medium', 'high', 'xhigh', 'max'];
const withDefault = (extra: ModelOption[], model = 'default', effort?: 'high' | 'xhigh') => {
  const s = setup();
  const list: ModelOption[] = [
    { value: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Best for most tasks', resolved: 'claude-opus-5-5', efforts: LEVELS },
    { value: 'sonnet', name: 'Sonnet 5', description: 's', resolved: 'claude-sonnet-5' },
    ...extra,
  ];
  s.emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: list }, { kind: 'model', model, ...(effort && { effort }) });
  return s;
};

it('the default row is shown under the name of the row that resolves to the same model, an alias row first', () => {
  withDefault([
    { value: 'claude-opus-5-5', name: 'Opus 5.5 (explicit id)', description: 'x', resolved: 'claude-opus-5-5' },
    { value: 'opus', name: 'Opus 5.5', description: 'o', resolved: 'claude-opus-5-5' },
  ]);
  expect(pill()).toHaveTextContent(/^Opus 5\.5$/);
});

it('with no alias, any row that resolves to the default\'s model gives its name', () => {
  withDefault([{ value: 'claude-opus-5-5', name: 'Opus 5.5 full', description: 'x', resolved: 'claude-opus-5-5' }]);
  expect(pill()).toHaveTextContent(/^Opus 5\.5 full$/);
});

it('with no sibling at all, the default row keeps its own name minus the trailing parenthetical', () => {
  withDefault([]);
  expect(pill()).toHaveTextContent(/^Default$/);
});

it('other rows show their own name', () => {
  withDefault([], 'sonnet');
  expect(pill()).toHaveTextContent(/^Sonnet 5$/);
});

it('a [1m] session id adds a small muted 1M tag; no suffix, no tag', () => {
  const s = suffixed('claude-opus-5-5[1m]');
  const tag = within(pill()).getByTestId('model-1m');
  expect(tag).toHaveTextContent('1M');
  expect(tag.className).toMatch(/text-muted-foreground/);
  s.emit({ kind: 'model', model: 'claude-opus-5-5', effort: 'high' });
  expect(within(pill()).queryByTestId('model-1m')).toBeNull();
});

it('the effort is a mini bar whose fill is the level among the model\'s levels; Auto has no bar', () => {
  const s = withDefault([], 'default', 'high');
  expect(effortBar()).toHaveAttribute('aria-hidden', 'true');
  expect(fillOf()).toBe('60%'); // High is 3 of low, medium, high, xhigh, max
  s.emit({ kind: 'model', model: 'default', effort: 'xhigh' });
  expect(fillOf()).toBe('80%');
  s.emit({ kind: 'model', model: 'default' });
  expect(effortBar()).toBeNull();
});

it('the accessible name carries the model name, the 1M tag and the effort name, then the tip', () => {
  withDefault([{ value: 'opus', name: 'Opus 5.5', description: 'o', resolved: 'claude-opus-5-5' }], 'claude-opus-5-5[1m]', 'xhigh');
  expect(pill()).toHaveAttribute('aria-label', 'Opus 5.5 1M · Extra high · Model and effort · a change applies from the next reply');
  expect(pill()).toHaveTextContent(/^Opus 5\.5\s*1M$/);
});

it('the tooltip repeats the full name and effort above the tip', async () => {
  withDefault([{ value: 'opus', name: 'Opus 5.5', description: 'o', resolved: 'claude-opus-5-5' }], 'default', 'xhigh');
  await userEvent.hover(pill());
  const tip = await screen.findAllByText(/Extra high/);
  expect(tip.some((e) => e.getAttribute('data-slot') === 'tooltip-content' && e.textContent === 'Opus 5.5 · Extra high\nModel and effort · a change applies from the next reply')).toBe(true);
});

it('Russian: the 1M tag and the effort name', () => {
  act(() => setLang('ru'));
  suffixed('claude-opus-5-5[1m]');
  const btn = screen.getByRole('button', { name: /Модель и усилие/ });
  expect(btn).toHaveAttribute('aria-label', expect.stringContaining('Opus 5.5 1M · Высокое · '));
});

it('the name slot fits the longest name: every name is in it, one visible', async () => {
  const sl = slider(await (async () => { wideSetup('high'); return open(); })());
  const names = Array.from((Array.from(sl.children)[2] as HTMLElement).children) as HTMLElement[];
  expect(names.map((n) => n.textContent)).toEqual(['Auto', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  expect(names.filter((n) => !n.className.includes('invisible')).map((n) => n.textContent)).toEqual(['High']);
});

// the detail line: the full description of the row under the pointer or focus, else the current row's
const LONG = 'The most capable model for the hardest tasks: long agentic work, deep refactors and careful review of large changes';
const DETAILED: ModelOption[] = [
  { value: 'sonnet', name: 'Sonnet 5', description: 'Everyday coding, fast and economical for most work, with a description far too long for one row of the menu', resolved: 'claude-sonnet-5', efforts: ['low', 'high'] },
  { value: 'opus', name: 'Opus 5', description: LONG, resolved: 'claude-opus-5', efforts: ['high', 'max'] },
  { value: 'haiku', name: 'Haiku 5', description: 'Fast', resolved: 'claude-haiku-5' },
];
const detailed = () => {
  const s = setup();
  s.emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: DETAILED }, { kind: 'model', model: 'claude-sonnet-5', effort: 'low' });
  return s;
};
const detail = (menu: HTMLElement) => within(menu).getByTestId('model-detail');

it('with nothing under the pointer or focus, the detail line shows the current row\'s full description', async () => {
  detailed();
  const menu = await open();
  expect(detail(menu)).toHaveTextContent(DETAILED[0]!.description);
});

it('hovering a row shows its full description in the detail line; leaving the menu returns to the current row\'s', async () => {
  detailed();
  const menu = await open();
  await userEvent.hover(within(menu).getByText('Opus 5'));
  expect(detail(menu)).toHaveTextContent(LONG);
  await userEvent.hover(within(menu).getByText('Haiku 5'));
  expect(detail(menu)).toHaveTextContent(/^Fast$/);
  fireEvent.pointerLeave(menu);
  expect(detail(menu)).toHaveTextContent(DETAILED[0]!.description);
});

it('a menu closed over a hovered row opens again on the current row\'s description', async () => {
  detailed();
  let menu = await open();
  await userEvent.hover(within(menu).getByText('Opus 5'));
  expect(detail(menu)).toHaveTextContent(LONG);
  await userEvent.keyboard('{Escape}');
  menu = await open();
  expect(detail(menu)).toHaveTextContent(DETAILED[0]!.description);
});

it('keyboard focus on a row does the same', async () => {
  detailed();
  const menu = await open();
  act(() => within(menu).getByText('Opus 5').closest<HTMLElement>('[role="menuitem"]')!.focus());
  expect(detail(menu)).toHaveTextContent(LONG);
  act(() => slider(menu).focus()); // the effort row is not a model: back to the current one
  expect(detail(menu)).toHaveTextContent(DETAILED[0]!.description);
});

it('the detail line is muted, wraps, keeps two lines of height and clamps at three; it sits between the list and the effort row', async () => {
  detailed();
  const menu = await open();
  const d = detail(menu);
  for (const c of ['text-muted-foreground', 'break-words', 'min-h-8', 'line-clamp-3', 'text-[0.71875rem]']) expect(d.className).toContain(c);
  expect(d.closest('div')!.className).toContain('border-t');
  expect(within(menu).getByTestId('model-list').compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(d.compareDocumentPosition(slider(menu)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('a row stays truncated, yet its accessible name keeps the full description', async () => {
  detailed();
  const menu = await open();
  const row = within(menu).getByRole('menuitem', { name: new RegExp(`Opus 5.*${LONG}`) });
  expect(row.querySelector('.truncate')).toHaveTextContent(LONG);
});
