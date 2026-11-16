import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang, t } from '@/i18n/index.ts';
import { nav, openStarter, validName } from './api.ts';
import { Starter } from './Starter.tsx';

const HOME = '/home/u';
const URL_OK = 'http://127.0.0.1:4793/#t=' + 'a'.repeat(64);
const tree: Record<string, { name: string; git: boolean }[]> = {
  [HOME]: [{ name: 'alpha', git: false }, { name: 'beta', git: true }, { name: 'Projects', git: false }],
  [`${HOME}/alpha`]: [],
  [`${HOME}/Projects`]: [{ name: 'site', git: true }, { name: 'sandbox', git: false }, { name: 'notes', git: true }],
  [`${HOME}/Projects/site`]: [],
  [`${HOME}/Desktop`]: [],
};
const PLACES = [{ path: HOME, kind: 'home' }, { path: `${HOME}/Desktop`, kind: 'desktop' }, { path: `${HOME}/Projects`, kind: 'recent' }];
let calls: { url: string; body: Record<string, unknown> | undefined }[];
let answer: (url: string, body: Record<string, unknown> | undefined) => Response | Promise<Response> | null;

beforeEach(() => {
  setLang('en');
  calls = [];
  answer = () => null;
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    const own = await answer(url, body);
    if (own) return own;
    if (url === '/system/agents') return Response.json({ agents: ['claude', 'codex'], default: 'codex' });
    if (url === '/system/folders') {
      const p = (body?.path as string | undefined) ?? HOME;
      const dirs = tree[p];
      if (!dirs) return new Response('not a folder', { status: 404 });
      const hidden = body?.hidden ? [{ name: '.cfg', git: false }] : [];
      return Response.json({ path: p, parent: p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/', home: HOME, dirs: [...hidden, ...dirs], places: PLACES });
    }
    if (url === '/system/projects/open' || url === '/system/projects/create') return Response.json({ url: URL_OK });
    return new Response('[]');
  }));
  vi.spyOn(nav, 'go').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function start(mode: 'open' | 'new' = 'open') {
  render(<Starter />);
  act(() => openStarter(mode));
  await screen.findByRole('dialog');
  await screen.findByRole('option', { name: /alpha/ });
}
const folderCalls = () => calls.filter((c) => c.url === '/system/folders').map((c) => c.body?.path ?? null);
const list = () => screen.getByRole('listbox', { name: t('startFolders') });
const names = () => within(list()).queryAllByRole('option').map((o) => o.getAttribute('data-name'));
const enter = (name: string) => fireEvent.doubleClick(within(list()).getByRole('option', { name: new RegExp(name) }));

it('starts at home; git repositories come first, then the rest, each by name', async () => {
  await start();
  expect(folderCalls()[0]).toBeNull();
  expect(names()).toEqual(['beta', 'alpha', 'Projects']);
});

it('places browse: home, Desktop, the parents of recent projects', async () => {
  await start();
  const places = screen.getByRole('navigation', { name: t('startPlaces') });
  expect(within(places).getAllByRole('button').map((b) => b.textContent)).toEqual([t('startHome'), t('startDesktop'), 'Projects']);
  fireEvent.click(within(places).getByRole('button', { name: 'Projects' }));
  await waitFor(() => expect(names()).toEqual(['notes', 'site', 'sandbox']));
});

it('breadcrumbs name the path and browse a step up', async () => {
  await start();
  enter('Projects');
  await waitFor(() => expect(names()).toContain('site'));
  const crumbs = screen.getByRole('navigation', { name: t('startPath') });
  expect(within(crumbs).getAllByRole('button').map((b) => b.textContent)).toEqual(['/', 'home', 'u', 'Projects']);
  fireEvent.click(within(crumbs).getByRole('button', { name: 'u' }));
  await waitFor(() => expect(names()).toContain('alpha'));
  expect(folderCalls().at(-1)).toBe(HOME);
});

it('a click selects without browsing; a double click or Enter goes in; Open opens the selection with the chosen agent', async () => {
  await start();
  const n = folderCalls().length;
  fireEvent.click(within(list()).getByRole('option', { name: /alpha/ }));
  expect(within(list()).getByRole('option', { name: /alpha/ })).toHaveAttribute('aria-selected', 'true');
  expect(folderCalls()).toHaveLength(n);
  await waitFor(() => expect((screen.getByRole('combobox', { name: t('startAgent') }) as HTMLSelectElement).value).toBe('codex'));
  fireEvent.click(screen.getByRole('button', { name: t('startOpen') }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  expect(calls.find((c) => c.url === '/system/projects/open')!.body).toEqual({ dir: `${HOME}/alpha`, provider: 'codex' });
  fireEvent.keyDown(within(list()).getByRole('option', { name: /Projects/ }), { key: 'Enter' });
  await waitFor(() => expect(names()).toContain('site'));
});

it('Open with nothing selected opens the folder being browsed', async () => {
  await start();
  enter('Projects');
  await waitFor(() => expect(names()).toContain('site'));
  fireEvent.click(screen.getByRole('button', { name: t('startOpen') }));
  await waitFor(() => expect(calls.find((c) => c.url === '/system/projects/open')?.body).toMatchObject({ dir: `${HOME}/Projects` }));
});

it('the path field: Tab completes a folder name, Enter browses, a relative path is refused', async () => {
  await start();
  const field = screen.getByRole('textbox', { name: t('startPathField') });
  fireEvent.change(field, { target: { value: `${HOME}/Pro` } });
  fireEvent.keyDown(field, { key: 'Tab' });
  await waitFor(() => expect(field).toHaveValue(`${HOME}/Projects/`));
  fireEvent.change(field, { target: { value: `${HOME}/Projects/s` } });
  fireEvent.keyDown(field, { key: 'Tab' });
  await waitFor(() => expect(calls.filter((c) => c.url === '/system/folders').at(-1)!.body).toMatchObject({ path: `${HOME}/Projects` }));
  expect(field).toHaveValue(`${HOME}/Projects/s`); // site and sandbox: nothing longer in common
  fireEvent.change(field, { target: { value: `${HOME}/Projects/si` } });
  fireEvent.keyDown(field, { key: 'Tab' });
  await waitFor(() => expect(field).toHaveValue(`${HOME}/Projects/site/`));
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => expect(folderCalls().at(-1)).toBe(`${HOME}/Projects/site`));
  fireEvent.change(field, { target: { value: 'rel/x' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(screen.getByText(t('startPathAbs'))).toBeInTheDocument();
});

it('show hidden re-requests with hidden: true; a reopen starts at the last folder with hidden off', async () => {
  await start();
  fireEvent.click(screen.getByRole('checkbox', { name: t('startHidden') }));
  await within(list()).findByRole('option', { name: /\.cfg/ });
  enter('Projects');
  await waitFor(() => expect(names()).toContain('site'));
  act(() => openStarter('open'));
  await waitFor(() => expect(calls.filter((c) => c.url === '/system/folders').at(-1)!.body).toEqual({ path: `${HOME}/Projects`, hidden: false }));
  expect(screen.getByRole('checkbox', { name: t('startHidden') })).not.toBeChecked();
});

it('a listing that arrives after a newer one is dropped', async () => {
  let late!: () => void;
  answer = (url, body) => (url === '/system/folders' && body?.path === `${HOME}/alpha`
    ? new Promise<Response>((r) => { late = () => r(Response.json({ path: `${HOME}/alpha`, parent: HOME, home: HOME, dirs: [{ name: 'stale', git: false }], places: PLACES })); })
    : null);
  await start();
  enter('alpha');
  enter('Projects');
  await waitFor(() => expect(names()).toContain('site'));
  await act(async () => late());
  expect(names()).not.toContain('stale');
});

it('New project opens with the new-folder row: creates in the folder being browsed, git on by default', async () => {
  await start('new');
  expect(screen.getByRole('heading', { name: t('startNewTitle') })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: t('startGit') })).toBeChecked();
  fireEvent.change(screen.getByRole('textbox', { name: t('startName') }), { target: { value: 'fresh' } });
  await waitFor(() => expect((screen.getByRole('combobox', { name: t('startAgent') }) as HTMLSelectElement).value).toBe('codex'));
  fireEvent.click(screen.getByRole('button', { name: t('startCreate') }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  expect(calls.find((c) => c.url === '/system/projects/create')!.body).toEqual({ parent: HOME, name: 'fresh', git: true, provider: 'codex' });
});

it('the new-folder row opens from its button in Open mode too, and a bad name is refused before sending', async () => {
  await start();
  fireEvent.click(screen.getByRole('button', { name: t('startNewHere') }));
  fireEvent.change(screen.getByRole('textbox', { name: t('startName') }), { target: { value: 'a:b' } });
  expect(screen.getByText(t('startNameBad'))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('startCreate') })).toBeDisabled();
});

it('a server refusal is shown in the dialog; a slow launch says it is still starting', async () => {
  answer = (url) => (url === '/system/projects/create' ? new Response('exists', { status: 409 }) : null);
  await start('new');
  fireEvent.change(screen.getByRole('textbox', { name: t('startName') }), { target: { value: 'taken' } });
  fireEvent.click(screen.getByRole('button', { name: t('startCreate') }));
  expect(await screen.findByText(t('startExists'))).toBeInTheDocument();
  answer = (url) => (url === '/system/projects/open' ? new Response('still starting', { status: 504 }) : null);
  fireEvent.click(screen.getByRole('button', { name: t('startOpen') }));
  expect(await screen.findByText(t('startStill'))).toBeInTheDocument();
  expect(nav.go).not.toHaveBeenCalled();
});

// issue 449: Back to this page after opening a folder brings it from the back/forward cache with the dialog still open
it('a page restored by Back has the dialog closed', async () => {
  await start();
  act(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('validName mirrors the server: no Windows-reserved names or characters', () => {
  for (const n of ['a:b', 'a*', 'a?', 'a"b', 'a<b', 'a>b', 'a|b', 'CON', 'nul.txt', 'com1', 'name.', ' a', 'a/b', '']) expect(validName(n), n).toBe(false);
  for (const n of ['console', 'a.b', 'my project', 'проект']) expect(validName(n), n).toBe(true);
});
