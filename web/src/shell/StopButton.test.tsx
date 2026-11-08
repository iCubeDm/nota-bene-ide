import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { Header } from './Header.tsx';
import { Stopped } from './Stopped.tsx';
import { getToasts, resetToasts } from './toast.ts';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

function mockFetch(supervised: boolean, stop: () => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return url === '/info' ? new Response(JSON.stringify({ supervised })) : stop();
  }));
  return calls;
}

beforeEach(() => { setLang('en'); resetToasts(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Stop window', () => {
  function setupStop() {
    let state!: (s: 'open' | 'closed') => void;
    let ev!: (e: ServerEvent) => void;
    const closed: number[] = [];
    const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, e: typeof ev, st: typeof state) => { ev = e; state = st; st('open'); return { send: () => true, close() { closed.push(1); } }; }) as never });
    render(<Provider store={store}><Header /><Stopped /></Provider>);
    return { store, closed, ev: (e: ServerEvent) => act(() => ev(e)), state: (x: 'open' | 'closed') => act(() => state(x)) };
  }
  const openItem = async () => {
    const b = screen.getByRole('button', { name: 'Stop window' });
    expect(b).toHaveAttribute('title', 'Stop window: stops the agent and this window; the session stays and can be resumed');
    await userEvent.click(b);
  };

  it('is in the header without a supervisor too; Cancel posts nothing', async () => {
    const calls = mockFetch(false, () => new Response('{"ok":true}'));
    setupStop();
    await openItem();
    expect(await screen.findByText('Stop this window?')).toBeInTheDocument();
    expect(screen.queryByText(/running turn is interrupted/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.url === '/stop')).toBe(false);
  });

  it('confirmed: POSTs /stop, closes the socket and parks on Stopped; the socket\'s close does not undo it', async () => {
    const calls = mockFetch(false, () => new Response('{"ok":true}'));
    const { store, closed, state } = setupStop();
    await openItem();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/stop')?.init).toMatchObject({ method: 'POST' }));
    expect(await screen.findByTestId('stopped')).toHaveTextContent('The window is stopped');
    expect(closed).toEqual([1]);
    state('closed');
    state('open');
    expect(store.getState().conn.state).toBe('stopped');
  });

  it('warns of a running turn', async () => {
    mockFetch(false, () => new Response('{"ok":true}'));
    const { ev } = setupStop();
    ev({ kind: 'agent', e: { t: 'turn-start' }, ts: 1 } as ServerEvent);
    await openItem();
    expect(await screen.findByText(/The agent is working: the running turn is interrupted\./)).toBeInTheDocument();
  });

  it('a refused stop toasts stopFail and the window stays', async () => {
    mockFetch(false, () => new Response('exiting', { status: 409 }));
    const { store, closed } = setupStop();
    await openItem();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(getToasts().some((x) => x.title === 'Could not stop the window: ')).toBe(true));
    expect(store.getState().conn.state).toBe('open');
    expect(closed).toEqual([]);
    expect(screen.queryByTestId('stopped')).toBeNull();
  });
});
