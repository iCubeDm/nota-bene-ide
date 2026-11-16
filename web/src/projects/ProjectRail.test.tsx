import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang, t } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { getToasts } from '@/shell/toast.ts';
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
let projects: () => Response | Promise<Response>;
let enter: () => Response | Promise<Response>;
let prefsGet: () => Response | Promise<Response>;
let prefsPost: (body: Record<string, unknown>) => Response | Promise<Response>;
beforeEach(() => {
  setLang('en');
  localStorage.clear();
  railPref.reload();
  calls = [];
  projects = () => Response.json(LIST);
  enter = () => Response.json({ url: URL_OK });
  prefsGet = () => Response.json({ projectRail: true });
  prefsPost = (b) => Response.json(b);
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    calls.push(init?.method === 'POST' ? `POST ${url}` : url);
    if (url === '/system/projects') return projects();
    if (url === '/system/projects/enter') return enter();
    if (url === '/system/prefs' && init?.method === 'POST') return prefsPost(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (url === '/system/prefs') return prefsGet();
    return new Response('[]');
  }));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
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
  expect(calls.filter((u) => u === 'POST /system/projects/enter')).toHaveLength(1);
});

it('a project with no live window is dimmed, says why, and does not move', async () => {
  await setup();
  const gone = tile('/w/gone');
  expect(gone).toHaveAttribute('aria-disabled', 'true');
  expect(gone.className).toContain('opacity-');
  expect(gone.getAttribute('aria-label')).toContain(t('projRestarting'));
  fireEvent.click(gone);
  await act(async () => { await Promise.resolve(); });
  expect(calls).not.toContain('POST /system/projects/enter');
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
  await waitFor(() => expect(calls).toContain('POST /system/prefs'));
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

// a window that has shown the rail before: it is there at once
const cached = (on: boolean) => { localStorage.setItem('nb.projectRail', on ? '1' : '0'); railPref.reload(); };
const polls = () => calls.filter((u) => u === '/system/projects').length;
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

it('a poll that never answers does not stop the next ones', async () => {
  vi.useFakeTimers();
  cached(true);
  let first = true;
  projects = () => (first ? ((first = false), new Promise<Response>(() => {})) : Response.json(LIST));
  render(<Provider store={store()}><TooltipProvider><ProjectRail /></TooltipProvider></Provider>);
  expect(polls()).toBe(1);
  await flush(3000);
  await flush(3000);
  expect(polls()).toBeGreaterThanOrEqual(2);
  expect(tiles().length).toBe(5);
});

it('a failed poll keeps the tiles it had', async () => {
  vi.useFakeTimers();
  render(<Provider store={store()}><TooltipProvider><ProjectRail /></TooltipProvider></Provider>);
  await flush();
  expect(tiles().length).toBe(5);
  projects = () => new Response('boom', { status: 500 });
  await flush(3000);
  expect(polls()).toBe(2);
  expect(tiles().length).toBe(5);
});

it('3 s only while the window has the focus; 10 s while merely visible', async () => {
  vi.useFakeTimers();
  cached(true);
  vi.mocked(document.hasFocus).mockReturnValue(false);
  render(<Provider store={store()}><TooltipProvider><ProjectRail /></TooltipProvider></Provider>);
  expect(polls()).toBe(1);
  await flush(3000);
  expect(polls()).toBe(1);
  await flush(7000);
  expect(polls()).toBe(2);
  vi.mocked(document.hasFocus).mockReturnValue(true);
  act(() => { window.dispatchEvent(new Event('focus')); });
  await flush(3000);
  expect(polls()).toBeGreaterThanOrEqual(3);
});

// this window and a sibling of another agent in the same folder
const SIBLINGS: ProjectsList = {
  running: [
    { provider: 'claude', port: 4791, root: '/w/notes', title: 'Weekly notes', session: 's1', state: 'idle', current: true, clients: 1, unseen: 4, last: at(50) },
    { provider: 'codex', port: 4796, root: '/w/notes', title: 'Refactor', session: 's7', state: 'waiting', current: false, clients: 0, unseen: 0, last: at(10) },
    { provider: 'claude', port: 4795, root: '/w/Blog', title: 'Draft', session: 's4', state: 'idle', current: false, clients: 0, unseen: 0, last: at(20) },
  ],
  recent: [],
};

it('this tile badges only its sibling windows; a click goes to the waiting one, and its tooltip says so', async () => {
  projects = () => Response.json(SIBLINGS);
  render(<Provider store={store()}><TooltipProvider><ProjectRail /></TooltipProvider></Provider>);
  await waitFor(() => expect(tiles().length).toBe(2));
  const mine = tile('/w/notes');
  expect(within(mine).getByText('!')).toBeInTheDocument();
  expect(mine.getAttribute('aria-label')).toContain(t('projSiblingWaits', 'Codex'));
  fireEvent.click(mine);
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  const body = vi.mocked(fetch).mock.calls.find(([u]) => String(u) === '/system/projects/enter')![1]!.body;
  expect(JSON.parse(String(body))).toMatchObject({ provider: 'codex', port: 4796 });
});

it('this window\'s own unseen replies never badge its tile, and with no sibling to go to a click does nothing', async () => {
  projects = () => Response.json({ ...SIBLINGS, running: SIBLINGS.running.filter((r) => r.provider !== 'codex') });
  render(<Provider store={store()}><TooltipProvider><ProjectRail /></TooltipProvider></Provider>);
  await waitFor(() => expect(tiles().length).toBe(2));
  expect(tile('/w/notes').querySelector('[data-badge]')).toBeNull();
  fireEvent.click(tile('/w/notes'));
  await act(async () => { await Promise.resolve(); });
  expect(calls).not.toContain('POST /system/projects/enter');
});

it('a click while a move is pending is ignored; a failed move reloads the list', async () => {
  let answer!: (r: Response) => void;
  enter = () => new Promise<Response>((res) => { answer = res; });
  await setup();
  fireEvent.click(tile('/w/Blog'));
  fireEvent.click(tile('/w/Blog'));
  fireEvent.click(tile('/w/site'));
  expect(calls.filter((u) => u === 'POST /system/projects/enter')).toHaveLength(1);
  const before = polls();
  await act(async () => { answer(new Response('no such window', { status: 409 })); });
  await waitFor(() => expect(polls()).toBe(before + 1));
  expect(nav.go).not.toHaveBeenCalled();
});

// issue 449: a move leaves the page with its pending flag up; Back brings it from the back/forward cache as it was left
it('a page restored by Back after a move switches again, with a fresh list', async () => {
  await setup();
  fireEvent.click(tile('/w/Blog'));
  await waitFor(() => expect(nav.go).toHaveBeenCalledTimes(1));
  const before = polls();
  act(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await waitFor(() => expect(polls()).toBe(before + 1));
  fireEvent.click(tile('/x/blog'));
  await waitFor(() => expect(nav.go).toHaveBeenCalledTimes(2));
  expect(calls.filter((u) => u === 'POST /system/projects/enter')).toHaveLength(2);
});

// issue 449: a navigation cancelled before the page leaves (Esc, Stop on a slow window) must not hold the rail
it('a move whose page never leaves does not block the next click', async () => {
  await setup();
  fireEvent.click(tile('/w/Blog'));
  await waitFor(() => expect(nav.go).toHaveBeenCalledTimes(1));
  fireEvent.click(tile('/x/blog'));
  await waitFor(() => expect(nav.go).toHaveBeenCalledTimes(2));
});

// issue 449: whether a restored page is visible at pageshow depends on the browser; a hidden one loads once it shows
it('a page restored while still hidden refreshes the list once it is visible', async () => {
  await setup();
  const before = polls();
  const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await act(async () => { await Promise.resolve(); });
  expect(polls()).toBe(before);
  vis.mockReturnValue('visible');
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(polls()).toBe(before + 1));
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { await Promise.resolve(); });
  expect(polls()).toBe(before + 1);
});

it('a new window with nothing cached shows no rail until the server says, and none when it is off', async () => {
  let say!: (r: Response) => void;
  prefsGet = () => new Promise<Response>((res) => { say = res; });
  render(<Provider store={store()}><TooltipProvider><ProjectRail /></TooltipProvider></Provider>);
  expect(screen.queryByRole('navigation', { name: t('projRail') })).toBeNull();
  await act(async () => { say(Response.json({ projectRail: false })); });
  expect(screen.queryByRole('navigation', { name: t('projRail') })).toBeNull();
  expect(railPref.get()).toBe(false);
});

it('a failed save says so and goes back to the server\'s value; saves go one at a time, the last wins', async () => {
  await setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const posted: unknown[] = [];
  prefsPost = async (b) => { posted.push(b.projectRail); await gate; return Response.json(b); };
  act(() => { railPref.choose(false); railPref.choose(true); });
  await act(async () => { await Promise.resolve(); });
  expect(posted).toEqual([false]);
  await act(async () => { release(); });
  await waitFor(() => expect(posted).toEqual([false, true]));
  expect(railPref.get()).toBe(true);

  prefsPost = () => new Response('nope', { status: 500 });
  act(() => railPref.choose(false));
  await waitFor(() => expect(getToasts().some((x) => x.title === t('railSaveFail', '500'))).toBe(true));
  await waitFor(() => expect(railPref.get()).toBe(true));
});
