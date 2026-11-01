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
  models: [{ key: 'claude-opus-5-5', ...row({ w: 240_000_000 }) }, { key: 'claude-sonnet', ...row({ w: 60_000_000, calls: 40 }) }],
  projects: [{ key: 'app', ...row() }],
  tasks: [{
    ...row({ w: 20_000_000 }), id: 't1', ts: 1, label: 'Review the parser', project: 'app', models: { 'claude-opus': 20_000_000 },
    agents: [{ id: 'a1', label: 'Explore: routes', model: 'claude-sonnet', calls: 9, w: 5_000_000 }],
    top: [{ ts: 1, model: 'claude-opus', in: 1, out: 2, write: 3, read: 4, w: 9_000_000 }],
  }],
  hits: [{ ts: 1, kind: '5h', calls: 954, w: 23_000_000, projects: { app: 18_000_000, film: 5_000_000 }, models: { 'claude-opus': 23_000_000 }, tasks: [{ id: 't1', label: 'Long job', w: 20_000_000 }] }],
  weeks: [{ key: '2026-10-05', w: 1000, hit: false }, { key: '2026-10-12', w: 2_500_000, hit: true }],
  windows: [{ from: 1, w: 500, hit: false }, { from: 2, w: 23_000_000, hit: true }], tanks: [{ from: 1, to: 2, pct: 10, w: 1000, perPct: 100 }], extra: null,
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

it('shows the meter, the model mix, the hits and the tank', async () => {
  setup();
  await screen.findByText('Review the parser');
  expect(screen.getByRole('img', { name: '300.0M' })).toBeTruthy();
  expect(screen.getByText('Calls: 1,200, subagents 33%')).toBeTruthy();
  expect(screen.getByText('Opus 5.5')).toBeTruthy();
  expect(screen.getByText('app 78%, film 22%')).toBeTruthy();
  expect(screen.getByText('red: ended on a limit hit')).toBeTruthy();
  expect(screen.getByRole('img', { name: '5-hour windows' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Weeks' })).toBeTruthy();
  expect(screen.getByText('Per 1% of the weekly limit:').textContent).toContain('100');
});

it('a bar says its tokens under the pointer, the low one too, and whether it was a hit', async () => {
  setup();
  const weeks = await screen.findByRole('img', { name: 'Weeks' });
  const bars = weeks.querySelectorAll('[data-bar]');
  const chart = within(weeks.parentElement!);
  fireEvent.mouseEnter(bars[0]!);
  expect(chart.getByRole('status').textContent).toBe('Oct 5 – Oct 11total1.0k');
  fireEvent.mouseEnter(bars[1]!);
  expect(chart.getByRole('status').textContent).toBe('Oct 12 – Oct 18total2.5Mlimit hit');
  fireEvent.mouseLeave(weeks.parentElement!);
  expect(chart.queryByRole('status')).toBeNull();
});

it('the hits are a table, and a row opens to the tasks that ate its window', async () => {
  setup();
  await screen.findByText('app 78%, film 22%');
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['When', 'Limit', 'Tokens', 'Calls', 'Projects']);
  expect(screen.queryByText('Long job')).toBeNull();
  fireEvent.click(screen.getByText('app 78%, film 22%'));
  expect(screen.getByText('Long job')).toBeTruthy();
});

it('extra usage: its tokens and dollars, the month, and the share of a hit', async () => {
  const hit = { ...REPORT.hits[0]!, extra: { calls: 5, w: 4_000_000, spent: 1250 } };
  reply = () => ({ ...REPORT, hits: [hit], extra: { calls: 5, w: 4_000_000, spent: 1250, month: 1800, limit: 10_000, currency: 'USD' } });
  setup();
  expect((await screen.findByText(/^Extra usage:/)).textContent).toBe('Extra usage: 4.0M tokens, $12.50. This billing period: $18.00 of $100.00.');
  fireEvent.click(screen.getByText('app 78%, film 22%'));
  expect(screen.getByText('On extra usage after this hit: 4.0M tokens, $12.50')).toBeTruthy();
});

it('a bar carries its extra usage on top, says it under the pointer, and the legend names it', async () => {
  reply = () => ({ ...REPORT, weeks: [{ key: '2026-10-05', w: 1000, hit: false }, { key: '2026-10-12', w: 4_000_000, hit: true, extra: 1_000_000 }] });
  setup();
  const weeks = await screen.findByRole('img', { name: 'Weeks' });
  expect(weeks.querySelectorAll('[data-extra]')).toHaveLength(1);
  expect((weeks.querySelector('[data-extra]') as HTMLElement).style.height).toBe('25%');
  screen.getByText('red: ended on a limit hit, orange: extra usage');
  fireEvent.mouseEnter(weeks.querySelectorAll('[data-bar]')[1]!);
  expect(within(weeks.parentElement!).getByRole('status').textContent).toMatch(/total4\.0Mwithin limits3\.0Mextra usage1\.0Mlimit hit$/);
});

it('a bar that went wholly on extra usage has no empty line for the limit', async () => {
  reply = () => ({ ...REPORT, weeks: [{ key: '2026-10-05', w: 1000, hit: false }, { key: '2026-10-12', w: 2_000_000, hit: false, extra: 2_000_000 }] });
  setup();
  const weeks = await screen.findByRole('img', { name: 'Weeks' });
  fireEvent.mouseEnter(weeks.querySelectorAll('[data-bar]')[1]!);
  expect(within(weeks.parentElement!).getByRole('status').textContent).toMatch(/total2\.0Mextra usage2\.0M$/);
});

it('extra usage with no reading says the sum is unknown', async () => {
  reply = () => ({ ...REPORT, extra: { calls: 5, w: 4_000_000, spent: null, month: null, limit: null, currency: null } });
  setup();
  expect((await screen.findByText(/^Extra usage:/)).textContent).toBe('Extra usage: 4.0M tokens, sum unknown.');
});

it('what a period has nothing for is not there', async () => {
  reply = () => ({ ...REPORT, hits: [], tanks: [], weeks: [], windows: [] });
  setup();
  await screen.findByText('Review the parser');
  expect(screen.queryByText('Limit hits')).toBeNull();
  expect(screen.queryByText(/^Extra usage:/)).toBeNull();
});

it('five rows, then all of them; the projects share the list', async () => {
  const tasks = [...Array(7).keys()].map((i) => ({ ...REPORT.tasks[0]!, id: `t${i}`, label: `Task ${i}` }));
  reply = () => ({ ...REPORT, tasks });
  setup();
  await screen.findByText('Task 4');
  expect(screen.queryByText('Task 5')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'All 7' }));
  expect(screen.getByText('Task 6')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
  expect(screen.queryByText('Task 6')).toBeNull();
  expect(screen.getAllByText('app').length).toBeGreaterThan(0);
});

it('a project row says its share of everything spent; its subagents are in the tip', async () => {
  reply = () => ({
    ...REPORT,
    total: row({ w: 1_000_000_000 }),
    projects: [{ key: 'app', ...row({ w: 610_000_000, sub: 300_000_000 }) }, { key: 'film', ...row({ w: 385_000_000, sub: 0 }) }, { key: 'note', ...row({ w: 5_000_000, sub: 0 }) }],
  });
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Projects' }));
  const line = (name: string) => screen.getByText(name).parentElement!;
  expect(line('app').textContent).toBe('app61%610.0M');
  expect(line('app').title).toBe('Subagents 49%');
  expect(line('film').textContent).toBe('film39%385.0M');
  expect(line('film').title).toBe('');
  expect(line('note').textContent).toBe('note<1%5.0M');
});

it('a task opens to its subagents and costliest calls', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: /Review the parser/ }));
  expect(screen.getByText('Explore: routes')).toBeTruthy();
  expect(screen.getByText('Costliest calls')).toBeTruthy();
  expect(screen.getByText(/^main agent/)).toBeTruthy();
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
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(posts).toEqual([]);
  const ask = screen.getByText(/Start counting from now/).parentElement!;
  fireEvent.click(within(ask).getByRole('button', { name: 'Reset' }));
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
