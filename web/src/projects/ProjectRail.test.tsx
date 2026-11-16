import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang, t } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import type { ProjectsList } from './api.ts';
import { nav, projectsMenu, setStarter } from './api.ts';
import { ProjectRail } from './ProjectRail.tsx';
import { ProjectSwitcher } from './ProjectSwitcher.tsx';
import { railPref } from './railPref.ts';

const URL_OK = `http://127.0.0.1:4793/#t=${'a'.repeat(64)}`;
const at = (n: number, text = 'x') => ({ role: 'assistant' as const, text, at: n });

// the server's order is by urgency; the rail's must not follow it
const LIST: ProjectsList = {
  running: [
    { provider: 'claude', port: 4792, root: '/w/site', title: 'Fix the login form', session: 's2', state: 'waiting', current: false, clients: 0, unseen: 0, last: at(40) },
    { provider: 'codex', port: 4793, root: '/w/site', title: null, session: 's3', state: 'working', current: false, clients: 0, unseen: 2, last: at(30) },
    { provider: 'claude', port: 4795, root: '/w/Blog', title: 'Draft', session: 's4', state: 'idle', current: false, clients: 0, unseen: 3, last: at(20) },
    { provider: 'claude', port: 4791, root: '/w/notes', title: 'Weekly notes', session: 's1', state: 'idle', current: true, clients: 1, unseen: 0, last: at(50) },
    { provider: 'omp', port: 4794, root: '/w/gone', title: null, session: null, state: 'restarting', current: false, clients: 0, unseen: 0, last: null },
    { provider: 'claude', port: 4790, root: '/x/blog', title: null, session: null, state: 'idle', current: false, clients: 0, unseen: 0, last: null },
  ],
  recent: [],
  hidden: [],
};

let calls: string[];
beforeEach(() => {
  setLang('en');
  localStorage.clear();
  railPref.reload();
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    calls.push(url);
    if (url === '/system/projects') return Response.json(LIST);
    if (url === '/system/projects/enter') return Response.json({ url: URL_OK });
    if (url === '/system/prefs' && init?.method === 'POST') return Response.json(JSON.parse(String(init.body)));
    if (url === '/system/prefs') return Response.json({ projectRail: true });
    return new Response('[]');
  }));
  vi.spyOn(nav, 'go').mockImplementation(() => {});
});
afterEach(() => { cleanup(); act(() => projectsMenu.close()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const store = () => makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
const rail = () => screen.getByRole('navigation', { name: t('projRail') });
const tiles = () => within(rail()).getAllByRole('button').filter((b) => b.hasAttribute('data-root'));
const tile = (root: string) => tiles().find((b) => b.dataset.root === root)!;
const setup = async () => {
  render(<Provider store={store()}><TooltipProvider><ProjectRail /></TooltipProvider></Provider>);
  await waitFor(() => expect(tiles().length).toBe(5));
};

it('one tile per folder, in a stable order by name (case-insensitive, then path), not by urgency', async () => {
  await setup();
  expect(tiles().map((b) => b.dataset.root)).toEqual(['/w/Blog', '/x/blog', '/w/gone', '/w/notes', '/w/site']);
});

it('the badge: ! when an agent of the folder waits, else its unseen replies, else none', async () => {
  await setup();
  expect(within(tile('/w/site')).getByText('!')).toBeInTheDocument();
  expect(within(tile('/w/site')).queryByText('2')).toBeNull();
  expect(within(tile('/w/Blog')).getByText('3')).toBeInTheDocument();
  expect(tile('/x/blog').querySelector('[data-badge]')).toBeNull();
});

it('the tooltip text names the folder, its agents, its state and the latest session', async () => {
  await setup();
  const label = tile('/w/site').getAttribute('aria-label')!;
  expect(label).toContain('site');
  expect(label).toContain('Claude, Codex');
  expect(label).toContain(t('projWaiting'));
  expect(label).toContain('Fix the login form');
});

it('this project is highlighted and a click on it goes nowhere; another moves there to its live window', async () => {
  await setup();
  expect(tile('/w/notes')).toHaveAttribute('aria-current', 'true');
  fireEvent.click(tile('/w/notes'));
  fireEvent.click(tile('/w/Blog'));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  expect(calls.filter((u) => u === '/system/projects/enter')).toHaveLength(1);
});

it('a project with no live window is dimmed, says why, and does not move', async () => {
  await setup();
  const gone = tile('/w/gone');
  expect(gone).toHaveAttribute('aria-disabled', 'true');
  expect(gone.className).toContain('opacity-');
  expect(gone.getAttribute('aria-label')).toContain(t('projRestarting'));
  fireEvent.click(gone);
  await act(async () => { await Promise.resolve(); });
  expect(calls).not.toContain('/system/projects/enter');
});

it('+ opens the starter on Open folder', async () => {
  const f = vi.fn();
  setStarter(f);
  await setup();
  fireEvent.click(within(rail()).getByRole('button', { name: t('projOpenFolder') }));
  expect(f).toHaveBeenCalledWith('open');
  setStarter(null);
});

it('the setting hides it, for every window (saved on the server)', async () => {
  await setup();
  act(() => railPref.choose(false));
  expect(screen.queryByRole('navigation', { name: t('projRail') })).toBeNull();
  await waitFor(() => expect(calls).toContain('/system/prefs'));
  expect(localStorage.getItem('nb.projectRail')).toBe('0');
});

it('the rail and the header switcher share one poll, every 3 s while the rail shows', async () => {
  vi.useFakeTimers();
  render(<Provider store={store()}><TooltipProvider><ProjectSwitcher project="notes" windowTitle="notes" /><ProjectRail /></TooltipProvider></Provider>);
  const polls = () => calls.filter((u) => u === '/system/projects').length;
  expect(polls()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(polls()).toBe(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(polls()).toBe(3);
});

it('without the rail the header switcher alone polls every 10 s, as before', async () => {
  vi.useFakeTimers();
  render(<Provider store={store()}><TooltipProvider><ProjectSwitcher project="notes" windowTitle="notes" /></TooltipProvider></Provider>);
  const polls = () => calls.filter((u) => u === '/system/projects').length;
  expect(polls()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(polls()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
  expect(polls()).toBe(2);
});
