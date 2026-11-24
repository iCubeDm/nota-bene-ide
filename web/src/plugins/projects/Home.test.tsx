// Issue 651: the home page's inbox: the agents by what they need from the person, an open ask answered in place.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang, t } from '@/core/i18n/index.ts';
import { makeStore } from '@/core/testing';
import { getToasts } from '@/core/shell/toast.ts';
import { Home } from '@/core/shell/Home.tsx';
import type { OpenAsk, ProjectsList, RunningRow } from './api.ts';
import { nav } from './api.ts';

const URL_OK = `http://127.0.0.1:4791/a/codex-k3f7qz/#t=${'a'.repeat(64)}`;
const row = (root: string, id: string, state: RunningRow['state'], o: Partial<RunningRow> = {}): RunningRow =>
  ({ provider: 'claude', port: 4791, root, title: null, session: null, state, current: false, clients: 0, unseen: 0, last: null, agent: id, id, ...o });
const ASK: OpenAsk = { id: 'p1', toolName: 'Bash', input: { command: 'ls' } };

let list: ProjectsList;
let answer: () => Response;
let calls: { url: string; body?: unknown }[];
beforeEach(() => {
  setLang('en');
  localStorage.clear();
  calls = [];
  answer = () => Response.json({ ok: true });
  list = { running: [], recent: [], hidden: [] };
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (url === '/system/projects') return Response.json(list);
    if (url.endsWith('/permission')) return answer();
    if (url === '/system/projects/enter') return Response.json({ url: URL_OK });
    return Response.json({});
  }));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(nav, 'go').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const setup = () => render(<Provider store={makeStore({ url: 'ws://x', socket: false })}><Home /></Provider>);
const inbox = () => screen.getByRole('main', { name: t('inbox') });
const loads = () => calls.filter((c) => c.url === '/system/projects').length;

it('groups agents: waiting, unread, working, idle, each with its count', async () => {
  list.running = [
    row('/w/d', 'claude-dddddd', 'idle'),
    row('/w/c', 'claude-cccccc', 'working', { title: 'Run the tests' }),
    row('/w/b', 'claude-bbbbbb', 'idle', { unseen: 2, last: { role: 'assistant', text: 'All done', at: 1 } }),
    row('/w/a', 'claude-aaaaaa', 'waiting', { asks: [ASK] }),
  ];
  setup();
  await waitFor(() => expect(within(inbox()).getAllByRole('heading', { level: 2 })).toHaveLength(4));
  expect(within(inbox()).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([t('inboxWaiting', 1), t('inboxUnread', 1), t('inboxWorking', 1), t('inboxIdle', 1)]);
  expect(within(inbox()).getByText('All done')).toBeTruthy();
  expect(within(inbox()).getByText('Run the tests')).toBeTruthy();
});

it('an empty group has no heading', async () => {
  list.running = [row('/w/c', 'claude-cccccc', 'working')];
  setup();
  await waitFor(() => expect(within(inbox()).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([t('inboxWorking', 1)]));
});

it('answers an ask in place: posts to the agent and reloads', async () => {
  list.running = [row('/w/a', 'claude-k3f7qz', 'waiting', { asks: [ASK] })];
  setup();
  const allow = await within(inbox()).findByRole('button', { name: t('allow') });
  const before = loads();
  fireEvent.click(allow);
  await waitFor(() => expect(calls.find((c) => c.url === '/a/claude-k3f7qz/permission')?.body).toEqual({ id: 'p1', allow: true }));
  await waitFor(() => expect(loads()).toBeGreaterThan(before));
  expect(getToasts().some((x) => x.title === t('askGone'))).toBe(false);
});

it('two asks show as two cards, each answering its own id', async () => {
  list.running = [row('/w/a', 'claude-k3f7qz', 'waiting', { asks: [ASK, { id: 'p2', toolName: 'Bash', input: { command: 'pwd' } }] })];
  setup();
  await within(inbox()).findByText('pwd');
  const deny = within(inbox()).getAllByRole('button', { name: t('deny') });
  expect(deny).toHaveLength(2);
  fireEvent.click(deny[1]!);
  await waitFor(() => expect(calls.find((c) => c.url === '/a/claude-k3f7qz/permission')?.body).toEqual({ id: 'p2', allow: false }));
});

it('a settled ask toasts askGone and reloads', async () => {
  list.running = [row('/w/a', 'claude-k3f7qz', 'waiting', { asks: [ASK] })];
  answer = () => new Response('already answered', { status: 409 });
  setup();
  fireEvent.click(await within(inbox()).findByRole('button', { name: t('allow') }));
  await waitFor(() => expect(getToasts().some((x) => x.title === t('askGone'))).toBe(true));
});

it('a waiting row with no asks offers Open agent', async () => {
  list.running = [row('/w/a', 'codex-k3f7qz', 'waiting', { provider: 'codex', port: 4793 })];
  setup();
  fireEvent.click(await within(inbox()).findByRole('button', { name: t('inboxOpen') }));
  await waitFor(() => expect(calls.find((c) => c.url === '/system/projects/enter')?.body).toMatchObject({ agent: 'codex-k3f7qz', port: 4793 }));
  await waitFor(() => expect(nav.go).toHaveBeenCalledWith(URL_OK));
});

it('no agents: the empty text and the starter buttons', async () => {
  setup();
  await within(inbox()).findByText(t('inboxEmpty'));
  expect(within(inbox()).getByRole('button', { name: t('projOpenFolder') })).toBeTruthy();
  expect(within(inbox()).getByRole('button', { name: t('projNew') })).toBeTruthy();
});

it('no agent part renders on the home page', async () => {
  list.running = [row('/w/a', 'claude-aaaaaa', 'idle')];
  setup();
  await within(inbox()).findByText(t('inboxIdle', 1));
  expect(document.getElementById('restartBtn')).toBeNull();
  expect(document.querySelector('textarea')).toBeNull();
  expect(document.getElementById('tree-sheet')).toBeNull();
  // the home has no agent: no sessions of its own are asked for
  expect(calls.some((c) => c.url === '/sessions')).toBe(false);
});
