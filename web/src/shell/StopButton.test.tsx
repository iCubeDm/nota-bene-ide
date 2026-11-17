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

type Row = { provider: 'claude'; port: number; root: string; state: string; current: boolean };
function mockFetch(supervised: boolean, stop: () => Response | Promise<Response>, o: { running?: Row[]; others?: () => Response } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === '/info') return new Response(JSON.stringify({ supervised }));
    if (url === '/system/projects') return Response.json({ running: o.running ?? [], recent: [] });
    if (url === '/system/projects/stop-others') return o.others?.() ?? Response.json({ stopped: 0, failed: 0 });
    return stop();
  }));
  return calls;
}

beforeEach(() => { setLang('en'); resetToasts(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Stop Nota Bene', () => {
  function setupStop() {
    let state!: (s: 'open' | 'closed') => void;
    let ev!: (e: ServerEvent) => void;
    const closed: number[] = [];
    const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, e: typeof ev, st: typeof state) => { ev = e; state = st; st('open'); return { send: () => true, close() { closed.push(1); } }; }) as never });
    render(<Provider store={store}><Header /><Stopped /></Provider>);
    return { store, closed, ev: (e: ServerEvent) => act(() => ev(e)), state: (x: 'open' | 'closed') => act(() => state(x)) };
  }
  const openItem = async () => {
    const b = screen.getByRole('button', { name: 'Stop Nota Bene' });
    expect(b).toHaveAttribute('title', 'Stop Nota Bene');
    await userEvent.click(b);
  };

  it('is in the header without a supervisor too; Cancel posts nothing', async () => {
    const calls = mockFetch(false, () => new Response('{"ok":true}'));
    setupStop();
    await openItem();
    expect(await screen.findByText('Stop Nota Bene?')).toBeInTheDocument();
    expect(screen.queryByText(/running turn is interrupted/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.url === '/stop' || c.url === '/system/projects/stop-others')).toBe(false);
  });

  it('confirmed: stops the other windows first, then POSTs /stop, closes the socket and parks on Stopped; the socket\'s close does not undo it', async () => {
    const calls = mockFetch(false, () => new Response('{"ok":true}'));
    const { store, closed, state } = setupStop();
    await openItem();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/stop')?.init).toMatchObject({ method: 'POST' }));
    const order = calls.map((c) => c.url).filter((u) => u === '/stop' || u === '/system/projects/stop-others');
    expect(order).toEqual(['/system/projects/stop-others', '/stop']);
    expect(await screen.findByTestId('stopped')).toHaveTextContent('Nota Bene is stopped');
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
    expect(await screen.findByText(/An agent is working: its running turn is interrupted\./)).toBeInTheDocument();
  });

  it('warns when another window\'s agent is working', async () => {
    mockFetch(false, () => new Response('{"ok":true}'), { running: [
      { provider: 'claude', port: 4791, root: '/p/a', state: 'idle', current: true },
      { provider: 'claude', port: 4792, root: '/p/b', state: 'working', current: false },
    ] });
    setupStop();
    await openItem();
    expect(await screen.findByText(/An agent is working/)).toBeInTheDocument();
  });

  it('another window that does not stop: a toast, and this window stays open', async () => {
    const calls = mockFetch(false, () => new Response('{"ok":true}'), { others: () => Response.json({ stopped: 1, failed: 1 }) });
    const { store, closed } = setupStop();
    await openItem();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(getToasts().some((x) => x.title.startsWith('Not every window stopped'))).toBe(true));
    expect(calls.some((c) => c.url === '/stop')).toBe(false);
    expect(store.getState().conn.state).toBe('open');
    expect(closed).toEqual([]);
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
