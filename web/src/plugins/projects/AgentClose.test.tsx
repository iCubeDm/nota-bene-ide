import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang, t } from '@/core/i18n/index.ts';
import { makeStore } from '@/core/testing';
import { TooltipProvider } from '@/core/components/ui/tooltip.tsx';
import { page } from '@/core/net/local.ts';
import type { ProjectsList } from './api.ts';
import { nav } from './api.ts';
import { AgentClose } from './AgentClose.tsx';
import { ChatTabContext } from '@/core/tabs/chatTab.ts';
import type { ReactNode } from 'react';

const HERE = 'claude-q2w3e4';
const LIST: ProjectsList = {
  running: [
    { provider: 'claude', port: 4791, root: '/w/site', title: 'Fix the login form', session: 's1', state: 'idle', current: true, clients: 1, unseen: 0, last: null, agent: HERE },
    { provider: 'codex', port: 4791, root: '/w/site', title: 'Review the diff', session: 's2', state: 'waiting', current: false, clients: 0, unseen: 0, last: null, agent: 'codex-k3f7qz' },
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
    return new Response('[]');
  }));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(nav, 'go').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); page.remote = null; });

const CHAT = (end?: ReactNode) => <div role="tab" aria-selected>chat{end}</div>;
const setup = () => render(<Provider store={makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) })}><TooltipProvider><ChatTabContext.Provider value={CHAT}><AgentClose /></ChatTabContext.Provider></TooltipProvider></Provider>);
const closeX = () => screen.findByRole('button', { name: `${t('agentClose')}: Claude · Fix the login form` });

it('issue 661: the strip has the chat\'s tab only, not the folder\'s other agents', async () => {
  setup();
  await closeX();
  expect(screen.getAllByRole('tab')).toHaveLength(1);
});

it('issue 653: ✕ is inside the chat\'s tab', async () => {
  setup();
  expect((await closeX()).closest('[role="tab"]')?.textContent).toBe('chat');
});

it('✕ closes this page\'s agent after a confirm, then goes to the server\'s home', async () => {
  setup();
  fireEvent.click(await closeX());
  fireEvent.click(await screen.findByRole('button', { name: t('agentClose') }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith('/'));
  expect(calls.filter((c) => c.url === '/system/projects/stop').map((c) => c.body)).toEqual([{ provider: 'claude', port: 4791, root: '/w/site', agent: HERE }]);
});

it('on another computer\'s page: no ✕', async () => {
  page.remote = { host: 'h1', name: 'Studio' };
  setup();
  await waitFor(() => expect(calls.some((c) => c.url === '/system/projects')).toBe(true));
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: new RegExp(t('agentClose')) })).toBeNull();
});
