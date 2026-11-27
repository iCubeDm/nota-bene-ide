// The page's connection to its agent (issue 661: a page shows one): one socket with its state, its `hello` and its HTTP
// base. Socket semantics stay in net/socket.ts.
import { useSelector } from 'react-redux';
import { has, type ClientMessage, type Feature, type ServerEvent } from '@nota-bene/shared';
import { apiFetch, refusedForAuth, socketProtocols } from '../net/auth.ts';
import { agentGone } from '../net/home.ts';
import { isLocalPage } from '../net/local.ts';
import { connect as realConnect, type Connection, type SocketState } from '../net/socket.ts';
import { coalesceChunks } from '../store/chunks.ts';
import type { Route } from './routes.ts';

// unauthorized = the server refused the page's login (the access token, net/auth.ts)
// connecting = never open yet (or an older server's `occupied`: issue 174); closed = dropped after an open
/** `stopped`: this tab stopped its own window (the header's Stop Nota Bene); nothing reconnects after it */
export type ConnState = 'connecting' | 'open' | 'closed' | 'unauthorized' | 'stopped';

export type HelloEvent = Extract<ServerEvent, { kind: 'hello' }>;
export type { Route } from './routes.ts';

export type Connect = (url: string | (() => string), onEvent: (ev: ServerEvent) => void, onState: (s: SocketState) => void) => Connection;

export interface AgentConnection {
  /** the URL prefix of the agent's routes (`/a/<id>`; '' the server's own) */
  readonly base: string;
  /** for non-React code; components read the `conn` slice (selectConn) */
  state(): ConnState;
  subscribe(fn: () => void): () => void;
  hello(): HelloEvent | null;
  send(m: ClientMessage): boolean;
  fetch(route: Route, init?: RequestInit): Promise<Response>;
  /** for an img, video or iframe src */
  url(route: Route): string;
  /** this tab stopped the window: the socket stays down */
  stop(): void;
  /** the connection's events, after the store has applied them */
  onEvent(fn: (ev: ServerEvent) => void): () => void;
}

// a socket refused for its login stops; one refused because the page's agent is gone takes the page to the top (issue 639)
const refused = async () => {
  const to = await agentGone();
  if (to) location.replace(to);
  return !to && refusedForAuth();
};
const realConnectFn: Connect = (u, e, st) => realConnect(u, e, st, WebSocket, refused, socketProtocols);

/**
 * The connection. `deliver` applies an event to the store; `mirror` puts a state change into it (one dispatch per
 * change). The socket opens at `open()`, once the creator has put the connection where thunks find it: a socket may
 * report its first state at once.
 */
export function agentConnection(o: {
  base: string;
  url: string;
  connect?: Connect;
  deliver: (ev: ServerEvent) => void;
  mirror: (s: ConnState) => void;
}): AgentConnection & { open(): void } {
  // pause=1 (gh-422): this page asks for a pending server restart in its own pause, so the server waits for that ask;
  // held=1 (issue 499): it knows `send-held`, so its sends may wait behind a pending restart or compaction;
  // go=1 (epic 383): a page on this computer moves to the agent the launcher opens (`open-agent`)
  const url = `${o.url}${o.url.includes('?') ? '&' : '?'}pause=1&held=1${isLocalPage() ? '&go=1' : ''}`;
  let state: ConnState = 'connecting';
  let hello: HelloEvent | null = null;
  const watchers = new Set<() => void>();
  const listeners = new Set<(ev: ServerEvent) => void>();
  const setState = (s: ConnState) => {
    if (s === state) return;
    state = s;
    // a dropped socket's server may come back as another version: what it can do is known again at its hello
    if (s === 'closed') hello = null;
    o.mirror(s);
    for (const fn of [...watchers]) fn();
  };
  let sock: Connection | null = null;
  const send = (m: ClientMessage): boolean => sock?.send(m) ?? false;
  const conn: AgentConnection & { open(): void } = {
    base: o.base,
    state: () => state,
    subscribe: (fn) => (watchers.add(fn), () => void watchers.delete(fn)),
    hello: () => hello,
    send,
    fetch: (route, init) => apiFetch(o.base + route, init),
    url: (route) => o.base + route,
    // the window was stopped from this tab: the socket stays down, and its close must not turn `stopped` back into `closed`
    stop: () => {
      setState('stopped');
      sock?.close();
    },
    onEvent: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    open: () => {
      sock = (o.connect ?? realConnectFn)(
        url,
        coalesceChunks((ev) => {
          if (ev.kind === 'hello') hello = ev;
          o.deliver(ev);
          for (const fn of [...listeners]) fn(ev);
        }),
        (s) => {
          if (state !== 'stopped') setState(s);
        },
      );
    },
  };
  return conn;
}

const bound = new WeakMap<object, AgentConnection>();
let page: AgentConnection | undefined;
let unbound: AgentConnection | undefined;

/** Ties a store to its connection (makeStore), so hooks and tests find it; the last one made is the page's. */
export const bindConnection = (store: object, c: AgentConnection): void => {
  bound.set(store, c);
  page = c;
};

/** The page's connection itself (the repository keys on it); before any store (a module's fetch at import, a unit test without one): one at base '', never opened. */
export const pageConnection = (): AgentConnection => page ?? (unbound ??= agentConnection({ base: '', url: '', deliver: () => {}, mirror: () => {} }));

/** The page's connection, for code outside React and thunks (thunks use their `extra`). */
export const connection: AgentConnection = {
  get base() { return pageConnection().base; },
  state: () => pageConnection().state(),
  subscribe: (fn) => pageConnection().subscribe(fn),
  hello: () => pageConnection().hello(),
  send: (m) => pageConnection().send(m),
  fetch: (route, init) => pageConnection().fetch(route, init),
  url: (route) => pageConnection().url(route),
  stop: () => pageConnection().stop(),
  onEvent: (fn) => pageConnection().onEvent(fn),
};

/** The connection of a store made by makeStore. */
export const connectionOf = (store: object): AgentConnection => bound.get(store)!;

// The one check of a server capability (issue 564): the protocol the store keeps from the current connection's `hello`
// (the controls slice: 0 until a hello, and after a drop). `selectFeature` outside a component, `useFeature` in one.
export const selectFeature = (s: { controls: { protocol: number } }, f: Feature): boolean => has(s.controls.protocol, f);
export const useFeature = (f: Feature): boolean => useSelector((s: { controls: { protocol: number } }) => selectFeature(s, f));
