import { afterEach, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { Provider, useSelector } from 'react-redux';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { makeStore } from '@/core/testing';
import { cancelRestart } from '../store/controls.ts';
import { selectConn } from '../store/store.ts';
import { getToasts, resetToasts } from '../shell/toast.ts';
import { t } from '../i18n/index.ts';
import type { SocketState } from '../net/socket.ts';
import { agentConnection, connectionOf, useFeature, type AgentConnection, type ConnState } from './connections.ts';

// the comment flush, called through, records which connection it found (the open-after-registration test below)
const flushed = vi.hoisted(() => [] as AgentConnection[]);
vi.mock('../../plugins/comments/slice.ts', async (orig) => {
  const real = await orig<typeof import('../../plugins/comments/slice.ts')>();
  return {
    ...real,
    flushComments: () => (d: never, g: never, x: { connection: AgentConnection }) => {
      flushed.push(x.connection);
      return (real.flushComments() as (d: never, g: never, x: unknown) => void)(d, g, x);
    },
  };
});

function fake() {
  const sent: ClientMessage[] = [];
  let onEvent!: (e: ServerEvent) => void;
  let onState!: (s: SocketState) => void;
  const close = vi.fn();
  const connect = vi.fn((_u: unknown, e: typeof onEvent, s: typeof onState) => {
    onEvent = e;
    onState = s;
    return { send: (m: ClientMessage) => (sent.push(m), true), close };
  });
  return { sent, connect, close, ev: (e: ServerEvent) => onEvent(e), state: (s: SocketState) => onState(s) };
}

afterEach(() => { vi.unstubAllGlobals(); });

it('a store has one connection, opened once', () => {
  const f = fake();
  const store = makeStore({ url: 'ws://x/ws', connect: f.connect });
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(connectionOf(store).base).toBe('');
});

it('a socket that reports open inside connect already finds the connection, and the comment flush runs', () => {
  flushed.length = 0;
  const store = makeStore({ url: 'u', connect: (_u, _e, onState) => (onState('open'), { send: () => true, close() {} }) });
  expect(store.getState().conn.state).toBe('open');
  expect(flushed).toEqual([connectionOf(store)]);
});

it('the connection owns its state; the store mirrors each change with one connState dispatch', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  const conn = connectionOf(store);
  const seen: ConnState[] = [];
  const off = conn.subscribe(() => seen.push(conn.state()));
  const mirrored: ConnState[] = [];
  store.subscribe(() => {
    const s = store.getState().conn.state;
    if (s !== mirrored.at(-1)) mirrored.push(s);
  });
  let dispatches = 0;
  store.subscribe(() => dispatches++);
  expect(conn.state()).toBe('connecting');
  f.state('open');
  const afterOpen = dispatches;
  f.state('closed');
  f.state('closed'); // no change: nothing mirrored
  expect(seen).toEqual(['open', 'closed']);
  expect(mirrored).toEqual(['open', 'closed']);
  expect(dispatches - afterOpen).toBe(1);
  off();
  f.state('open');
  expect(seen).toEqual(['open', 'closed']);
  expect(store.getState().conn.state).toBe('open');
});

// issue 174: every client of a window is attached, so the page names no tab and is never passive
it('the socket url carries no tab= or passive=1', () => {
  const f = fake();
  makeStore({ url: 'ws://x/ws', connect: f.connect });
  const url = f.connect.mock.calls[0]![0] as string | (() => string);
  // one address for every (re)connect: nothing about this page's past changes it
  expect(typeof url === 'function' ? url() : url).toMatch(/^ws:\/\/x\/ws\?pause=1&held=1(&go=1)?$/);
});

it('an older server\'s occupied leaves the page connecting, answered by no takeover, and shows one oldServer toast', () => {
  resetToasts();
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  f.ev({ kind: 'occupied' });
  f.ev({ kind: 'hello', protocol: 38 } as ServerEvent);
  f.ev({ kind: 'occupied' }); // its retry after a drop: the same toast, counted, not a second one
  expect(store.getState().conn.state).toBe('connecting');
  expect(f.sent).toEqual([]);
  expect(getToasts().map((x) => x.title)).toEqual([t('oldServer')]);
});

it('onEvent sees each event after the store applied it', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  const conn = connectionOf(store);
  const items: number[] = [];
  const off = conn.onEvent((ev) => { if (ev.kind === 'user') items.push(store.getState().feed.items.length); });
  f.ev({ kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  off();
  f.ev({ kind: 'user', id: 'u2', text: 'hi', ts: 2 });
  expect(items).toEqual([1]);
});

it('hello is adopted in one place: hello() and the feature hook follow it; a drop forgets it', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  const conn = connectionOf(store);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(Provider, { store, children });
  const hook = renderHook(() => ({ state: useSelector(selectConn), models: useFeature('models') }), { wrapper });
  expect(conn.hello()).toBeNull();
  act(() => { f.state('open'); f.ev({ kind: 'hello', protocol: 6 }); });
  expect(conn.hello()).toEqual({ kind: 'hello', protocol: 6 });
  expect(hook.result.current).toMatchObject({ state: 'open', models: true });
  act(() => f.state('closed'));
  expect(conn.hello()).toBeNull();
  expect(hook.result.current).toMatchObject({ state: 'closed', models: false });
});

it('stop parks the connection: the socket closes and a later drop does not turn stopped into closed', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  const conn = connectionOf(store);
  f.state('open');
  conn.stop();
  expect(f.close).toHaveBeenCalledTimes(1);
  f.state('closed');
  expect(conn.state()).toBe('stopped');
  expect(store.getState().conn.state).toBe('stopped');
});

it('fetch and url put the agent base in front of the route; fetch carries the key', async () => {
  localStorage.setItem('nb.key', 'k1');
  const calls: [string, RequestInit | undefined][] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => (calls.push([u, init]), new Response('ok'))));
  const f = fake();
  const conn = agentConnection({ base: '/agents/a2', url: 'ws://x/ws', connect: f.connect, deliver: () => {}, mirror: () => {} });
  expect(conn.url('/file?path=a.png')).toBe('/agents/a2/file?path=a.png');
  await conn.fetch('/info', { method: 'POST' });
  expect(calls[0]![0]).toBe('/agents/a2/info');
  expect(calls[0]![1]?.method).toBe('POST');
  expect(new Headers(calls[0]![1]?.headers).get('x-nota-bene-key')).toBe('k1');
  localStorage.removeItem('nb.key');
});

it('the page\'s connection: before any store one at base "", never opened; then the last store made\'s', async () => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
  const sock = vi.fn();
  vi.stubGlobal('WebSocket', sock);
  const fresh = await import('./connections.ts');
  expect(fresh.connection.base).toBe('');
  await fresh.connection.fetch('/info');
  expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/info');
  expect(sock).not.toHaveBeenCalled();
  const { makeStore: make } = await import('../store/store.ts');
  const store = make({ url: 'ws://x/ws', connect: fake().connect, plugins: [] });
  expect(fresh.pageConnection()).toBe(fresh.connectionOf(store));
});

it('a thunk fetches through its own store\'s connection, not the page\'s last one', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
  const a = makeStore({ url: 'ws://x/ws', connect: fake().connect });
  makeStore({ url: 'ws://x/ws', connect: fake().connect });
  const conn = connectionOf(a);
  const spy = vi.spyOn(conn, 'fetch');
  expect(await a.dispatch(cancelRestart())).toBe(true);
  expect(spy).toHaveBeenCalledWith('/restart-server/cancel', { method: 'POST' });
});
