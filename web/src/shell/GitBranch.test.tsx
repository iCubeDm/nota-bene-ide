import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent, Source } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { resetSources, setSources } from '@/files/sources.ts';
import { selectTree } from '@/tree/slice.ts';
import { Header } from './Header.tsx';

const SOURCES = [
  { id: 'here', kind: 'checkout', label: 'main', ref: 'main', dir: '/p/proj' },
  { id: 'ref:agent/one', kind: 'worktree', label: 'agent/one', ref: 'agent/one', dir: '/p/one' },
  { id: 'ref:old', kind: 'branch', label: 'old', ref: 'old' },
];
const branches = [
  { id: 'here', branch: 'main', base: null, ahead: 0, dirty: false, busy: false, at: 1 },
  { id: 'ref:agent/one', branch: 'agent/one', base: 'main', ahead: 2, dirty: true, busy: true, at: 1 },
  { id: 'ref:old', branch: 'old', base: 'main', ahead: 1, dirty: false, busy: false, at: 1 },
];
let answer: unknown;
let calls: number;
let timedOut = false;
beforeEach(() => {
  vi.useFakeTimers();
  setLang('en');
  answer = { branch: 'main', detached: false, dirty: false };
  calls = 0;
  timedOut = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/vcs-branches') return new Response(JSON.stringify(branches));
    if (url === '/sources') return new Response(JSON.stringify(SOURCES));
    if (url === '/git-status') { calls++; return timedOut ? new Response('git status timed out', { status: 503 }) : new Response(JSON.stringify(answer)); }
    return new Response('nope', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setLang('ru'); });

const session = (root: string): ServerEvent => ({ kind: 'session', id: null, root, title: null, model: null });
const result: ServerEvent = { kind: 'agent', ts: 1, e: { t: 'turn-end', stop: 'done', secs: 0, answers: ['u1'], queued: 0 } };

async function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(<Provider store={store}><Header /></Provider>);
  const ev = (e: ServerEvent) => act(async () => { store.dispatch(serverEvent(e)); await vi.advanceTimersByTimeAsync(0); });
  const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  return { store, ev, wait, el: () => document.getElementById('git-branch') };
}

it('shows branch ✔ when clean, with a tooltip; nothing before a root is known', async () => {
  const { ev, el } = await setup();
  expect(el()).toBeNull();
  await ev(session('/p/proj'));
  expect(el()).toHaveTextContent('main✔');
  expect(el()).toHaveAttribute('title', 'git branch · clean');
  expect(el()!.querySelector('[data-dirty]')).toBeNull();
});

it('shows ✗ and the uncommitted tooltip when dirty, in ru as well', async () => {
  answer = { branch: 'feature/x', detached: false, dirty: true };
  setLang('ru');
  const { ev, el } = await setup();
  await ev(session('/p/proj'));
  expect(el()).toHaveTextContent('feature/x✗');
  expect(el()).toHaveAttribute('title', 'ветка git · есть незакоммиченные изменения или новые файлы');
  expect(el()!.querySelector('[data-dirty]')).not.toBeNull();
});

it('detached HEAD shows detached ✔/✗; a non-repo shows nothing', async () => {
  answer = { branch: null, detached: true, dirty: true };
  const { ev, el } = await setup();
  await ev(session('/p/proj'));
  expect(el()).toHaveTextContent('detached✗');
  answer = null;
  await ev(session('/p/other'));
  expect(el()).toBeNull();
});

it('refetches after a live turn, throttled to one request per 3 s (the late one still lands)', async () => {
  const { ev, wait, el } = await setup();
  await ev(session('/p/proj'));
  expect(calls).toBe(1);
  answer = { branch: 'main', detached: false, dirty: true };
  await ev(result); // within 3 s of the first: deferred, not dropped
  expect(calls).toBe(1);
  expect(el()).toHaveTextContent('main✔');
  await wait(3000);
  expect(calls).toBe(2);
  expect(el()).toHaveTextContent('main✗');
});

it('refetches on window focus, and on a root change', async () => {
  const { ev, wait } = await setup();
  await ev(session('/p/proj'));
  await wait(3000);
  act(() => { window.dispatchEvent(new Event('focus')); });
  await wait(0);
  expect(calls).toBe(2);
  await wait(3000);
  await ev(session('/p/other'));
  expect(calls).toBe(3);
});

it('git timing out (503) keeps what is shown', async () => {
  answer = { branch: 'main', detached: false, dirty: true };
  const { ev, el, wait } = await setup();
  await ev(session('/p/proj'));
  expect(el()).toHaveTextContent('main✗');
  timedOut = true;
  await wait(3000);
  await ev(result);
  await wait(3000);
  expect(calls).toBeGreaterThan(1);
  expect(el()).toHaveTextContent('main✗');
});

describe('the picker', () => {
  const open = async () => {
    const h = await setup();
    await h.ev(session('/p/proj'));
    fireEvent.click(h.el()!);
    await h.wait(0);
    return h;
  };
  beforeEach(() => { resetSources(); setSources(SOURCES as Source[]); });

  it('lists the folder, the worktrees and the branches, with distance, dirt and a dot where an agent works', async () => {
    await open();
    const row = screen.getByRole('button', { name: /agent\/one/ });
    expect(row).toHaveTextContent('↑2');
    expect(row).toHaveTextContent('✗');
    expect(row.querySelector('[data-agent-dot]')).toHaveAttribute('title', 'An agent is working here');
    expect(screen.getByRole('button', { name: /^.*old/ }).querySelector('[data-agent-dot]')).toBeNull();
  });

  it('picking changes the view and says so; the checkout is not touched', async () => {
    const { store, el } = await open();
    fireEvent.click(screen.getByRole('button', { name: /agent\/one/ }));
    expect(selectTree(store.getState()).src).toBe('ref:agent/one');
    expect(el()).toHaveTextContent('viewing');
    expect(el()).toHaveAttribute('title', 'Viewing agent/one; the window and the agent stay on main');
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('the search narrows the rows', async () => {
    await open();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a branch' }), { target: { value: 'old' } });
    expect(screen.queryByRole('button', { name: /agent\/one/ })).toBeNull();
  });
});
