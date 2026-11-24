import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { setLang, t } from '@/core/i18n/index.ts';
import { getToasts } from '@/core/shell/toast.ts';
import { makeStore } from '@/core/testing';
import { page } from '@/core/net/local.ts';
import type { ProjectsList, RunningRow } from './api.ts';
import { enterFailure, nav, setProjectsMenu, setStarter } from './api.ts';
import { ProjectSwitcher } from './ProjectSwitcher.tsx';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const S4 = '44444444-4444-4444-8444-444444444444';
const URL_OK = `http://127.0.0.1:4793/#t=${'a'.repeat(64)}`;
const at = (n: number, text = 'x') => ({ role: 'assistant' as const, text, at: n });

const LIST: ProjectsList = {
  running: [
    { provider: 'claude', port: 4791, root: '/w/notes', title: 'Weekly notes', session: S1, state: 'idle', current: true, clients: 1, unseen: 0, last: at(50, 'notes reply') },
    { provider: 'claude', port: 4792, root: '/w/site', title: 'Fix the login form', session: S2, state: 'waiting', current: false, clients: 0, unseen: 0, last: at(40, 'May I run ffmpeg?') },
    { provider: 'codex', port: 4793, root: '/w/site', title: null, session: S3, state: 'working', current: false, clients: 0, unseen: 2, last: at(30, 'codex says') },
    { provider: 'omp', port: 4794, root: '/w/gone', title: null, session: null, state: 'restarting', current: false, clients: 0, unseen: 0, last: null },
    { provider: 'claude', port: 4795, root: '/w/blog', title: 'Draft', session: S4, state: 'idle', current: false, clients: 0, unseen: 3, last: at(20, 'blog reply') },
  ],
  recent: [
    { root: '/w/site', provider: 'claude', at: 2, running: true },
    { root: '/w/old', provider: 'claude', at: 1, running: false },
  ],
  hidden: [],
};
const LOCAL = { current: S1, root: '/w/notes', sessions: [
  { id: S1, title: 'Weekly notes', at: 9, size: 1, cwd: '/w/notes' },
  { id: S2.replace('2222', '5555'), title: 'Older notes', at: 5, size: 1, cwd: '/w/notes' },
  { id: S3.replace('3333', '6666'), title: 'Old idea', at: 3, size: 1, cwd: '/w/archive-x' },
  { id: S4.replace('4444', '7777'), title: 'In a subfolder', at: 4, size: 1, cwd: '/w/notes/web' },
] };

const URL_REMOTE = `http://localhost:50123/#t=${'b'.repeat(64)}`;
const STUDIO = { host: 'h1', name: 'Studio' };
/** another computer's window on the same folder and port as this one's */
const REMOTE: RunningRow = { provider: 'claude', port: 4791, root: '/w/notes', title: 'Studio notes', session: S2, state: 'idle', current: false, clients: 0, unseen: 0, last: at(60, 'from the studio'), remote: STUDIO };

let calls: { url: string; body: Record<string, unknown> | undefined }[];
let list: ProjectsList;
let enter: () => Response;
let hidden: string[];
beforeEach(() => {
  setLang('en');
  calls = [];
  hidden = [];
  list = LIST;
  enter = () => Response.json({ url: URL_OK });
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    if (url === '/system/projects') return Response.json({ ...list, recent: list.recent.filter((e) => !hidden.includes(e.root)), hidden });
    if (url === '/system/remote/open') {
      if (body?.host === 'h1') return Response.json({ url: URL_REMOTE });
      if (body?.host === 'h3') return Response.json({ error: 'not running' }, { status: 409 });
      if (body?.host === 'h4') return Response.json({ error: 'EACCES: some raw exception' }, { status: 500 });
      return Response.json({ error: 'no such window' }, { status: 404 });
    }
    if (url === '/system/projects/forget') { hidden.push(String(body?.root)); return Response.json({ ok: true }); }
    if (url === '/system/projects/enter') return enter();
    if (url === '/system/projects/open') return Response.json({ url: URL_OK });
    if (url === '/sessions') return Response.json(LOCAL);
    if (url === '/system/agents') return Response.json({ agents: ['claude', 'codex'], default: 'claude' });
    if (url === '/system/projects/sessions') {
      return Response.json(body?.provider === 'codex'
        ? { current: S3, sessions: [{ id: S3, title: '', at: 30 }] }
        : { current: S2, sessions: [{ id: S2, title: 'Fix the login form', at: 40 }, { id: S4, title: 'Earlier on site', at: 10 }] });
    }
    if (url === '/sessions/rename' || url === '/sessions/archive') return new Response('ok');
    if (url === '/system/projects/stop') return body?.provider === 'codex' ? new Response('window not answering', { status: 409 }) : Response.json({ ok: true });
    return new Response('[]');
  }));
  vi.spyOn(nav, 'go').mockImplementation(() => {});
});
// the store a test made last: the switcher's menu is its state
let current: ReturnType<typeof makeStore>;
const mk = (...a: Parameters<typeof makeStore>) => (current = makeStore(...a));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); page.remote = null; });

function setup() {
  const store = mk({ url: 'ws://x', connect: (_u, onEvent, onState) => {
    queueMicrotask(() => { (onState as (s: string) => void)('open'); onEvent({ kind: 'session', id: S1, root: '/w/notes', title: 'Weekly notes', model: null } as ServerEvent); });
    return { send: () => true, close() {} };
  } });
  render(<Provider store={store}><ProjectSwitcher project="notes" windowTitle="Weekly notes · notes · Nota Bene" /></Provider>);
  return store;
}
const openMenu = async () => {
  setup();
  await waitFor(() => expect(calls.some((c) => c.url === '/system/projects')).toBe(true));
  act(() => void current.dispatch(setProjectsMenu(true)));
  return screen.findByRole('textbox', { name: t('projSearch') });
};
const projectRow = (name: string) => within(screen.getByRole('group', { name: t('projProjects') })).getByRole('button', { name: new RegExp(`^${name} ·`) });

it('the trigger shows one badge: ! while another project waits; the tab title too', async () => {
  setup();
  const trigger = screen.getByRole('button', { name: /notes/ });
  await waitFor(() => expect(within(trigger).getByText('!')).toBeInTheDocument());
  // right of the ▾, out of the flow: the name and the path do not move when it comes, goes or grows to two digits
  expect(within(trigger).getByText('!').closest('[data-badge-over]')).toHaveClass('absolute');
  // the title is set by an effect after the badge renders: a slow runner may check in between
  await waitFor(() => expect(document.title).toBe('(!) Weekly notes · notes · Nota Bene'));
});

it('one row per folder: name, last message, session and agent below, one badge; waiting first, then unseen', async () => {
  await openMenu();
  const rows = within(screen.getByRole('group', { name: t('projProjects') })).getAllByRole('button', { name: /^(site|blog|notes|gone)\b/ }).map((b) => b.getAttribute('aria-label')!.split(' ')[0]);
  expect(rows).toEqual(['site', 'blog', 'notes', 'gone']);
  const site = projectRow('site');
  expect(site).toHaveTextContent('May I run ffmpeg?');
  expect(site).toHaveTextContent('Fix the login form · Claude');
  expect(within(site).getByText('!')).toBeInTheDocument();
  expect(within(projectRow('blog')).getByText('3')).toBeInTheDocument();
  expect(projectRow('notes')).toHaveTextContent(t('projThis'));
});

it('choosing another project moves there, to its newest window', async () => {
  await openMenu();
  fireEvent.click(projectRow('site'));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  expect(calls.find((c) => c.url === '/system/projects/enter')!.body).toEqual({ provider: 'claude', port: 4792, root: '/w/site' });
});

it('a failed move shows its reason and stays', async () => {
  enter = () => new Response('window not answering', { status: 409 });
  await openMenu();
  fireEvent.click(projectRow('blog'));
  await waitFor(() => expect(getToasts().some((x) => x.title === t('projEnterFailed', t('whyNotAnswering')))).toBe(true));
  expect(nav.go).not.toHaveBeenCalled();
});

it('this project starts expanded with its sessions; another expands on its chevron with both agents\' sessions', async () => {
  await openMenu();
  const mine = await screen.findByRole('group', { name: t('projSessionsOf', 'notes') });
  expect(within(mine).getByRole('button', { name: /^Older notes/ })).toBeInTheDocument();
  expect(within(mine).queryByText('Old idea')).toBeNull(); // another folder
  expect(within(mine).queryByRole('button', { name: /In a subfolder/ })).toBeNull(); // its own folder: not switchable here
  fireEvent.click(screen.getByRole('button', { name: t('projExpand', 'site') }));
  const site = await screen.findByRole('group', { name: t('projSessionsOf', 'site') });
  await waitFor(() => expect(within(site).getByRole('button', { name: /Earlier on site.*Claude/ })).toBeInTheDocument());
  expect(within(site).getByRole('button', { name: /untitled.*Codex/ })).toBeInTheDocument();
});

it('a session of another window opens there', async () => {
  await openMenu();
  fireEvent.click(screen.getByRole('button', { name: t('projExpand', 'site') }));
  const site = await screen.findByRole('group', { name: t('projSessionsOf', 'site') });
  fireEvent.click(await within(site).findByRole('button', { name: /Earlier on site/ }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  expect(calls.find((c) => c.url === '/system/projects/enter')!.body).toEqual({ provider: 'claude', port: 4792, root: '/w/site', session: S4 });
});

it('New session: one entry; the dialog picks the agent; with its window there it starts in it, without one a window is opened', async () => {
  await openMenu();
  fireEvent.click(screen.getByRole('button', { name: t('projExpand', 'blog') }));
  const blog = await screen.findByRole('group', { name: t('projSessionsOf', 'blog') });
  expect(within(blog).getAllByRole('button', { name: /New session/ })).toHaveLength(1);
  fireEvent.click(within(blog).getByRole('button', { name: t('projNewSess') }));
  let dlg = await screen.findByRole('dialog', { name: t('newQ') });
  const agent = within(dlg).getByRole('radiogroup', { name: t('startAgent') });
  await waitFor(() => expect(within(agent).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Claude', 'Codex']));
  expect(within(agent).getByRole('radio', { name: 'Claude' })).toBeChecked(); // this window's agent first
  fireEvent.click(within(dlg).getByRole('button', { name: t('projNewSessStart') }));
  await waitFor(() => expect(calls.find((c) => c.url === '/system/projects/enter')?.body).toEqual({ provider: 'claude', port: 4795, root: '/w/blog', session: 'new' }));
  act(() => void current.dispatch(setProjectsMenu(true)));
  fireEvent.click(screen.getByRole('button', { name: t('projExpand', 'blog') }));
  const again = await screen.findByRole('group', { name: t('projSessionsOf', 'blog') });
  fireEvent.click(within(again).getByRole('button', { name: t('projNewSess') }));
  dlg = await screen.findByRole('dialog', { name: t('newQ') });
  fireEvent.click(await within(dlg).findByRole('radio', { name: 'Codex' }));
  fireEvent.click(within(dlg).getByRole('button', { name: t('projNewSessStart') }));
  await waitFor(() => expect(calls.find((c) => c.url === '/system/projects/open')?.body).toEqual({ dir: '/w/blog', provider: 'codex' }));
});

it('recent lists folders not running, also from this window\'s session history; a session there opens a window on it', async () => {
  await openMenu();
  const recent = screen.getByRole('group', { name: t('projRecent') });
  expect(within(recent).getByRole('button', { name: /^old\b/ })).toBeInTheDocument();
  expect(within(recent).getByRole('button', { name: /^archive-x\b/ })).toBeInTheDocument();
  expect(within(recent).queryByRole('button', { name: /^site\b/ })).toBeNull();
  fireEvent.click(within(recent).getByRole('button', { name: t('projExpand', 'archive-x') }));
  fireEvent.click(await screen.findByRole('button', { name: /Old idea/ }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(`${URL_OK}&s=${S3.replace('3333', '6666')}`));
  expect(calls.find((c) => c.url === '/system/projects/open')!.body).toEqual({ dir: '/w/archive-x', provider: 'claude' });
});

it('✕ removes a folder from Recent, one from the launcher\'s list and one from this window\'s history alike', async () => {
  await openMenu();
  const recent = () => screen.getByRole('group', { name: t('projRecent') });
  fireEvent.click(within(recent()).getByRole('button', { name: t('projForget', 'old') }));
  await waitFor(() => expect(within(recent()).queryByRole('button', { name: /^old\b/ })).toBeNull());
  expect(calls.find((c) => c.url === '/system/projects/forget')!.body).toEqual({ root: '/w/old' });
  fireEvent.click(within(recent()).getByRole('button', { name: t('projForget', 'archive-x') }));
  await waitFor(() => expect(within(recent()).queryByRole('button', { name: /^archive-x\b/ })).toBeNull());
  expect(within(recent()).getByRole('button', { name: /^web\b/ })).toBeInTheDocument();
  // the next poll keeps them out: the server lists them as hidden
  act(() => void current.dispatch(setProjectsMenu(false)));
  act(() => void current.dispatch(setProjectsMenu(true)));
  await screen.findByRole('textbox', { name: t('projSearch') });
  await waitFor(() => expect(calls.filter((c) => c.url === '/system/projects').length).toBeGreaterThan(2));
  expect(within(recent()).queryByRole('button', { name: /^(old|archive-x)\b/ })).toBeNull();
});

it('search filters by folder, path and session title', async () => {
  const search = await openMenu();
  fireEvent.change(search, { target: { value: 'login' } });
  expect(projectRow('site')).toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: t('projProjects') })).queryByRole('button', { name: /^blog ·/ })).toBeNull();
  fireEvent.change(search, { target: { value: 'zzz' } });
  expect(screen.getByText(t('projNone'))).toBeInTheDocument();
});

it('a restarting project is shown with its state and does not move', async () => {
  await openMenu();
  fireEvent.click(projectRow('gone'));
  expect(nav.go).not.toHaveBeenCalled();
  expect(projectRow('gone')).toHaveTextContent(t('projRestarting'));
});

it('Open folder and New project close the menu and open the starter in that mode', async () => {
  const modes: string[] = [];
  setStarter((m) => modes.push(m));
  try {
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: t('projNew') }));
    expect(modes).toEqual(['new']);
    expect(current.getState().projects.menu).toBe(false);
    act(() => void current.dispatch(setProjectsMenu(true)));
    fireEvent.click(await screen.findByRole('button', { name: t('projOpenFolder') }));
    expect(modes).toEqual(['new', 'open']);
  } finally {
    setStarter(null);
  }
});

it('a session of this window asks first, then switches here', async () => {
  const sent: unknown[] = [];
  const store = mk({ url: 'ws://x', connect: (_u, onEvent, onState) => {
    queueMicrotask(() => { (onState as (s: string) => void)('open'); onEvent({ kind: 'session', id: S1, root: '/w/notes', title: 'Weekly notes', model: null } as ServerEvent); });
    return { send: (m: unknown) => { sent.push(m); return true; }, close() {} };
  } });
  render(<Provider store={store}><ProjectSwitcher project="notes" windowTitle="notes" /></Provider>);
  await waitFor(() => expect(calls.some((c) => c.url === '/system/projects')).toBe(true));
  act(() => void current.dispatch(setProjectsMenu(true)));
  const mine = await screen.findByRole('group', { name: t('projSessionsOf', 'notes') });
  fireEvent.click(await within(mine).findByRole('button', { name: /^Older notes/ }));
  const dlg = await screen.findByRole('dialog', { name: t('openQ', 'Older notes') });
  fireEvent.click(within(dlg).getByRole('button', { name: t('switchBtn') }));
  expect(sent).toContainEqual({ type: 'switch', id: S2.replace('2222', '5555'), dir: '/w/notes' });
});

it('a new session with this window\'s agent warns like a switch and starts here', async () => {
  const sent: unknown[] = [];
  const store = mk({ url: 'ws://x', connect: (_u, onEvent, onState) => {
    queueMicrotask(() => { (onState as (s: string) => void)('open'); onEvent({ kind: 'session', id: S1, root: '/w/notes', title: 'Weekly notes', model: null } as ServerEvent); });
    return { send: (m: unknown) => { sent.push(m); return true; }, close() {} };
  } });
  render(<Provider store={store}><ProjectSwitcher project="notes" windowTitle="notes" /></Provider>);
  await waitFor(() => expect(calls.some((c) => c.url === '/system/projects')).toBe(true));
  act(() => void current.dispatch(setProjectsMenu(true)));
  const mine = await screen.findByRole('group', { name: t('projSessionsOf', 'notes') });
  fireEvent.click(within(mine).getByRole('button', { name: t('projNewSess') }));
  const dlg = await screen.findByRole('dialog', { name: t('newQ') });
  expect(dlg).toHaveTextContent(t('switchWarn').trim().split('\n')[0]);
  await within(dlg).findByRole('radio', { name: 'Claude' });
  fireEvent.click(within(dlg).getByRole('button', { name: t('projNewSessStart') }));
  expect(sent).toContainEqual({ type: 'switch', id: null, dir: '/w/notes' });
});

it('this window\'s sessions can be renamed and archived from their row; the open one is not archived; another window\'s only open', async () => {
  await openMenu();
  const mine = await screen.findByRole('group', { name: t('projSessionsOf', 'notes') });
  expect(within(mine).getByRole('button', { name: `${t('renameSess')}: Weekly notes` })).toBeInTheDocument();
  expect(within(mine).queryByRole('button', { name: `${t('archiveSess')}: Weekly notes` })).toBeNull();
  fireEvent.click(within(mine).getByRole('button', { name: `${t('renameSess')}: Older notes` }));
  const box = within(mine).getByRole('textbox', { name: t('renameSess') });
  fireEvent.change(box, { target: { value: 'Newer name' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(calls.find((c) => c.url === '/sessions/rename')?.body).toEqual({ id: S2.replace('2222', '5555'), title: 'Newer name' }));
  expect(await within(mine).findByRole('button', { name: /^Newer name/ })).toBeInTheDocument();
  fireEvent.click(within(mine).getByRole('button', { name: `${t('archiveSess')}: Newer name` }));
  await waitFor(() => expect(calls.find((c) => c.url === '/sessions/archive')?.body).toEqual({ id: S2.replace('2222', '5555'), archived: true }));
  await waitFor(() => expect(within(mine).queryByRole('button', { name: /^Newer name/ })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: t('projExpand', 'site') }));
  const site = await screen.findByRole('group', { name: t('projSessionsOf', 'site') });
  await within(site).findByRole('button', { name: /Earlier on site/ });
  expect(within(site).queryByRole('button', { name: new RegExp(t('renameSess')) })).toBeNull();
});

it('another project stops from its row after a confirm, each live window of it; this one and a restarting one have no stop', async () => {
  await openMenu();
  const g = within(screen.getByRole('group', { name: t('projProjects') }));
  expect(g.queryByRole('button', { name: 'Stop notes' })).toBeNull();
  expect(g.queryByRole('button', { name: 'Stop gone' })).toBeNull();
  fireEvent.click(g.getByRole('button', { name: 'Stop site' }));
  const dlg = await screen.findByRole('dialog');
  expect(dlg).toHaveTextContent('Stop site?');
  expect(dlg).toHaveTextContent('Its agent stops (Claude, Codex)');
  expect(dlg).toHaveTextContent('An agent is working');
  fireEvent.click(within(dlg).getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(calls.filter((c) => c.url === '/system/projects/stop').map((c) => c.body)).toEqual([
    { provider: 'claude', port: 4792, root: '/w/site' },
    { provider: 'codex', port: 4793, root: '/w/site' },
  ]));
  await waitFor(() => expect(getToasts().some((x) => x.title === 'Could not stop: the window is not answering')).toBe(true));
});

it('epic 383: an agent the server opened is its folder\'s row: it moves and lists sessions as that agent', async () => {
  list = { ...LIST, running: [...LIST.running, { provider: 'codex', port: 4791, root: '/w/dh', title: 'Plan', session: S3, state: 'idle', current: false, clients: 0, unseen: 0, last: at(10, 'dh reply'), agent: 'codex-abcdef' }] };
  await openMenu();
  const g = within(screen.getByRole('group', { name: t('projProjects') }));
  fireEvent.click(g.getByRole('button', { name: t('projExpand', 'dh') }));
  await waitFor(() => expect(calls.find((c) => c.url === '/system/projects/sessions')?.body).toEqual({ provider: 'codex', port: 4791, root: '/w/dh', agent: 'codex-abcdef' }));
  fireEvent.click(projectRow('dh'));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  expect(calls.find((c) => c.url === '/system/projects/enter')!.body).toEqual({ provider: 'codex', port: 4791, root: '/w/dh', agent: 'codex-abcdef' });
});

it('epic 383: Stop on an agent\'s row closes it alone; a window whose server holds other projects has no stop', async () => {
  list = { ...LIST, running: [...LIST.running, { provider: 'codex', port: 4795, root: '/w/dh', title: 'Plan', session: S3, state: 'working', current: false, clients: 0, unseen: 0, last: at(10, 'dh reply'), agent: 'codex-abcdef' }] };
  await openMenu();
  const g = within(screen.getByRole('group', { name: t('projProjects') }));
  expect(g.queryByRole('button', { name: 'Stop blog' })).toBeNull(); // its server is dh's too
  fireEvent.click(g.getByRole('button', { name: 'Stop dh' }));
  const dlg = await screen.findByRole('dialog');
  expect(dlg).toHaveTextContent('Its agent stops (Codex)');
  fireEvent.click(within(dlg).getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(calls.filter((c) => c.url === '/system/projects/stop').map((c) => c.body)).toEqual([
    { provider: 'codex', port: 4795, root: '/w/dh', agent: 'codex-abcdef' },
  ]));
});

it('epic 383: the launcher\'s open-agent moves this tab to that agent of its server; anything else in it is no move', async () => {
  const store = setup();
  const { serverEvent } = await import('@/core/store/store.ts');
  act(() => { store.dispatch(serverEvent({ kind: 'open-agent', agent: 'codex-abcdef' })); });
  expect(nav.go).toHaveBeenCalledWith('/a/codex-abcdef/');
  act(() => { store.dispatch(serverEvent({ kind: 'open-agent', agent: '../x' })); });
  expect(nav.go).toHaveBeenCalledTimes(1);
});

// issue 449: Back to this page after a move from Recent brings it from the back/forward cache with the menu still open
it('a page restored by Back has the menu closed', async () => {
  await openMenu();
  expect(current.getState().projects.menu).toBe(true);
  act(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  expect(current.getState().projects.menu).toBe(false);
});

it('issue 297: another computer\'s window is a row of its own, with the laptop and its name; it opens through the connector', async () => {
  list = { ...LIST, running: [...LIST.running, REMOTE] };
  await openMenu();
  const notes = within(screen.getByRole('group', { name: t('projProjects') })).getAllByRole('button', { name: /^notes ·/ });
  expect(notes).toHaveLength(2);
  const remote = notes.find((b) => b.textContent!.includes('Studio'))!;
  expect(remote).toHaveTextContent('from the studio');
  expect(remote.getAttribute('aria-label')).toBe('notes · Studio · Studio notes · Claude');
  expect(remote.querySelector('[data-remote]')).not.toBeNull();
  expect(notes.find((b) => b !== remote)!.querySelector('[data-remote]')).toBeNull();
  // its sessions and its stop are that computer's: neither here
  expect(screen.getAllByRole('button', { name: t('projExpand', 'notes') })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: t('projStop', 'notes') })).toBeNull();
  fireEvent.click(remote);
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_REMOTE));
  expect(calls.find((c) => c.url === '/system/remote/open')!.body).toEqual({ host: 'h1', port: 4791 });
  expect(calls.some((c) => c.url === '/system/projects/enter')).toBe(false);
});

it('issue 297: a failed open of another computer\'s window says why and stays', async () => {
  list = { ...LIST, running: [...LIST.running, { ...REMOTE, remote: { host: 'h2', name: 'Gone' } }] };
  await openMenu();
  fireEvent.click(within(screen.getByRole('group', { name: t('projProjects') })).getAllByRole('button', { name: /^notes · Gone/ })[0]!);
  await waitFor(() => expect(getToasts().some((x) => x.title === t('projEnterFailed', t('whyNoWindow')))).toBe(true));
  expect(nav.go).not.toHaveBeenCalled();
});

it('issue 297: on another computer\'s page, a move is a navigation to its proxy; nothing to open, start or stop here', async () => {
  page.remote = STUDIO;
  list = { ...LIST, running: [...LIST.running.map((r) => ({ ...r, current: false })), { ...REMOTE, current: true }, { ...REMOTE, port: 4777, root: '/w/far', current: false }] };
  await openMenu();
  await screen.findByRole('group', { name: t('projProjects') });
  expect(screen.queryByRole('group', { name: t('projRecent') })).toBeNull();
  expect(screen.queryByRole('button', { name: t('projOpenFolder') })).toBeNull();
  expect(screen.queryByRole('button', { name: t('projNew') })).toBeNull();
  expect(screen.queryByRole('button', { name: t('projStop', 'blog') })).toBeNull();
  // this page's own folder still expands to its sessions
  expect(screen.getAllByRole('button', { name: t('projExpand', 'notes') })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: t('projExpand', 'blog') })).toBeNull();
  fireEvent.click(projectRow('blog'));
  expect(nav.go).toHaveBeenCalledWith('/system/remote/enter?provider=claude&port=4795&root=%2Fw%2Fblog');
  act(() => void current.dispatch(setProjectsMenu(true)));
  fireEvent.click(await screen.findByRole('button', { name: /^far ·/ }));
  expect(nav.go).toHaveBeenCalledWith('/system/remote/enter?host=h1&port=4777');
  expect(calls.some((c) => c.url === '/system/projects/enter' || c.url === '/system/remote/open')).toBe(false);
});

it('epic 383: another computer\'s agent opens by its id, through the connector or, from its page, the proxy', async () => {
  const far: RunningRow = { ...REMOTE, root: '/w/far', agent: 'codex-k3f7qz', provider: 'codex' };
  list = { ...LIST, running: [...LIST.running, far] };
  await openMenu();
  fireEvent.click(await screen.findByRole('button', { name: /^far ·/ }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_REMOTE));
  expect(calls.find((c) => c.url === '/system/remote/open')!.body).toEqual({ host: 'h1', port: 4791, agent: 'codex-k3f7qz' });
  page.remote = STUDIO;
  act(() => void current.dispatch(setProjectsMenu(true)));
  fireEvent.click(await screen.findByRole('button', { name: /^far ·/ }));
  expect(nav.go).toHaveBeenCalledWith('/system/remote/enter?host=h1&port=4791&agent=codex-k3f7qz');
});

it('issue 297: the connector\'s refusals are said in words, never its raw text', async () => {
  list = { ...LIST, running: [...LIST.running, { ...REMOTE, root: '/w/three', remote: { host: 'h3', name: 'Three' } }, { ...REMOTE, root: '/w/four', remote: { host: 'h4', name: 'Four' } }] };
  await openMenu();
  fireEvent.click(await screen.findByRole('button', { name: /^three ·/ }));
  await waitFor(() => expect(getToasts().some((x) => x.title === t('projEnterFailed', t('whyNotConnected')))).toBe(true));
  act(() => void current.dispatch(setProjectsMenu(true)));
  fireEvent.click(await screen.findByRole('button', { name: /^four ·/ }));
  await waitFor(() => expect(getToasts().some((x) => x.title === t('projEnterFailed', t('whyRemoteFailed')))).toBe(true));
  expect(getToasts().some((x) => x.title.includes('EACCES'))).toBe(false);
});

it('issue 297: a switch that came back to this page says why, once, and leaves the address clean', () => {
  const hist = { replaceState: vi.fn() } as unknown as History;
  for (const [code, why] of [['no-window', 'whyNoWindow'], ['not-connected', 'whyNotConnected'], ['login', 'whyNotLoggedIn'], ['not-answering', 'whyNotAnswering'], ['<b>raw</b>', 'whyRemoteFailed']] as const) {
    enterFailure({ search: `?enter=${encodeURIComponent(code)}`, pathname: '/', hash: '' } as Location, hist);
    expect(getToasts().some((x) => x.title === t('projEnterFailed', t(why))), code).toBe(true);
  }
  expect(hist.replaceState).toHaveBeenLastCalledWith(null, '', '/');
  const before = getToasts().length;
  enterFailure({ search: '', pathname: '/', hash: '' } as Location, hist);
  expect(getToasts().length).toBe(before);
});

it('issue 297: on another computer\'s page this folder\'s sessions ask nothing this computer\'s switcher alone answers', async () => {
  page.remote = STUDIO;
  list = { ...LIST, running: [...LIST.running.map((r) => ({ ...r, current: false })), { ...REMOTE, current: true }] };
  await openMenu();
  await screen.findByRole('group', { name: t('projSessionsOf', 'notes') });
  expect(calls.some((c) => c.url === '/system/agents' || c.url === '/system/projects/sessions')).toBe(false);
  // a new session: this window's agent is offered, not an empty choice
  fireEvent.click(screen.getByRole('button', { name: t('projNewSess') }));
  expect(await screen.findByRole('radio', { name: 'Claude' })).toBeChecked();
});

it('phase 3: an expanded project with several agents lists them; one beside the window closes after a confirm, its session staying', async () => {
  const notes = LIST.running.find((r) => r.root === '/w/notes')!;
  const helper: RunningRow = { ...notes, provider: 'claude', current: false, title: 'Count the files', session: S3, agent: 'claude-h2h2h2', id: 'claude-h2h2h2' };
  list = { ...LIST, running: [...LIST.running, helper] };
  await openMenu();
  await screen.findByRole('group', { name: t('projSessionsOf', 'notes') }); // this project's starts expanded
  const agents = screen.getByRole('list', { name: t('projAgentsOf', 'notes') });
  expect(within(agents).getAllByRole('listitem')).toHaveLength(2);
  fireEvent.click(within(agents).getByRole('button', { name: `${t('agentClose')}: Claude · Count the files` }));
  fireEvent.click(await screen.findByRole('button', { name: t('agentClose') }));
  await waitFor(() => expect(calls.filter((c) => c.url === '/system/projects/stop').map((c) => c.body)).toEqual([{ provider: 'claude', port: notes.port, root: '/w/notes', agent: 'claude-h2h2h2' }]));
});
