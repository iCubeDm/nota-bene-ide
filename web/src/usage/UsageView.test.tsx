import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UsageReport, UsageRow } from '@nota-bene/shared';
import { App } from '@/App.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { selectTabs } from '@/tabs/slice.ts';
import { fmtTokens } from './UsageView.tsx';

const row = (o: Partial<UsageRow> = {}): UsageRow => ({ in: 10, out: 2_000_000, write: 5, read: 3_000_000_000, calls: 1200, w: 300_000_000, sub: 100_000_000, ...o });
const REPORT: UsageReport = {
  provider: 'claude', period: 'trip', from: null, trip: null, importing: false, total: row(),
  models: [{ key: 'claude-opus', ...row({ w: 240_000_000 }) }, { key: 'claude-sonnet', ...row({ w: 60_000_000, calls: 40 }) }],
  projects: [{ key: 'app', ...row() }],
  tasks: [{
    ...row({ w: 20_000_000 }), id: 't1', ts: 1, label: 'Review the parser', project: 'app', models: { 'claude-opus': 20_000_000 },
    agents: [{ id: 'a1', label: 'Explore: routes', model: 'claude-sonnet', calls: 9, w: 5_000_000 }],
    top: [{ ts: 1, model: 'claude-opus', in: 1, out: 2, write: 3, read: 4, w: 9_000_000 }],
  }],
  hits: [{ ts: 1, kind: '5h', calls: 954, w: 23_000_000, projects: { app: 18_000_000, film: 5_000_000 }, models: { 'claude-opus': 23_000_000 } }],
  weeks: [{ key: '2026-10-05', w: 1 }], tanks: [{ from: 1, to: 2, pct: 10, w: 1000, perPct: 100 }],
};

let reply: (url: string) => UsageReport;
let gets: string[];
let posts: { url: string; body: unknown }[];
beforeEach(() => {
  localStorage.clear();
  setLang('en');
  reply = () => REPORT;
  gets = [];
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({ ok: true }); }
    if (url.startsWith('/usage')) {
      gets.push(url);
      const q = new URL(url, 'http://x').searchParams;
      return Response.json({ ...reply(url), provider: q.get('provider'), period: q.get('period') });
    }
    return new Response('[]');
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(<Provider store={store}><App /></Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
  return store;
}

it('the header button opens one Usage tab', async () => {
  const store = setup();
  await screen.findByText('Review the parser');
  expect(selectTabs(store.getState()).active).toBe('usage');
  fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
  expect(selectTabs(store.getState()).open.filter((t) => t.kind === 'usage')).toHaveLength(1);
  expect(gets[0]).toBe('/usage?provider=claude&period=trip');
});

it('shows the totals, the hits, the models and the tank', async () => {
  setup();
  await screen.findByText('Review the parser');
  expect(screen.getAllByText('300.0M').length).toBeGreaterThan(0);
  expect(screen.getByText('calls: 1,200')).toBeTruthy();
  expect(screen.getByText('app 78%, film 22%')).toBeTruthy();
  expect(screen.getAllByText('opus').length).toBeGreaterThan(0);
  expect(screen.getByText('Tokens per 1% of the weekly limit')).toBeTruthy();
});

it('a task opens to its subagents and costliest calls', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Review the parser' }));
  expect(screen.getByText('Explore: routes')).toBeTruthy();
  expect(screen.getByText('Costliest calls')).toBeTruthy();
  expect(screen.getByText('main agent')).toBeTruthy();
});

it('provider and period reload the report; a late answer for the old choice is not shown', async () => {
  setup();
  await screen.findByText('Review the parser');
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  await waitFor(() => expect(gets).toContain('/usage?provider=codex&period=trip'));
  fireEvent.click(screen.getByRole('button', { name: '7 days' }));
  await waitFor(() => expect(gets).toContain('/usage?provider=codex&period=7d'));
});

it('asks before a reset, then counts from there', async () => {
  setup();
  await screen.findByText('Review the parser');
  const n = gets.length;
  fireEvent.click(screen.getByRole('button', { name: 'Reset the counter' }));
  expect(posts).toEqual([]);
  const ask = screen.getByText(/Start counting from now/).parentElement!;
  fireEvent.click(within(ask).getByRole('button', { name: 'Reset the counter' }));
  await waitFor(() => expect(posts).toEqual([{ url: '/usage/reset', body: { provider: 'claude' } }]));
  await waitFor(() => expect(gets.length).toBeGreaterThan(n));
});

it('says it is still reading, and asks again until the import ends', async () => {
  let importing = true;
  reply = () => ({ ...REPORT, importing });
  setup();
  await screen.findByText(/the numbers will grow/);
  importing = false;
  await waitFor(() => expect(screen.queryByText(/the numbers will grow/)).toBeNull(), { timeout: 4000 });
});

it('an empty period says so; a failure shows in the tab', async () => {
  reply = () => ({ ...REPORT, total: row({ calls: 0 }), tasks: [], models: [], projects: [], hits: [] });
  setup();
  await screen.findByText('No usage in this period.');
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/usage') ? new Response('', { status: 500 }) : new Response('[]'))));
  setup();
  expect((await screen.findByText(/Could not load the report/)).textContent).toContain('500');
});

it('fmtTokens: the unit that reads best, in the language', () => {
  expect(fmtTokens(999)).toBe('999');
  expect(fmtTokens(1500)).toBe('1.5k');
  expect(fmtTokens(2_500_000)).toBe('2.5M');
  expect(fmtTokens(3_000_000_000)).toBe('3.0B');
  setLang('ru');
  expect(fmtTokens(2_500_000)).toBe('2.5 млн');
});
