import { afterEach, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { Provider } from 'react-redux';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { makeStore, serverEvent } from '../store/store.ts';
import type { SocketState } from '../net/socket.ts';
import { agentConnection, connectionsOf, SELF, useConnection, useConnState, useFeature, type ConnState } from './connections.ts';

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

it('the page has exactly one connection, SELF', () => {
  const f = fake();
  const store = makeStore({ url: 'ws://x/ws', connect: f.connect });
  const m = connectionsOf(store);
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(m.list()).toEqual([m.current()]);
  expect(m.current().id).toBe(SELF);
  expect(m.get(SELF)).toBe(m.current());
  expect(m.get('other')).toBeUndefined();
  expect(m.current().base).toBe('');
});

it('the connection owns its state; the store mirrors each change with one connState dispatch', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  const conn = connectionsOf(store).current();
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
  f.ev({ kind: 'occupied' });
  f.ev({ kind: 'occupied' }); // no change: nothing mirrored
  expect(seen).toEqual(['open', 'occupied']);
  expect(mirrored).toEqual(['open', 'occupied']);
  // the first occupied: one connState and its serverEvent; the second only its serverEvent
  expect(dispatches - afterOpen).toBe(3);
  off();
  f.state('closed');
  expect(seen).toEqual(['open', 'occupied']);
  expect(store.getState().conn.state).toBe('closed');
});

it('onEvent sees each event after the store applied it', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  const conn = connectionsOf(store).current();
  const items: number[] = [];
  const off = conn.onEvent((ev) => { if (ev.kind === 'user') items.push(store.getState().feed.items.length); });
  f.ev({ kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  off();
  f.ev({ kind: 'user', id: 'u2', text: 'hi', ts: 2 });
  expect(items).toEqual([1]);
});

it('a server event carries the agent it came from', () => {
  expect(serverEvent({ kind: 'occupied' }).meta).toEqual({ agent: SELF });
  expect(serverEvent({ kind: 'occupied' }, 'a2').meta).toEqual({ agent: 'a2' });
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  const metas: unknown[] = [];
  const spy = vi.spyOn(store, 'dispatch');
  f.ev({ kind: 'occupied' });
  for (const [a] of spy.mock.calls) if (serverEvent.match(a)) metas.push(a.meta);
  expect(metas).toEqual([{ agent: SELF }]);
});

it('hello is adopted in one place: hello(), has() and the feature hook follow it; a drop forgets it', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  const conn = connectionsOf(store).current();
  const wrapper = ({ children }: { children: ReactNode }) => createElement(Provider, { store, children });
  const hook = renderHook(() => ({ state: useConnState(), models: useFeature('models'), conn: useConnection() }), { wrapper });
  expect(conn.hello()).toBeNull();
  expect(conn.has('models')).toBe(false);
  expect(hook.result.current.conn).toBe(conn);
  act(() => { f.state('open'); f.ev({ kind: 'hello', protocol: 6 }); });
  expect(conn.hello()).toEqual({ kind: 'hello', protocol: 6 });
  expect(conn.has('models')).toBe(true);
  expect(conn.has('remoteProjects')).toBe(false);
  expect(hook.result.current).toMatchObject({ state: 'open', models: true });
  act(() => f.state('closed'));
  expect(conn.hello()).toBeNull();
  expect(conn.has('models')).toBe(false);
  expect(hook.result.current).toMatchObject({ state: 'closed', models: false });
});

it('stop parks the connection: the socket closes and a later drop does not turn stopped into closed', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  const conn = connectionsOf(store).current();
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
  const conn = agentConnection({ id: 'a2', base: '/agents/a2', url: 'ws://x/ws', connect: f.connect, deliver: () => {}, mirror: () => {} });
  expect(conn.url('/file?path=a.png')).toBe('/agents/a2/file?path=a.png');
  await conn.fetch('/info', { method: 'POST' });
  expect(calls[0]![0]).toBe('/agents/a2/info');
  expect(calls[0]![1]?.method).toBe('POST');
  expect(new Headers(calls[0]![1]?.headers).get('x-nota-bene-key')).toBe('k1');
  localStorage.removeItem('nb.key');
});
