// The test harness of issue 511, for test files only: a store on a fake connection, a fetch stub keyed by path, a
// render wrapper and typed event builders. Tests move onto it when a step touches them.
import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { PROTOCOL, type ClientMessage, type ServerEvent, type WireAgentEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import type { HelloEvent } from '@/sdk/connections.ts';
import type { SocketState } from '@/net/socket.ts';
import { makeStore as coreStore, type AppStore } from '@/store/store.ts';
import { PLUGINS } from '@/plugins.ts';

type Of<K extends ServerEvent['kind']> = Extract<ServerEvent, { kind: K }>;

/** Typed builders of the server's events, with neutral defaults. */
export const events = {
  hello: (p: Partial<HelloEvent> = {}): HelloEvent => ({ kind: 'hello', protocol: PROTOCOL, ...p }),
  session: (p: Partial<Of<'session'>> = {}): Of<'session'> => ({ kind: 'session', id: 's1', root: '/project', title: null, model: null, ...p }),
  user: (p: Partial<Of<'user'>> = {}): Of<'user'> => ({ kind: 'user', id: 'u1', text: '', ts: 0, ...p }),
  agent: (e: WireAgentEvent, ts = 0): Of<'agent'> => ({ kind: 'agent', e, ts }),
};

/** The store's socket, driven by the test: what the store sent, and the server's side of it. */
export interface FakeConnection {
  sent: ClientMessage[];
  /** an event from the server, through the connection as a real socket delivers it */
  emit(ev: ServerEvent): void;
  setState(s: SocketState): void;
}

export interface TestStoreOptions {
  /** given: sent first, on today's protocol unless it names one; absent: no hello (protocol 0) */
  hello?: Partial<HelloEvent>;
  /** sent after the hello */
  events?: ServerEvent[];
  /** the socket's state once made (default open) */
  state?: SocketState;
}

/** The app's store, with every plugin unless the test names its own. */
export const makeStore = (o: Omit<Parameters<typeof coreStore>[0], 'plugins'> & { plugins?: Parameters<typeof coreStore>[0]['plugins'] }): AppStore =>
  coreStore({ plugins: PLUGINS, ...o });

/** makeStore on a FakeConnection. */
export function testStore(o: TestStoreOptions = {}): { store: AppStore; conn: FakeConnection } {
  let emit: (ev: ServerEvent) => void = () => {};
  let setState: (s: SocketState) => void = () => {};
  const conn: FakeConnection = { sent: [], emit: (ev) => emit(ev), setState: (s) => setState(s) };
  const store = makeStore({
    url: 'ws://test',
    connect: (_url, onEvent, onState) => {
      emit = onEvent;
      setState = onState;
      return { send: (m) => (conn.sent.push(m), true), close() {} };
    },
  });
  conn.setState(o.state ?? 'open');
  if (o.hello) conn.emit(events.hello(o.hello));
  for (const ev of o.events ?? []) conn.emit(ev);
  return { store, conn };
}

type Answer = object | string | number | boolean | null | ((req: Request) => Response | Promise<Response>);

/**
 * Replaces fetch with answers keyed by path (no query): a value answers as JSON, a function gets the Request. Every
 * request lands in `calls`; an unmatched one answers 404. `restore` puts the previous fetch back.
 */
export function stubRoutes(routes: Record<string, Answer>): { calls: Request[]; restore(): void } {
  const prev = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const req = new Request(input instanceof Request ? input : new URL(String(input), location.href), init);
    calls.push(req.clone());
    const answer = routes[new URL(req.url).pathname];
    if (answer === undefined) return new Response(null, { status: 404 });
    return typeof answer === 'function' ? answer(req) : Response.json(answer);
  };
  return { calls, restore: () => void (globalThis.fetch = prev) };
}

/** render inside the store's Provider and the TooltipProvider (also on rerender). */
export function renderWith(ui: ReactElement, o: TestStoreOptions = {}) {
  const { store, conn } = testStore(o);
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}><TooltipProvider>{children}</TooltipProvider></Provider>;
  return { ...render(ui, { wrapper }), store, conn };
}
