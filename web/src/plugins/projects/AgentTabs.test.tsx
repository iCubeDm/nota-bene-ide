import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang, t } from '@/core/i18n/index.ts';
import { makeStore } from '@/core/testing';
import { TooltipProvider } from '@/core/components/ui/tooltip.tsx';
import { page } from '@/core/net/local.ts';
import type { ProjectsList } from './api.ts';
import { nav } from './api.ts';
import { AgentTabs, cycleAgent } from './AgentTabs.tsx';
import { resetSources, setSources } from '@/core/refs/sources.ts';

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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); page.remote = null; resetSources(); });

const setup = () => render(<Provider store={makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) })}><TooltipProvider><AgentTabs /></TooltipProvider></Provider>);
const tabs = () => screen.queryAllByRole('tab');

it('the other live agents of this folder on this computer, each with its agent, title and badge; a click moves there', async () => {
  setup();
  await waitFor(() => expect(tabs()).toHaveLength(2));
  expect(tabs().map((b) => b.textContent)).toEqual(['CodexReview the diff!', 'Claude2']);
  expect(tabs()[0]!.getAttribute('aria-label')).toBe('Codex · Review the diff · ' + t('projWaiting'));
  // issue 644: each with its vendor's mark
  expect(tabs().map((b) => b.querySelector('[data-agent-icon]')?.getAttribute('data-agent-icon'))).toEqual(['codex', 'claude']);
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

it('issue 620: an agent in another worktree of the repository is a tab too, with its branch; + starts one there', async () => {
  setSources([{ id: 'wt:x', kind: 'worktree', label: 'feature/x', ref: 'feature/x', dir: '/w/site-x' }]);
  list = { ...LIST, running: [...LIST.running, { provider: 'codex', port: 4791, root: '/w/site-x', title: 'Try the fix', session: 's6', state: 'idle', current: false, clients: 0, unseen: 0, last: null, agent: 'codex-x2y3z4' }] };
  setup();
  await waitFor(() => expect(tabs()).toHaveLength(3));
  expect(tabs()[2]!.getAttribute('aria-label')).toBe('Codex · feature/x · Try the fix · ' + t('projIdle'));
  fireEvent.pointerDown(screen.getByRole('button', { name: t('agentAdd') }), { button: 0, pointerType: 'mouse' });
  const sub = await screen.findByRole('menuitem', { name: 'feature/x' });
  fireEvent.keyDown(sub, { key: 'ArrowRight' });
  const items = await screen.findAllByRole('menuitem', { name: 'Codex' });
  fireEvent.click(items.at(-1)!);
  await waitFor(() => expect(calls.find((c) => c.url === '/system/projects/open')!.body).toEqual({ dir: '/w/site-x', provider: 'codex', new: true }));
});

describe('helpers (epic 383 2g)', () => {
  const lead = { provider: 'claude' as const, port: 4791, root: '/w/site', title: 'Lead', session: 's1', state: 'idle' as const, current: true, clients: 1, unseen: 0, last: null, id: 'claude-l2l2l2' };
  const helper = (n: string, state: 'working' | 'idle' | 'waiting', of = 'claude-l2l2l2') =>
    ({ provider: 'codex' as const, port: 4791, root: '/w/site', title: `Help ${n}`, session: `h${n}`, state, current: false, clients: 0, unseen: 0, last: null, agent: `codex-h${n}h2h2h`.slice(0, 12), id: `codex-h${n}h2h2h`.slice(0, 12), lead: of });

  it('a lead\'s helpers are one group after it: a count and their state dots, each opens from its menu', async () => {
    list = { running: [lead, helper('a', 'working'), helper('b', 'waiting')], recent: [], hidden: [] };
    setup();
    const group = await screen.findByRole('button', { name: t('helpersOf', 2) });
    expect(tabs()).toHaveLength(0);
    expect(group.querySelectorAll('[data-dot]')).toHaveLength(2);
    fireEvent.pointerDown(group, { button: 0, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Help b/ }));
    await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
  });

  it('on a helper\'s page: its lead is a tab, and Keep makes it an agent of the project', async () => {
    list = { running: [{ ...lead, current: false, agent: 'claude-l2l2l2' }, { ...helper('a', 'idle'), current: true }], recent: [], hidden: [] };
    setup();
    await waitFor(() => expect(tabs()).toHaveLength(1));
    expect(tabs()[0]!.textContent).toContain('Lead');
    fireEvent.click(screen.getByRole('button', { name: t('helperKeep') }));
    await waitFor(() => expect(calls.some((c) => c.url === '/agent/keep')).toBe(true));
  });
});

it('phase 3: Alt+] and Alt+[ go to the next and previous agent of the strip, wrapping', async () => {
  setup();
  await waitFor(() => expect(tabs()).toHaveLength(2));
  cycleAgent(1);
  await waitFor(() => expect(calls.filter((c) => c.url === '/system/projects/enter')).toHaveLength(1));
  expect(calls.find((c) => c.url === '/system/projects/enter')!.body).toMatchObject({ agent: 'codex-k3f7qz' });
  cycleAgent(-1);
  await waitFor(() => expect(calls.filter((c) => c.url === '/system/projects/enter')).toHaveLength(2));
  expect(calls.filter((c) => c.url === '/system/projects/enter')[1]!.body).toMatchObject({ agent: 'claude-a2b3c4' });
});
