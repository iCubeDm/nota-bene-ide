// The one shared poll of issue 511: a cache per key, in-flight dedupe, the timeout, the pause and the ref-counted stop.
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { events, stubRoutes, testStore } from '@/core/testing';
import { connectionsOf } from './connections.ts';
import { defineResource, repositoryOf, send, useResource } from './repository.ts';

type Item = { n: number };
let answer: () => Response | Promise<Response>;
let routes: ReturnType<typeof stubRoutes>;
const asks = () => routes.calls.filter((r) => new URL(r.url).pathname === '/thing').length;
const thing = defineResource<string, Item>({ key: (id) => id, route: (id) => `/thing?id=${id}`, every: 1000 });

beforeEach(() => {
  vi.useFakeTimers();
  answer = () => Response.json({ n: 1 });
  routes = stubRoutes({ '/thing': () => answer() });
});
afterEach(() => {
  routes.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const setup = (o: Parameters<typeof testStore>[0] = {}) => {
  const t = testStore(o);
  return { ...t, repo: repositoryOf(connectionsOf(t.store).current()) };
};
const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const hidden = (on: boolean) => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(on ? 'hidden' : 'visible');
  document.dispatchEvent(new Event('visibilitychange'));
};

it('two watchers of one key share one fetch, one timer and one object', async () => {
  const { repo } = setup();
  const a = repo.watch(thing, 'x');
  const b = repo.watch(thing, 'x');
  await flush();
  expect(asks()).toBe(1);
  expect(repo.peek(thing, 'x').data).toEqual({ n: 1 });
  await flush(1000);
  expect(asks()).toBe(2);
  a();
  await flush(1000);
  expect(asks()).toBe(3); // one watcher left: still polled
  b();
  await flush(5000);
  expect(asks()).toBe(3); // the last one gone: stopped
  expect(repo.peek(thing, 'x').data).toEqual({ n: 1 }); // the cache keeps the answer
});

it('a request in flight is not asked again: the tick waits for it', async () => {
  const { repo } = setup();
  let say!: (r: Response) => void;
  answer = () => new Promise((res) => { say = res; });
  const stop = repo.watch(thing, 'x');
  await flush(3500);
  expect(asks()).toBe(1);
  say(Response.json({ n: 2 }));
  await flush();
  expect(repo.peek(thing, 'x').data).toEqual({ n: 2 });
  await flush(500);
  expect(asks()).toBe(2);
  stop();
});

it('a timeout marks the resource failed and keeps its data; the next answer clears it', async () => {
  const slow = defineResource<string, Item>({ key: (id) => id, route: (id) => `/thing?id=${id}`, every: 10_000, timeout: 2000 });
  const { repo } = setup();
  const stop = repo.watch(slow, 'x');
  await flush();
  expect(repo.peek(slow, 'x')).toMatchObject({ data: { n: 1 }, failed: false });
  answer = () => new Promise(() => {});
  void repo.load(slow, 'x');
  await flush(2000);
  expect(repo.peek(slow, 'x')).toMatchObject({ data: { n: 1 }, failed: true, error: 'timeout' });
  answer = () => Response.json({ n: 1 });
  await flush(8000);
  expect(repo.peek(slow, 'x')).toMatchObject({ data: { n: 1 }, failed: false, error: null });
  stop();
});

it('a refusal marks it failed with the path and the status, and keeps the data', async () => {
  const { repo } = setup();
  const stop = repo.watch(thing, 'x');
  await flush();
  answer = () => new Response('no', { status: 503 });
  await flush(1000);
  expect(repo.peek(thing, 'x')).toMatchObject({ data: { n: 1 }, failed: true, error: '/thing 503' });
  stop();
});

it('unchanged response text keeps the same object; a changed one replaces it', async () => {
  const { repo } = setup();
  const stop = repo.watch(thing, 'x');
  await flush();
  const first = repo.peek(thing, 'x');
  await flush(1000);
  expect(asks()).toBe(2);
  expect(repo.peek(thing, 'x')).toBe(first);
  answer = () => Response.json({ n: 2 });
  await flush(1000);
  expect(repo.peek(thing, 'x').data).toEqual({ n: 2 });
  stop();
});

it('paused while the page is hidden; showing it reads what the pause missed', async () => {
  const { repo } = setup();
  const stop = repo.watch(thing, 'x');
  await flush();
  hidden(true);
  await flush(5000);
  expect(asks()).toBe(1);
  hidden(false);
  await flush();
  expect(asks()).toBe(2);
  document.dispatchEvent(new Event('visibilitychange')); // still visible: nothing was missed
  await flush();
  expect(asks()).toBe(2);
  stop();
});

it('paused while the connection is not open; the reconnect reads at once', async () => {
  const { repo, conn } = setup();
  const stop = repo.watch(thing, 'x');
  await flush();
  conn.setState('closed');
  await flush(5000);
  expect(asks()).toBe(1);
  conn.setState('open');
  await flush();
  expect(asks()).toBe(2);
  await flush(1000);
  expect(asks()).toBe(3);
  stop();
});

it('an event of the kinds it names reads it again', async () => {
  const pushed = defineResource<string, Item>({ key: (id) => id, route: (id) => `/thing?id=${id}`, events: ['session'] });
  const { repo, conn } = setup();
  const stop = repo.watch(pushed, 'x');
  await flush(5000);
  expect(asks()).toBe(1); // no `every`: never polled
  conn.emit(events.user());
  await flush();
  expect(asks()).toBe(1);
  conn.emit(events.session());
  await flush();
  expect(asks()).toBe(2);
  stop();
  conn.emit(events.session());
  await flush();
  expect(asks()).toBe(2);
});

it('the shortest period of its watchers wins, and a shorter one reads at once', async () => {
  const { repo } = setup();
  const slow = repo.watch(thing, 'x', { every: 10_000 });
  await flush(3000);
  expect(asks()).toBe(1);
  const fast = repo.watch(thing, 'x', { every: 3000 });
  await flush();
  expect(asks()).toBe(2);
  await flush(3000);
  expect(asks()).toBe(3);
  fast();
  await flush(3000);
  expect(asks()).toBe(3);
  await flush(7000);
  expect(asks()).toBe(4);
  slow();
});

it('useResource: data for its args, nothing while off or without args, and refresh reads again', async () => {
  const { store } = setup({ hello: {} });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(Provider, { store, children });
  const { result, rerender } = renderHook(({ id, on }: { id: string | null; on: boolean }) => useResource(thing, id, { on }), { wrapper, initialProps: { id: null as string | null, on: true } });
  await flush();
  expect(asks()).toBe(0);
  expect(result.current.data).toBeNull();
  rerender({ id: 'x', on: false });
  await flush(3000);
  expect(asks()).toBe(0);
  rerender({ id: 'x', on: true });
  await flush();
  expect(asks()).toBe(1);
  expect(result.current).toMatchObject({ data: { n: 1 }, failed: false, loading: false });
  answer = () => Response.json({ n: 5 });
  act(() => result.current.refresh());
  await flush();
  expect(result.current.data).toEqual({ n: 5 });
  expect(asks()).toBe(2);
});

it('a refusal carries its status', async () => {
  const { repo } = setup();
  const stop = repo.watch(thing, 'x');
  await flush();
  expect(repo.peek(thing, 'x').status).toBeUndefined();
  answer = () => new Response('no', { status: 404 });
  await flush(1000);
  expect(repo.peek(thing, 'x')).toMatchObject({ failed: true, status: 404 });
  answer = () => Response.json({ n: 1 });
  await flush(1000);
  expect(repo.peek(thing, 'x')).toMatchObject({ failed: false, status: undefined });
  stop();
});

it('a watcher may keep polling while the page is hidden; the connection still pauses it', async () => {
  const { repo, conn } = setup();
  const stop = repo.watch(thing, 'x', { whileHidden: true });
  await flush();
  hidden(true);
  await flush(2000);
  expect(asks()).toBe(3);
  stop.set({ whileHidden: false });
  await flush(2000);
  expect(asks()).toBe(3);
  stop.set({ whileHidden: true }); // what the pause missed is read at once
  await flush();
  expect(asks()).toBe(4);
  conn.setState('closed');
  await flush(2000);
  expect(asks()).toBe(4);
  stop();
});

it('a reconnect asks afresh: a request hung across the drop is not waited for', async () => {
  const { repo, conn } = setup();
  answer = () => new Promise(() => {});
  const stop = repo.watch(thing, 'x');
  await flush();
  conn.setState('closed');
  answer = () => Response.json({ n: 2 });
  conn.setState('open');
  await flush();
  expect(asks()).toBe(2);
  expect(repo.peek(thing, 'x').data).toEqual({ n: 2 });
  stop();
});

it('invalidate forgets the answer, drops one still on its way, and a watched entry reads again', async () => {
  const { repo } = setup();
  const stop = repo.watch(thing, 'x');
  await flush();
  let say!: (r: Response) => void;
  answer = () => new Promise((res) => { say = res; });
  void repo.load(thing, 'x');
  await flush();
  const hung = say;
  answer = () => Response.json({ n: 3 });
  repo.invalidate(thing, 'x');
  expect(repo.peek(thing, 'x').data).toBeNull();
  await flush();
  expect(repo.peek(thing, 'x').data).toEqual({ n: 3 });
  hung(Response.json({ n: 9 }));
  await flush();
  expect(repo.peek(thing, 'x').data).toEqual({ n: 3 });
  stop();
  repo.invalidate(thing);
  await flush();
  expect(repo.peek(thing, 'x').data).toBeNull();
  expect(asks()).toBe(3); // an unwatched entry is not read again
});

it('the last stop clears the interval; an earlier one does not', async () => {
  const { repo } = setup();
  const a = repo.watch(thing, 'x');
  const b = repo.watch(thing, 'x');
  await flush();
  const clear = vi.spyOn(globalThis, 'clearInterval');
  a();
  expect(clear).not.toHaveBeenCalled();
  b();
  expect(clear).toHaveBeenCalledTimes(1);
  a();
  expect(clear).toHaveBeenCalledTimes(1); // a stop twice is a no-op
});

it('with a timeout, a tick replaces a request older than the period; its late answer is dropped', async () => {
  const quick = defineResource<string, Item>({ key: (id) => id, route: (id) => `/thing?id=${id}`, every: 1000, timeout: 5000 });
  const { repo } = setup();
  let say!: (r: Response) => void;
  answer = () => new Promise((res) => { say = res; });
  const stop = repo.watch(quick, 'x');
  await flush();
  const first = say;
  answer = () => Response.json({ n: 2 });
  await flush(1000);
  expect(asks()).toBe(2);
  expect(repo.peek(quick, 'x').data).toEqual({ n: 2 });
  first(Response.json({ n: 1 }));
  await flush();
  expect(repo.peek(quick, 'x').data).toEqual({ n: 2 });
  stop();
});

// The one write path of issue 564: JSON by default, a Blob as it is, the answer whatever its status
it('send posts JSON, a Blob as it is, nothing without a body, and resolves to a refusal', async () => {
  setup();
  routes.restore();
  routes = stubRoutes({ '/w': (req) => (new URL(req.url).searchParams.has('no') ? Response.json({ error: 'no' }, { status: 409 }) : Response.json({ ok: true })) });
  expect((await send('/w', { a: 1 })).ok).toBe(true);
  await send('/w', new Blob(['x'], { type: 'image/png' }));
  await send('/w', new Blob(['x']), { type: 'audio/wav', method: 'PUT' });
  await send('/w', undefined, { method: 'DELETE' });
  const r = await send('/w?no=1', {});
  expect([r.ok, r.status, await r.json()]).toEqual([false, 409, { error: 'no' }]);
  const [json, blob, typed, bare] = routes.calls;
  expect([json!.method, json!.headers.get('content-type'), await json!.text()]).toEqual(['POST', 'application/json', '{"a":1}']);
  expect([blob!.headers.get('content-type'), await blob!.text()]).toEqual(['image/png', 'x']);
  expect([typed!.method, typed!.headers.get('content-type')]).toEqual(['PUT', 'audio/wav']);
  expect([bare!.method, bare!.headers.get('content-type'), await bare!.text()]).toEqual(['DELETE', null, '']);
});

it('send rejects only when no answer came', async () => {
  setup();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
  await expect(send('/w', {})).rejects.toThrow('offline');
});
