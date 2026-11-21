// The test harness of issue 511 proves itself: routes, the fake connection, the render wrapper and the event builders.
import { act, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PROTOCOL } from '@nota-bene/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/components/ui/tooltip.tsx';
import { connectionsOf, useConnState } from '@/sdk/connections.ts';
import { selectConn, selectSession } from '@/core/store/store.ts';
import { events, renderWith, stubResources, stubRoutes, testStore } from './index.tsx';

let routes: ReturnType<typeof stubRoutes> | undefined;
afterEach(() => routes?.restore());

it('stubResources answers a registered resource by its id, at the path its route builds', async () => {
  routes = stubResources({ 'voice.dictation': { phase: 'none' }, 'vcs.log': { commits: [] } }, { 'vcs.log': { src: 'here', all: false } });
  expect(await (await fetch('/dictation')).json()).toEqual({ phase: 'none' });
  expect(await (await fetch('/vcs-log?src=here&all=1')).json()).toEqual({ commits: [] });
  expect(() => stubResources({ nowhere: {} })).toThrow('no resource "nowhere"');
});

it('stubRoutes answers by path; an unmatched route answers 404 and is recorded', async () => {
  const real = globalThis.fetch;
  routes = stubRoutes({
    '/info': { ok: 1 },
    '/edit': async (req) => Response.json({ got: req.method, body: await req.text(), q: new URL(req.url).searchParams.get('path') }),
  });
  expect(await (await fetch('/info?x=1')).json()).toEqual({ ok: 1 });
  expect(await (await fetch('/edit?path=a.txt', { method: 'POST', body: 'hi' })).json()).toEqual({ got: 'POST', body: 'hi', q: 'a.txt' });
  // a Request keeps its method and body; init on top of it overrides its headers
  const asked = new Request(new URL('/edit?path=b.txt', location.href), { method: 'POST', body: 'yo' });
  expect(await (await fetch(asked)).json()).toEqual({ got: 'POST', body: 'yo', q: 'b.txt' });
  await fetch(new Request(new URL('/info', location.href), { method: 'PUT', body: 'x' }), { headers: { 'x-k': '1' } });
  expect((await fetch('/nowhere')).status).toBe(404);
  expect(routes.calls.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /info', 'POST /edit', 'POST /edit', 'PUT /info', 'GET /nowhere']);
  expect(routes.calls[3]!.headers.get('x-k')).toBe('1');
  routes.restore();
  expect(globalThis.fetch).toBe(real);
});

it('testStore: the connection is open, the hello and events given are applied, and emit reaches the store', () => {
  const { store, conn } = testStore({ hello: { protocol: 20 }, events: [events.session({ title: 'First' })] });
  expect(selectConn(store.getState())).toBe('open');
  expect(store.getState().controls.protocol).toBe(20);
  expect(selectSession(store.getState())?.title).toBe('First');
  conn.emit(events.session({ title: 'Second' }));
  expect(selectSession(store.getState())?.title).toBe('Second');
  conn.setState('closed');
  expect(selectConn(store.getState())).toBe('closed');
});

it('sent records what the store sends; without a hello the protocol is 0, with an empty one the current', () => {
  const { store, conn } = testStore();
  expect(store.getState().controls.protocol).toBe(0);
  connectionsOf(store).current().send({ type: 'interrupt' });
  expect(conn.sent).toEqual([{ type: 'interrupt' }]);
  expect(testStore({ hello: {} }).store.getState().controls.protocol).toBe(PROTOCOL);
  expect(events.hello()).toEqual({ kind: 'hello', protocol: PROTOCOL });
});

it('renderWith wraps the store and tooltips, also on rerender', () => {
  const View = ({ label }: { label: string }) => (
    <Tooltip>
      <TooltipTrigger>{`${label} ${useConnState()}`}</TooltipTrigger>
      <TooltipContent>tip</TooltipContent>
    </Tooltip>
  );
  const r = renderWith(<View label="a" />, { state: 'closed' });
  expect(screen.getByText('a closed')).toBeTruthy();
  r.rerender(<View label="b" />);
  act(() => r.conn.setState('open'));
  expect(screen.getByText('b open')).toBeTruthy();
  expect(selectConn(r.store.getState())).toBe('open');
});
