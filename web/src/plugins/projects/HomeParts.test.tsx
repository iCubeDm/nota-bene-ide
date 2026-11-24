// Issue 651: the home page's parts in the app's frame: the title with the counts, the Projects panel (each project with
// its agents open), the footer's counts, and the rail's Home tile.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang, t } from '@/core/i18n/index.ts';
import { makeStore } from '@/core/testing';
import { Home } from '@/core/shell/Home.tsx';
import type { ProjectsList } from './api.ts';
import { nav } from './api.ts';

const row = (provider: 'claude' | 'codex', root: string, id: string, state: 'working' | 'waiting' | 'idle', unseen = 0) =>
  ({ provider, port: 4791, root, title: null, session: null, state, current: false, clients: 0, unseen, last: null, agent: id, id });
const LIST: ProjectsList = {
  running: [row('claude', '/w/site', 'claude-aaaaaa', 'working'), row('codex', '/w/site', 'codex-bbbbbb', 'waiting'), row('claude', '/w/notes', 'claude-cccccc', 'idle', 2)],
  recent: [{ root: '/w/blog', provider: 'claude', at: 1, running: false }],
  hidden: [],
};

beforeEach(() => {
  setLang('en');
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = String(u);
    if (url === '/system/projects') return Response.json(LIST);
    if (url === '/system/prefs') return Response.json({ projectRail: true });
    return Response.json({});
  }));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(nav, 'go').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const setup = () => render(<Provider store={makeStore({ url: 'ws://x', socket: false })}><Home /></Provider>);
const panel = () => document.getElementById('projects-panel')!;

it('the title counts projects and agents', async () => {
  setup();
  const header = screen.getByRole('banner');
  expect(within(header).getByText('Nota Bene')).toBeTruthy();
  await waitFor(() => expect(within(header).getByText(t('homeCounts', 2, 3))).toBeTruthy());
});

it('the Projects panel lists each project with its agents open, and Recent', async () => {
  setup();
  await waitFor(() => expect(within(panel()).getByRole('group', { name: t('projSessionsOf', 'site') })).toBeTruthy());
  expect(within(panel()).getByRole('group', { name: t('projSessionsOf', 'notes') })).toBeTruthy();
  expect(within(panel()).getByRole('button', { name: /^blog · / })).toBeTruthy();
});

it('the toggle closes and opens the panel', async () => {
  setup();
  const toggle = await screen.findByRole('button', { name: t('projProjects') });
  expect(panel().hidden).toBe(false);
  fireEvent.click(toggle);
  expect(panel().hidden).toBe(true);
  fireEvent.click(toggle);
  expect(panel().hidden).toBe(false);
});

it('the footer counts working, waiting and idle agents', async () => {
  setup();
  const footer = screen.getByRole('contentinfo');
  await waitFor(() => expect(within(footer).getByText(t('homeWorking', 1))).toBeTruthy());
  expect(within(footer).getByText(t('homeWaiting', 1))).toBeTruthy();
  expect(within(footer).getByText(t('homeIdle', 1))).toBeTruthy();
});

it('the rail\'s Home tile is the current one on the home page', async () => {
  setup();
  const home = await screen.findByRole('button', { name: t('home') });
  expect(home.getAttribute('aria-current')).toBe('true');
  fireEvent.click(home);
  expect(nav.go).not.toHaveBeenCalled();
});
