import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang, t } from '@/core/i18n/index.ts';
import { makeStore } from '@/core/testing';
import { TooltipProvider } from '@/core/components/ui/tooltip.tsx';
import { page } from '@/core/net/local.ts';
import type { ProjectsList } from './api.ts';
import { nav } from './api.ts';
import { AgentTabs } from './AgentTabs.tsx';

const URL_OK = `http://127.0.0.1:4791/a/codex-k3f7qz/#t=${'a'.repeat(64)}`;
const STUDIO = { host: 'h1', name: 'Studio' };
const LIST: ProjectsList = {
  running: [
    { provider: 'claude', port: 4791, root: '/w/site', title: 'Fix the login form', session: 's1', state: 'idle', current: true, clients: 1, unseen: 0, last: null },
    { provider: 'codex', port: 4791, root: '/w/site', title: 'Review the diff', session: 's2', state: 'waiting', current: false, clients: 0, unseen: 0, last: null, agent: 'codex-k3f7qz' },
    { provider: 'claude', port: 4791, root: '/w/site', title: null, session: 's3', state: 'working', current: false, clients: 0, unseen: 2, last: null, agent: 'claude-a2b3c4' },
    { provider: 'omp', port: 4794, root: '/w/site', title: null, session: null, state: 'restarting', current: false, clients: 0, unseen: 0, last: null },
    { provider: 'claude', port: 4791, root: '/w/blog', title: 'Draft', session: 's4', state: 'idle', current: false, clients: 0, unseen: 1, last: null, agent: 'claude-b2c3d4' },
    { provider: 'claude', port: 4777, root: '/w/site', title: 'Far', session: 's5', state: 'idle', current: false, clients: 0, unseen: 0, last: null, remote: STUDIO },
  ],
  recent: [],
  hidden: [],
};

let calls: { url: string; body?: unknown }[];
let list: ProjectsList;
beforeEach(() => {
  setLang('en');
  calls = [];
  list = LIST;
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (url === '/system/projects') return Response.json(list);
    if (url === '/system/agents') return Response.json({ agents: ['claude', 'codex'] });
    if (url === '/system/projects/enter' || url === '/system/projects/open') return Response.json({ url: URL_OK });
    return new Response('[]');
  }));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(nav, 'go').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); page.remote = null; });

const setup = () => render(<Provider store={makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) })}><TooltipProvider><AgentTabs /></TooltipProvider></Provider>);
const tabs = () => screen.queryAllByRole('tab');

it('the other live agents of this folder on this computer, each with its agent, title and badge; a click moves there', async () => {
  setup();
  await waitFor(() => expect(tabs()).toHaveLength(2));
  expect(tabs().map((b) => b.textContent)).toEqual(['CodexReview the diff!', 'Claude2']);
  expect(tabs()[0]!.getAttribute('aria-label')).toBe('Codex · Review the diff · ' + t('projWaiting'));
  fireEvent.click(tabs()[0]!);
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  expect(calls.find((c) => c.url === '/system/projects/enter')!.body).toEqual({ provider: 'codex', port: 4791, root: '/w/site', agent: 'codex-k3f7qz' });
});

it('+ starts another agent on this folder, of the agent picked among the installed ones', async () => {
  setup();
  fireEvent.pointerDown(await screen.findByRole('button', { name: t('agentAdd') }), { button: 0, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Codex' }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  expect(calls.find((c) => c.url === '/system/projects/open')!.body).toEqual({ dir: '/w/site', provider: 'codex', new: true });
});

it('alone in its folder: no tabs, the + only; none before the list is in', async () => {
  list = { ...LIST, running: LIST.running.filter((r) => r.current || r.root !== '/w/site') };
  setup();
  expect(screen.queryByRole('button', { name: t('agentAdd') })).toBeNull();
  await screen.findByRole('button', { name: t('agentAdd') });
  expect(tabs()).toHaveLength(0);
});

it('on another computer\'s page: that computer\'s agents of the folder, no +', async () => {
  page.remote = STUDIO;
  list = { ...LIST, running: [...LIST.running.map((r) => ({ ...r, current: false })), { ...LIST.running[5]!, port: 4777, title: 'Here', current: true, agent: 'claude-c2d3e4' }] };
  setup();
  await waitFor(() => expect(tabs()).toHaveLength(1));
  expect(tabs()[0]!.textContent).toBe('ClaudeFar');
  expect(screen.queryByRole('button', { name: t('agentAdd') })).toBeNull();
});
