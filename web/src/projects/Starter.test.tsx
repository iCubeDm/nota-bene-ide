import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang, t } from '@/i18n/index.ts';
import { nav, openStarter } from './api.ts';
import { Starter } from './Starter.tsx';

const HOME = '/home/u';
const URL_OK = 'http://127.0.0.1:4793/#t=' + 'a'.repeat(64);
const tree: Record<string, { name: string; git: boolean }[]> = {
  [HOME]: [{ name: 'a', git: false }, { name: 'b', git: true }],
  [`${HOME}/a`]: [],
};
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
      return Response.json({ path: p, parent: p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/', home: HOME, dirs: [...hidden, ...dirs] });
    }
    if (url === '/system/projects/open' || url === '/system/projects/create') return Response.json({ url: URL_OK });
    return new Response('[]');
  }));
  vi.spyOn(nav, 'go').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function start(mode: 'open' | 'new') {
  render(<Starter />);
  act(() => openStarter(mode));
  await screen.findByRole('dialog');
  await screen.findByRole('button', { name: 'a' });
}
const folderCalls = () => calls.filter((c) => c.url === '/system/folders').map((c) => c.body?.path ?? null);

it('open: browses from home, enters a folder, goes up, and opens the chosen one with the chosen agent', async () => {
  await start('open');
  expect(screen.getByRole('heading', { name: t('startOpenTitle') })).toBeInTheDocument();
  await waitFor(() => expect((screen.getByRole('combobox', { name: t('startAgent') }) as HTMLSelectElement).value).toBe('codex'));
  fireEvent.click(screen.getByRole('button', { name: 'a' }));
  await screen.findByText(t('startEmpty'));
  expect(folderCalls().at(-1)).toBe(`${HOME}/a`);
  fireEvent.click(screen.getByRole('button', { name: t('startUp') }));
  await screen.findByRole('button', { name: 'b' });
  expect(folderCalls().at(-1)).toBe(HOME);
  fireEvent.click(screen.getByRole('button', { name: 'a' }));
  await screen.findByText(t('startEmpty'));
  fireEvent.change(screen.getByRole('combobox', { name: t('startAgent') }), { target: { value: 'claude' } });
  fireEvent.click(screen.getByRole('button', { name: t('startOpen') }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  expect(calls.find((c) => c.url === '/system/projects/open')!.body).toEqual({ dir: `${HOME}/a`, provider: 'claude' });
});

it('open: a typed absolute path is browsed on Enter; a relative one is refused without a request', async () => {
  await start('open');
  const field = screen.getByRole('textbox', { name: t('startPath') });
  fireEvent.change(field, { target: { value: 'rel/x' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(screen.getByText(t('startPathAbs'))).toBeInTheDocument();
  const n = folderCalls().length;
  fireEvent.change(field, { target: { value: `${HOME}/a` } });
  fireEvent.keyDown(field, { key: 'Enter' });
  await screen.findByText(t('startEmpty'));
  expect(folderCalls()).toHaveLength(n + 1);
});

it('open: show hidden re-requests with hidden: true', async () => {
  await start('open');
  fireEvent.click(screen.getByRole('checkbox', { name: t('startHidden') }));
  await screen.findByRole('button', { name: '.cfg' });
  expect(calls.filter((c) => c.url === '/system/folders').at(-1)!.body).toMatchObject({ hidden: true });
});

it('new: creates under the browsed folder with git init on by default', async () => {
  await start('new');
  expect(screen.getByRole('heading', { name: t('startNewTitle') })).toBeInTheDocument();
  expect(screen.getByText(t('startIn', HOME))).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: t('startGit') })).toBeChecked();
  fireEvent.change(screen.getByRole('textbox', { name: t('startName') }), { target: { value: 'fresh' } });
  await waitFor(() => expect((screen.getByRole('combobox', { name: t('startAgent') }) as HTMLSelectElement).value).toBe('codex'));
  fireEvent.click(screen.getByRole('button', { name: t('startCreate') }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  expect(calls.find((c) => c.url === '/system/projects/create')!.body).toEqual({ parent: HOME, name: 'fresh', git: true, provider: 'codex' });
});

it('new: a bad name is refused before sending', async () => {
  await start('new');
  fireEvent.change(screen.getByRole('textbox', { name: t('startName') }), { target: { value: 'a/b' } });
  expect(screen.getByText(t('startNameBad'))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('startCreate') })).toBeDisabled();
});

it('a server refusal is shown in the dialog and the buttons come back', async () => {
  answer = (url) => (url === '/system/projects/create' ? new Response('exists', { status: 409 }) : null);
  await start('new');
  fireEvent.change(screen.getByRole('textbox', { name: t('startName') }), { target: { value: 'taken' } });
  fireEvent.click(screen.getByRole('button', { name: t('startCreate') }));
  expect(await screen.findByText(t('startExists'))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('startCreate') })).toBeEnabled();
  answer = (url) => (url === '/system/projects/create' ? new Response('the launcher exited with 1', { status: 502 }) : null);
  fireEvent.click(screen.getByRole('button', { name: t('startCreate') }));
  expect(await screen.findByText(t('startFailed', 'the launcher exited with 1'))).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(nav.go).not.toHaveBeenCalled();
});

it('while the launcher runs the buttons are disabled and a wait line is shown', async () => {
  let release!: () => void;
  answer = (url) => (url === '/system/projects/open' ? new Promise<Response>((r) => { release = () => r(Response.json({ url: URL_OK })); }) : null);
  await start('open');
  fireEvent.click(screen.getByRole('button', { name: t('startOpen') }));
  expect(await screen.findByText(t('startOpening'))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('startOpen') })).toBeDisabled();
  await act(async () => release());
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
});

it('the server\'s fixed reasons are shown in the page\'s language; a slow launch says it is still starting', async () => {
  setLang('ru');
  await start('open');
  const field = screen.getByRole('textbox', { name: t('startPath') });
  fireEvent.change(field, { target: { value: '/nowhere' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(await screen.findByText(t('startFailed', t('whyNotFolder')))).toBeInTheDocument();
  answer = (url) => (url === '/system/projects/open' ? new Response('still starting', { status: 504 }) : null);
  fireEvent.click(screen.getByRole('button', { name: t('startOpen') }));
  expect(await screen.findByText(t('startStill'))).toBeInTheDocument();
});
