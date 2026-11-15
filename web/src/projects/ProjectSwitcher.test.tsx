import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang, t } from '@/i18n/index.ts';
import { getToasts } from '@/shell/toast.ts';
import type { ProjectsList } from './api.ts';
import { nav, projectsMenu } from './api.ts';
import { ProjectSwitcher } from './ProjectSwitcher.tsx';

const LIST: ProjectsList = {
  running: [
    { provider: 'claude', port: 4791, root: '/w/notes', title: null, session: 's1', state: 'idle', current: true, clients: 1 },
    { provider: 'claude', port: 4792, root: '/w/site', title: null, session: 's2', state: 'waiting', current: false, clients: 0 },
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

it('the menu groups running windows by folder with provider and state; recent lists only what is not running', async () => {
  await openMenu();
  const site = screen.getByRole('group', { name: 'site' });
  expect(within(site).getByRole('button', { name: /Claude.*waits for you/ })).toBeInTheDocument();
  expect(within(site).getByRole('button', { name: /Codex.*working/ })).toBeInTheDocument();
  const notes = screen.getByRole('group', { name: 'notes' });
  expect(within(notes).queryByRole('button')).toBeNull();
  expect(within(notes).getByText(t('projThis'))).toBeInTheDocument();
  const recent = screen.getByRole('group', { name: t('projRecent') });
  expect(within(recent).getByText('old')).toBeInTheDocument();
  expect(within(recent).queryByText('site')).toBeNull();
});

it('search filters running and recent by folder name and path', async () => {
  const search = await openMenu();
  fireEvent.change(search, { target: { value: 'sit' } });
  expect(screen.getByRole('group', { name: 'site' })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'notes' })).toBeNull();
  expect(screen.queryByText('old')).toBeNull();
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
  await waitFor(() => expect(getToasts().some((x) => x.title === t('projEnterFailed', 'window not answering'))).toBe(true));
  expect(nav.go).not.toHaveBeenCalled();
});

it('a restarting window is shown with its state and no action', async () => {
  await openMenu();
  const gone = screen.getByRole('group', { name: 'gone' });
  expect(within(gone).getByText(new RegExp(t('projRestarting')))).toBeInTheDocument();
  expect(within(gone).queryByRole('button')).toBeNull();
});

it('a list that is not a projects list renders as empty', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
  render(<ProjectSwitcher project="notes" />);
  act(() => projectsMenu.open());
  expect(await screen.findByRole('textbox', { name: t('projSearch') })).toBeInTheDocument();
});
