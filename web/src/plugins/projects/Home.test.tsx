import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang, t } from '@/core/i18n/index.ts';
import { makeStore } from '@/core/testing';
import type { ProjectsList } from './api.ts';
import { nav } from './api.ts';
import { ProjectsHome } from './Home.tsx';

const URL_OK = `http://127.0.0.1:4791/a/codex-k3f7qz/#t=${'a'.repeat(64)}`;
const LIST: ProjectsList = {
  running: [
    { provider: 'codex', port: 4791, root: '/w/site', title: 'Review the diff', session: 's2', state: 'waiting', current: false, clients: 0, unseen: 0, last: null, agent: 'codex-k3f7qz', id: 'codex-k3f7qz' },
  ],
  recent: [{ root: '/w/blog', provider: 'claude', at: 1, running: false }],
  hidden: [],
};

let calls: { url: string; body?: unknown }[];
beforeEach(() => {
  setLang('en');
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (url === '/system/projects') return Response.json(LIST);
    if (url === '/system/projects/enter' || url === '/system/projects/open') return Response.json({ url: URL_OK });
    return new Response('[]');
  }));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(nav, 'go').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const setup = () => render(<Provider store={makeStore({ url: 'ws://x', socket: false })}><ProjectsHome /></Provider>);

it('issue 639: the server\'s home page lists its projects and Recent; a row moves there, a Recent folder opens', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: /^site · / }));
  await waitFor(() => expect(calls.find((c) => c.url === '/system/projects/enter')?.body).toMatchObject({ agent: 'codex-k3f7qz', port: 4791 }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  fireEvent.click(screen.getByRole('button', { name: /^blog · / }));
  await waitFor(() => expect(calls.find((c) => c.url === '/system/projects/open')?.body).toMatchObject({ dir: '/w/blog', provider: 'claude' }));
  expect(screen.getByRole('button', { name: t('projOpenFolder') })).toBeTruthy();
  // the home has no agent: no sessions of its own are asked for
  expect(calls.some((c) => c.url === '/sessions')).toBe(false);
});
