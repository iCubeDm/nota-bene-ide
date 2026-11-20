// The connection manager of issue 511: a page's agents, each one socket with its state, its `hello` and its HTTP base.
// Today a page has exactly one, SELF; issue 383 opens more. Socket semantics stay in net/socket.ts.
import { useSelector, useStore } from 'react-redux';
import { has, type ClientMessage, type Feature, type ServerEvent } from '@nota-bene/shared';
import { apiFetch, refusedForAuth, socketProtocols } from '../net/auth.ts';
import { connect as realConnect, type Connection, type SocketState } from '../net/socket.ts';
import { coalesceChunks } from '../store/chunks.ts';

export type AgentId = string;
/** The one agent of today's page (issue 383 gives real ids). */
export const SELF: AgentId = 'self';

// unauthorized = the server refused the page's login (the access token, net/auth.ts)
// connecting = never open yet; closed = dropped after an open; occupied = another tab owns the window; taken = another tab took it from us (M7-15)
/** `stopped`: this tab stopped its own window (the header's Stop Nota Bene); nothing reconnects after it */
export type ConnState = 'connecting' | 'open' | 'closed' | 'occupied' | 'taken' | 'unauthorized' | 'stopped';

export type HelloEvent = Extract<ServerEvent, { kind: 'hello' }>;
/** A route: path and query, no base (sdk/routes.ts builds them). */
export type Route = string;

export type Connect = (url: string | (() => string), onEvent: (ev: ServerEvent) => void, onState: (s: SocketState) => void) => Connection;

export interface AgentConnection {
  readonly id: AgentId;
  /** the URL prefix of the agent's routes ('' today) */
  readonly base: string;
  /** for non-React code; components read the `conn` slice (useConnState) */
  state(): ConnState;
  subscribe(fn: () => void): () => void;
  hello(): HelloEvent | null;
  has(f: Feature): boolean;
  send(m: ClientMessage): boolean;
  fetch(route: Route, init?: RequestInit): Promise<Response>;
  /** for an img, video or iframe src */
  url(route: Route): string;
  /** «Работать здесь»: take the window over from the other tab (R-M7-5/8) */
  takeOver(): void;
  /** this tab stopped the window: the socket stays down */
  stop(): void;
  /** the connection's events, after the store has applied them */
  onEvent(fn: (ev: ServerEvent) => void): () => void;
}

export interface ConnectionManager {
  current(): AgentConnection;
  get(id: AgentId): AgentConnection | undefined;
  list(): AgentConnection[];
}

const realConnectFn: Connect = (u, e, st) => realConnect(u, e, st, WebSocket, refusedForAuth, socketProtocols);

/**
 * One agent's connection. `deliver` applies an event to the store; `mirror` puts a state change into it (one dispatch per
 * change). The socket opens at `open()`, once the creator has put the connection where thunks find it: a socket may
 * report its first state at once.
 */
export function agentConnection(o: {
  id: AgentId;
  base: string;
  url: string;
  connect?: Connect;
  deliver: (ev: ServerEvent) => void;
  mirror: (s: ConnState) => void;
}): AgentConnection & { open(): void } {
  // this page instance's id, in memory only (not sessionStorage: a duplicated tab would copy it and steal the window);
  // the server recognises a reconnect of the owning tab by it: no grace, no occupied (M7-15 fix round 1)
  const tabId = crypto.randomUUID();
  // pause=1 (gh-422): this page asks for a pending server restart in its own pause, so the server waits for that ask;
  // held=1 (issue 499): it knows `send-held`, so its sends may wait behind a pending restart or compaction
  const baseUrl = `${o.url}${o.url.includes('?') ? '&' : '?'}tab=${tabId}&pause=1&held=1`;
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
  // an occupied or taken page reconnects passive: after a restart both tabs retry, and the one that was parked must not
  // win the window by being first (the server answers a passive socket `occupied` even with no owner)
  const url = () => (state === 'occupied' || state === 'taken' ? `${baseUrl}&passive=1` : baseUrl);
  let sock: Connection | null = null;
  const send = (m: ClientMessage): boolean => sock?.send(m) ?? false;
  // «Работать здесь» was pressed: the next `occupied` is answered with `takeover` at once (and never shown)
  let takeoverWanted = false;
  const conn: AgentConnection & { open(): void } = {
    id: o.id,
    base: o.base,
    state: () => state,
    subscribe: (fn) => (watchers.add(fn), () => void watchers.delete(fn)),
    hello: () => hello,
    has: (f) => has(hello?.protocol, f),
    send,
    fetch: (route, init) => apiFetch(o.base + route, init),
    url: (route) => o.base + route,
    takeOver: () => {
      takeoverWanted = true;
      if (state === 'occupied') {
        // a send that did not go out (socket not open) keeps the wish: the next `occupied` is answered with takeover
        takeoverWanted = !send({ type: 'takeover' });
      } else {
        // from `taken`: the overlay stays up (inert) until the attach, or `occupied` to answer with takeover
        sock?.reconnect?.();
      }
    },
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
          if (ev.kind === 'occupied') {
            if (takeoverWanted) {
              takeoverWanted = false;
              send({ type: 'takeover' });
            } else setState('occupied');
          } else if (ev.kind === 'taken-over') setState('taken');
          else if (ev.kind === 'replay') takeoverWanted = false; // a replay goes to the owner only: the takeover went through
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

/** A manager over the page's connections (makeStore gives it exactly one). */
export function connectionManager(list: () => AgentConnection[]): ConnectionManager {
  return {
    current: () => list()[0]!,
    get: (id) => list().find((c) => c.id === id),
    list: () => [...list()],
  };
}

/** The connection manager of a store made by makeStore: its thunk extra argument, so there is no second registry. */
export const connectionsOf = (store: { dispatch: (a: never) => unknown }): ConnectionManager =>
  store.dispatch(((_d: unknown, _g: unknown, x: { connections: ConnectionManager }) => x.connections) as never) as ConnectionManager;

export const useConnection = (): AgentConnection => connectionsOf(useStore()).current();
export const useConnState = (): ConnState => useSelector((s: { conn: { state: ConnState } }) => s.conn.state);
// the protocol the store keeps from the current connection's `hello` (the controls slice: 0 until a hello, and after a drop)
export const useFeature = (f: Feature): boolean => useSelector((s: { controls: { protocol: number } }) => has(s.controls.protocol, f));
