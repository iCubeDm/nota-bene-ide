import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { setLang, t } from '@/i18n/index.ts';
import { getToasts } from '@/shell/toast.ts';
import { makeStore } from '@/store/store.ts';
import type { ProjectsList } from './api.ts';
import { nav, projectsMenu, setStarter } from './api.ts';
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
};
const LOCAL = { current: S1, root: '/w/notes', sessions: [
  { id: S1, title: 'Weekly notes', at: 9, size: 1, cwd: '/w/notes' },
  { id: S2.replace('2222', '5555'), title: 'Older notes', at: 5, size: 1, cwd: '/w/notes' },
  { id: S3.replace('3333', '6666'), title: 'Old idea', at: 3, size: 1, cwd: '/w/archive-x' },
  { id: S4.replace('4444', '7777'), title: 'In a subfolder', at: 4, size: 1, cwd: '/w/notes/web' },
] };

let calls: { url: string; body: Record<string, unknown> | undefined }[];
let enter: () => Response;
beforeEach(() => {
  setLang('en');
  calls = [];
  enter = () => Response.json({ url: URL_OK });
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    if (url === '/system/projects') return Response.json(LIST);
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
    return new Response('[]');
  }));
  vi.spyOn(nav, 'go').mockImplementation(() => {});
});
afterEach(() => { cleanup(); act(() => projectsMenu.close()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const store = makeStore({ url: 'ws://x', connect: (_u, onEvent, onState) => {
    queueMicrotask(() => { (onState as (s: string) => void)('open'); onEvent({ kind: 'session', id: S1, root: '/w/notes', title: 'Weekly notes', model: null } as ServerEvent); });
    return { send: () => true, close() {} };
  } });
  render(<Provider store={store}><ProjectSwitcher project="notes" windowTitle="Weekly notes · notes · Nota Bene" /></Provider>);
  return store;
}
const openMenu = async () => {
  setup();
  await waitFor(() => expect(calls.some((c) => c.url === '/system/projects')).toBe(true));
  act(() => projectsMenu.open());
  return screen.findByRole('textbox', { name: t('projSearch') });
};
const projectRow = (name: string) => within(screen.getByRole('group', { name: t('projProjects') })).getByRole('button', { name: new RegExp(`^${name} ·`) });

it('the trigger shows one badge: ! while another project waits; the tab title too', async () => {
  setup();
  const trigger = screen.getByRole('button', { name: /notes/ });
  await waitFor(() => expect(within(trigger).getByText('!')).toBeInTheDocument());
  // over the ▾, out of the flow: the name and the path do not move when it comes, goes or grows to two digits
  expect(within(trigger).getByText('!').closest('[data-badge-over]')).toHaveClass('absolute');
  expect(document.title).toBe('(!) Weekly notes · notes · Nota Bene');
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
  act(() => projectsMenu.open());
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
    expect(projectsMenu.get()).toBe(false);
    act(() => projectsMenu.open());
    fireEvent.click(await screen.findByRole('button', { name: t('projOpenFolder') }));
    expect(modes).toEqual(['new', 'open']);
  } finally {
    setStarter(null);
  }
});

it('a session of this window asks first, then switches here', async () => {
  const sent: unknown[] = [];
  const store = makeStore({ url: 'ws://x', connect: (_u, onEvent, onState) => {
    queueMicrotask(() => { (onState as (s: string) => void)('open'); onEvent({ kind: 'session', id: S1, root: '/w/notes', title: 'Weekly notes', model: null } as ServerEvent); });
    return { send: (m: unknown) => { sent.push(m); return true; }, close() {} };
  } });
  render(<Provider store={store}><ProjectSwitcher project="notes" windowTitle="notes" /></Provider>);
  await waitFor(() => expect(calls.some((c) => c.url === '/system/projects')).toBe(true));
  act(() => projectsMenu.open());
  const mine = await screen.findByRole('group', { name: t('projSessionsOf', 'notes') });
  fireEvent.click(await within(mine).findByRole('button', { name: /^Older notes/ }));
  const dlg = await screen.findByRole('dialog', { name: t('openQ', 'Older notes') });
  fireEvent.click(within(dlg).getByRole('button', { name: t('switchBtn') }));
  expect(sent).toContainEqual({ type: 'switch', id: S2.replace('2222', '5555'), dir: '/w/notes' });
});

it('a new session with this window\'s agent warns like a switch and starts here', async () => {
  const sent: unknown[] = [];
  const store = makeStore({ url: 'ws://x', connect: (_u, onEvent, onState) => {
    queueMicrotask(() => { (onState as (s: string) => void)('open'); onEvent({ kind: 'session', id: S1, root: '/w/notes', title: 'Weekly notes', model: null } as ServerEvent); });
    return { send: (m: unknown) => { sent.push(m); return true; }, close() {} };
  } });
  render(<Provider store={store}><ProjectSwitcher project="notes" windowTitle="notes" /></Provider>);
  await waitFor(() => expect(calls.some((c) => c.url === '/system/projects')).toBe(true));
  act(() => projectsMenu.open());
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
