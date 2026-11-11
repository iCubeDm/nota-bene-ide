import { act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROTOCOL, type ClientMessage, type PromptEntry, type ServerEvent } from '@nota-bene/shared';
import { makeStore, serverEvent } from '@/store/store.ts';
import { setDraft } from './slice.ts';
import { sendBatch } from '@/comments/send.ts';
import { selectPromptItems } from './history.ts';

const posts: { url: string; body: PromptEntry & { session: string | null } }[] = [];
let served: { session: string | null; prompts: PromptEntry[] } = { session: null, prompts: [] };
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'POST') {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify(served), { status: 200 });
});
beforeEach(() => {
  posts.length = 0;
  served = { session: null, prompts: [] };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const p = (id: string, text = `t-${id}`, extra: Partial<PromptEntry> = {}): PromptEntry => ({ id, ts: 1, text, src: 'typed', ...extra });
const session = (id: string | null): ServerEvent => ({ kind: 'session', id, root: '/p', title: null, model: null });

function setup() {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  const feed = (ev: ServerEvent) => act(() => void store.dispatch(serverEvent(ev)));
  feed({ kind: 'hello', protocol: PROTOCOL });
  return { store, feed, sent };
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const items = (store: ReturnType<typeof setup>['store']) => selectPromptItems(store.getState()).map((x) => x.id);

it('a typed send is recorded on the server echo, with the draft text, not before', async () => {
  const { store, feed, sent } = setup();
  feed(session('s1'));
  await flush();
  act(() => void store.dispatch(setDraft('hello there')));
  act(() => void store.dispatch(sendBatch(false)));
  const id = (sent.find((m) => m.type === 'send') as { id: string }).id;
  await flush();
  expect(posts).toHaveLength(0);
  expect(items(store)).toEqual([]);
  feed({ kind: 'user', id, text: 'hello there', ts: 5 });
  await flush();
  expect(items(store)).toEqual([id]);
  expect(selectPromptItems(store.getState())[0]).toMatchObject({ text: 'hello there', src: 'typed' });
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe('/prompts');
  expect(posts[0]!.body).toMatchObject({ session: 's1', id, text: 'hello there', src: 'typed' });
});

it('a refused send is not recorded', async () => {
  const { store, feed, sent } = setup();
  feed(session('s1'));
  act(() => void store.dispatch(setDraft('nope')));
  act(() => void store.dispatch(sendBatch(false)));
  const id = (sent.find((m) => m.type === 'send') as { id: string }).id;
  feed({ kind: 'send-refused', id, reason: 'busy' } as ServerEvent);
  await flush();
  expect(items(store)).toEqual([]);
  expect(posts).toHaveLength(0);
});

it('a send of comments only (an empty draft) is not recorded', async () => {
  const { store, feed } = setup();
  feed(session('s1'));
  feed({ kind: 'user', id: 'foreign', text: 'from another window', ts: 1 });
  await flush();
  expect(items(store)).toEqual([]);
  expect(posts).toHaveLength(0);
});

it('a `! cmd` is recorded on shell-start, src shell, and not when refused', async () => {
  const { store, feed, sent } = setup();
  feed(session('s1'));
  act(() => void store.dispatch(setDraft('! git status')));
  act(() => void store.dispatch(sendBatch(false)));
  const id = (sent.find((m) => m.type === 'shell-run') as { id: string }).id;
  await flush();
  expect(items(store)).toEqual([]);
  feed({ kind: 'shell-start', id, cmd: 'git status', ts: 1 });
  await flush();
  expect(selectPromptItems(store.getState())[0]).toMatchObject({ id, text: '! git status', src: 'shell' });
  expect(posts[0]!.body).toMatchObject({ id, src: 'shell' });
});

it('a live voice transcript is recorded as voice; an empty one or a replayed one is not', async () => {
  const { store, feed } = setup();
  feed(session('s1'));
  feed({ kind: 'voice-text', id: 'v0', text: '', ts: 1 });
  feed({ kind: 'voice-text', id: 'v1', error: 'failed', ts: 1 });
  feed({ kind: 'replay', events: [session('s1'), { kind: 'voice-text', id: 'v-old', text: 'old words', ts: 1 }] });
  await flush();
  expect(items(store)).toEqual([]);
  feed({ kind: 'voice-text', id: 'v2', text: 'say this', ts: 2 });
  await flush();
  expect(selectPromptItems(store.getState())[0]).toMatchObject({ id: 'v2', text: 'say this', src: 'voice' });
  expect(posts[0]!.body).toMatchObject({ id: 'v2', src: 'voice', session: 's1' });
});

it('loads the stored history when the session is announced and on a replay; a stale answer is dropped', async () => {
  const { store, feed } = setup();
  served = { session: 's1', prompts: [p('a'), p('b')] };
  feed(session('s1'));
  await flush();
  expect(fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/prompts'))).toEqual(['/prompts?session=s1']);
  expect(items(store)).toEqual(['a', 'b']);
  // another session: the old items are gone at once, the new ones load
  served = { session: 's2', prompts: [p('c')] };
  feed(session('s2'));
  expect(items(store)).toEqual([]);
  await flush();
  expect(items(store)).toEqual(['c']);
  // an answer that arrives after another switch is discarded
  let release!: () => void;
  fetchMock.mockImplementationOnce(() => new Promise((r) => { release = () => r(new Response(JSON.stringify({ session: 's3', prompts: [p('late')] }))); }));
  feed(session('s3'));
  served = { session: 's4', prompts: [p('d')] };
  feed(session('s4'));
  await flush();
  release();
  await flush();
  expect(items(store)).toEqual(['d']);
});

it('prompts sent before the session had an id stay when it gets one, merged with the stored ones', async () => {
  const { store, feed, sent } = setup();
  feed(session(null));
  act(() => void store.dispatch(setDraft('first of a new session')));
  act(() => void store.dispatch(sendBatch(false)));
  const id = (sent.find((m) => m.type === 'send') as { id: string }).id;
  feed({ kind: 'user', id, text: 'first of a new session', ts: 1 });
  await flush();
  expect(posts[0]!.body.session).toBeNull();
  served = { session: 's1', prompts: [p('x'), p(id, 'first of a new session')] };
  feed(session('s1'));
  await flush();
  expect(items(store)).toEqual(['x', id]);
});

it('a failing POST or GET only logs: nothing throws and the local list keeps the prompt', async () => {
  const { store, feed, sent } = setup();
  fetchMock.mockRejectedValue(new Error('offline'));
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  feed(session('s1'));
  act(() => void store.dispatch(setDraft('kept')));
  act(() => void store.dispatch(sendBatch(false)));
  const id = (sent.find((m) => m.type === 'send') as { id: string }).id;
  feed({ kind: 'user', id, text: 'kept', ts: 1 });
  await flush();
  expect(items(store)).toEqual([id]);
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});
