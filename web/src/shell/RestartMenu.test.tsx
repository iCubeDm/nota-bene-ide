import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { SERVER_RESTART_TIMEOUT_MS } from '@/controls/slice.ts';
import { Header } from './Header.tsx';
import { INFO_POLL_MS } from './RestartMenu.tsx';
import { getToasts, resetToasts } from './toast.ts';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const SESSION: ServerEvent = { kind: 'session', id: 'abc12345', root: '/p/proj', title: null, model: null };

function mockFetch(supervised: boolean, restart: () => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return url === '/info' ? new Response(JSON.stringify({ supervised })) : restart();
  }));
  return calls;
}

function setup() {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  let state!: (s: 'open' | 'closed') => void;
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, e: typeof ev, s: typeof state) => { ev = e; state = s; s('open'); return { send: (m: ClientMessage) => (sent.push(m), true), close() {} }; }) as never });
  render(<Provider store={store}><Header /></Provider>);
  return { sent, store, ev: (e: ServerEvent) => act(() => ev(e)), state: (s: 'open' | 'closed') => act(() => state(s)) };
}

beforeEach(() => { setLang('en'); resetToasts(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('hides the server item when the server is not supervised', async () => {
  mockFetch(false, () => new Response('', { status: 200 }));
  setup();
  await userEvent.click(screen.getByRole('button', { name: 'Restart menu' }));
  expect(await screen.findByText('Restart the agent')).toBeInTheDocument();
  expect(screen.queryByText('Restart the server')).toBeNull();
});

it('↻ carries a small A for the agent; its name stays the label, not the letter', () => {
  mockFetch(true, () => new Response(''));
  setup();
  const b = screen.getByRole('button', { name: 'Restart the agent' });
  expect(b.querySelector('[data-agent-mark]')).toHaveTextContent('A');
  expect(b.querySelector('[data-agent-mark]')).toHaveAttribute('aria-hidden');
});

it('a plain click on ↻ still restarts the agent', async () => {
  mockFetch(true, () => new Response(''));
  const { sent } = setup();
  await userEvent.click(screen.getByRole('button', { name: 'Restart the agent' }));
  expect(sent).toEqual([{ type: 'restart' }]);
});

it('the server item POSTs /restart-server and shows restarting…; close, open, replay with the session ends it', async () => {
  const calls = mockFetch(true, () => new Response('', { status: 200 }));
  const { ev, state } = setup();
  await userEvent.click(screen.getByRole('button', { name: 'Restart menu' }));
  const item = await screen.findByText('Restart the server');
  expect(item.closest('[role=menuitem]')).toHaveAttribute('title', 'picks up server code changes; waits for the agent to finish, then the window reconnects by itself');
  await userEvent.click(item);
  await waitFor(() => expect(calls.find((c) => c.url === '/restart-server')?.init).toMatchObject({ method: 'POST' }));
  expect(document.getElementById('conn')).toHaveTextContent('restarting…');
  state('closed'); // the old socket goes first: must not end the phase
  expect(document.getElementById('conn')).not.toHaveTextContent('');
  state('open');
  expect(document.getElementById('restartBtn')).toBeDisabled();
  ev({ kind: 'replay', events: [SESSION] } as ServerEvent);
  expect(document.getElementById('conn')).toHaveTextContent('');
  expect(document.getElementById('restartBtn')).not.toBeDisabled();
});

it('a 409 answer toasts restartFail with the response text and releases the UI', async () => {
  mockFetch(true, () => new Response('agent is busy', { status: 409 }));
  setup();
  await userEvent.click(screen.getByRole('button', { name: 'Restart menu' }));
  await userEvent.click(await screen.findByText('Restart the server'));
  await waitFor(() => expect(getToasts()).toHaveLength(1));
  expect(getToasts()[0]).toMatchObject({ title: 'Could not restart the server: ', msg: 'agent is busy' });
  expect(document.getElementById('conn')).toHaveTextContent('');
});

it('no reconnect within 30 s releases the UI and toasts', async () => {
  mockFetch(true, () => new Response('', { status: 200 }));
  setup();
  await userEvent.click(screen.getByRole('button', { name: 'Restart menu' }));
  const item = await screen.findByText('Restart the server');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(item);
  await waitFor(() => expect(document.getElementById('conn')).toHaveTextContent('restarting…'));
  await act(async () => { await vi.advanceTimersByTimeAsync(SERVER_RESTART_TIMEOUT_MS + 10); });
  expect(document.getElementById('conn')).toHaveTextContent('');
  expect(getToasts()).toHaveLength(1);
});

describe('the "code updated" button', () => {
  const label = 'Restart server · code updated';
  function mockInfo(info: () => object) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== '/system/update' && url !== '/system/projects') calls.push(url); // the header's project switcher polls too
      return url === '/info' ? new Response(JSON.stringify(info())) : new Response('');
    }));
    return calls;
  }

  it('is hidden when not supervised, even if the code changed', async () => {
    mockInfo(() => ({ supervised: false, codeChanged: true }));
    setup();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: label })).toBeNull();
  });

  it('is hidden when the code did not change', async () => {
    mockInfo(() => ({ supervised: true, codeChanged: false }));
    setup();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: label })).toBeNull();
  });

  it('is shown when supervised and changed; a click POSTs /restart-server; disabled while switching', async () => {
    const calls = mockInfo(() => ({ supervised: true, codeChanged: true }));
    setup();
    const btn = await screen.findByRole('button', { name: label });
    expect(btn).toHaveAttribute('title', "the server's code changed after it started; the session resumes");
    expect(btn).not.toBeDisabled();
    await userEvent.click(btn);
    await waitFor(() => expect(calls).toContain('/restart-server'));
    expect(screen.getByRole('button', { name: label })).toBeDisabled();
  });

  it('the 20 s poll (visible tab) and a window focus pick up a change', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); // jsdom says 'prerender'
    let changed = false;
    const calls = mockInfo(() => ({ supervised: true, codeChanged: changed }));
    vi.useFakeTimers({ shouldAdvanceTime: true }); // before mount: the interval must be a fake one
    setup();
    await waitFor(() => expect(calls).toHaveLength(1));
    changed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(INFO_POLL_MS + 10); });
    expect(await screen.findByRole('button', { name: label })).toBeInTheDocument();
    cleanup();
    const n = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(INFO_POLL_MS * 2); });
    expect(calls).toHaveLength(n); // unmounted: timer and listener are gone
    window.dispatchEvent(new Event('focus'));
    expect(calls).toHaveLength(n);
  });

  it('a window focus re-reads /info', async () => {
    let changed = false;
    const calls = mockInfo(() => ({ supervised: true, codeChanged: changed }));
    setup();
    await waitFor(() => expect(calls).toHaveLength(1));
    changed = true;
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByRole('button', { name: label })).toBeInTheDocument();
  });
});

describe('a restart that waits for the agent (gh-422)', () => {
  function mockServer() {
    const calls: { url: string; body?: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/info') return new Response(JSON.stringify({ supervised: true, codeChanged: true }));
      if (url.startsWith('/restart-server')) {
        calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
        return new Response(url === '/restart-server' && !init?.body?.toString().includes('now') ? '{"ok":true,"pending":true}' : '{"ok":true}', { status: 200 });
      }
      return new Response('');
    }));
    return calls;
  }
  const busy = (ev: (e: ServerEvent) => void) => ev({ kind: 'replay', events: [SESSION, { kind: 'user', id: 'u1', text: 'work', ts: 1 }] } as ServerEvent);

  it('busy: the request becomes pending, not a restart; the header says so and offers Restart now and Cancel', async () => {
    const calls = mockServer();
    const { ev } = setup();
    busy(ev);
    await userEvent.click(screen.getByRole('button', { name: 'Restart menu' }));
    await userEvent.click(await screen.findByText('Restart the server'));
    await waitFor(() => expect(calls.map((c) => c.url)).toEqual(['/restart-server']));
    expect(document.getElementById('conn')).toHaveTextContent(''); // not restarting yet
    ev({ kind: 'restart-pending', pending: true });
    const chip = screen.getByRole('button', { name: 'Restart pending' });
    expect(chip).toHaveAttribute('title', 'The server restarts after the agent finishes');
    expect(screen.queryByRole('button', { name: 'Restart server · code updated' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Restart menu' }));
    expect(await screen.findByText('Restart the server now')).toBeInTheDocument();
    expect(screen.getByText('Cancel the server restart')).toBeInTheDocument();
    expect(screen.queryByText('Restart the server')).toBeNull();
  });

  it('Restart now asks first, then POSTs now and shows restarting…', async () => {
    const calls = mockServer();
    const { ev } = setup();
    busy(ev);
    ev({ kind: 'restart-pending', pending: true });
    await userEvent.click(screen.getByRole('button', { name: 'Restart pending' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restart the server now' }));
    expect(await screen.findByText(/subagents will be cut off/)).toBeInTheDocument();
    expect(calls).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    await waitFor(() => expect(calls).toEqual([{ url: '/restart-server', body: { now: true } }]));
    expect(document.getElementById('conn')).toHaveTextContent('restarting…');
  });

  it('Cancel POSTs the cancel', async () => {
    const calls = mockServer();
    const { ev } = setup();
    busy(ev);
    ev({ kind: 'restart-pending', pending: true });
    await userEvent.click(screen.getByRole('button', { name: 'Restart pending' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel the server restart' }));
    await waitFor(() => expect(calls.map((c) => c.url)).toEqual(['/restart-server/cancel']));
    ev({ kind: 'restart-pending', pending: false });
    expect(screen.queryByRole('button', { name: 'Restart pending' })).toBeNull();
  });

  it('pending: the page asks for the restart once the turn ends (a draft does not hold it: the page is kept)', async () => {
    const calls = mockServer();
    const { ev } = setup();
    busy(ev);
    ev({ kind: 'restart-pending', pending: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]); // the agent works
    ev({ kind: 'agent', e: { t: 'turn-end', stop: 'done', secs: 1, answers: 'all', queued: 0 }, ts: 2 } as ServerEvent);
    await waitFor(() => expect(calls.map((c) => c.url)).toEqual(['/restart-server/pause']));
    await waitFor(() => expect(document.getElementById('conn')).toHaveTextContent('restarting…'));
  });
});
