import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang, t } from '@/i18n/index.ts';
import { getToasts } from '@/shell/toast.ts';
import type { ProjectsList } from './api.ts';
import { nav, projectsMenu, setStarter } from './api.ts';
import { ProjectSwitcher } from './ProjectSwitcher.tsx';

const LIST: ProjectsList = {
  running: [
    { provider: 'claude', port: 4791, root: '/w/notes', title: 'Weekly notes', session: 's1', state: 'idle', current: true, clients: 1 },
    { provider: 'claude', port: 4792, root: '/w/site', title: 'Fix the login form', session: 's2', state: 'waiting', current: false, clients: 0 },
    { provider: 'codex', port: 4793, root: '/w/site', title: null, session: 's3', state: 'working', current: false, clients: 0 },
    { provider: 'omp', port: 4794, root: '/w/gone', title: null, session: null, state: 'restarting', current: false, clients: 0 },
  ],
  recent: [
    { root: '/w/site', provider: 'claude', at: 2, running: true },
    { root: '/w/old', provider: 'claude', at: 1, running: false },
  ],
};

let calls: { url: string; body: unknown }[];
let enter: () => Response;
beforeEach(() => {
  setLang('en');
  calls = [];
  enter = () => Response.json({ url: 'http://127.0.0.1:4793/#t=' + 'a'.repeat(64) });
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    calls.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(u) === '/system/projects') return Response.json(LIST);
    if (String(u) === '/system/projects/enter') return enter();
    return new Response('[]');
  }));
  vi.spyOn(nav, 'go').mockImplementation(() => {});
});
afterEach(() => { cleanup(); act(() => projectsMenu.close()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup() {
  render(<ProjectSwitcher project="notes" />);
  await waitFor(() => expect(calls.some((c) => c.url === '/system/projects')).toBe(true));
  return screen.getByRole('button', { name: /notes/ });
}
const openMenu = async () => {
  await setup();
  act(() => projectsMenu.open());
  return screen.findByRole('textbox', { name: t('projSearch') });
};

it('the trigger shows the project and the waiting count', async () => {
  const trigger = await setup();
  await waitFor(() => expect(within(trigger).getByText('1')).toBeInTheDocument());
  expect(within(trigger).getByTitle(t('projWaitingTip', 1))).toBeInTheDocument();
});

it('each running window is named by its session, with the folder, agent and state below; recent lists only what is not running', async () => {
  await openMenu();
  const running = screen.getByRole('group', { name: t('projRunning') });
  const titled = within(running).getByRole('button', { name: /^Fix the login form/ });
  expect(titled).toHaveAccessibleName(`Fix the login form site · Claude · ${t('projWaiting')}`);
  // a window with no session title yet is named by its folder
  expect(within(running).getByRole('button', { name: `site site · Codex · ${t('projWorking')}` })).toBeInTheDocument();
  expect(within(running).queryByRole('button', { name: /Weekly notes/ })).toBeNull();
  expect(within(running).getByText('Weekly notes')).toBeInTheDocument();
  expect(within(running).getByText(t('projThis'))).toBeInTheDocument();
  const recent = screen.getByRole('group', { name: t('projRecent') });
  expect(within(recent).getByText('old')).toBeInTheDocument();
  expect(within(recent).queryByText('site')).toBeNull();
});

it('search filters by session title, folder name and path', async () => {
  const search = await openMenu();
  fireEvent.change(search, { target: { value: 'sit' } });
  expect(screen.getByRole('button', { name: /^Fix the login form/ })).toBeInTheDocument();
  expect(screen.queryByText('Weekly notes')).toBeNull();
  expect(screen.queryByText('old')).toBeNull();
  fireEvent.change(search, { target: { value: 'weekly' } });
  expect(screen.getByText('Weekly notes')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Fix the login form/ })).toBeNull();
  fireEvent.change(search, { target: { value: 'zzz' } });
  expect(screen.getByText(t('projNone'))).toBeInTheDocument();
});

it('choosing a window posts enter and navigates', async () => {
  await openMenu();
  fireEvent.click(screen.getByRole('button', { name: /Codex.*working/ }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith('http://127.0.0.1:4793/#t=' + 'a'.repeat(64)));
  expect(calls.find((c) => c.url === '/system/projects/enter')!.body).toEqual({ provider: 'codex', port: 4793, root: '/w/site' });
});

it('a failed enter shows its reason and stays', async () => {
  enter = () => new Response('window not answering', { status: 409 });
  await openMenu();
  fireEvent.click(screen.getByRole('button', { name: /Codex.*working/ }));
  await waitFor(() => expect(getToasts().some((x) => x.title === t('projEnterFailed', t('whyNotAnswering')))).toBe(true));
  expect(nav.go).not.toHaveBeenCalled();
});

it('a restarting window is shown with its state and no action', async () => {
  await openMenu();
  expect(screen.getByText(new RegExp(`gone · omp · ${t('projRestarting')}`))).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /gone/ })).toBeNull();
});

it('a list that is not a projects list renders as empty', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
  render(<ProjectSwitcher project="notes" />);
  act(() => projectsMenu.open());
  expect(await screen.findByRole('textbox', { name: t('projSearch') })).toBeInTheDocument();
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
