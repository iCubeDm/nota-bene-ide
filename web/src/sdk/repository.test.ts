// The one shared poll of issue 511: a cache per key, in-flight dedupe, the timeout, the pause and the ref-counted stop.
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { events, stubRoutes, testStore } from '@/testing';
import { connectionsOf } from './connections.ts';
import { defineResource, repositoryOf, useResource } from './repository.ts';

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
