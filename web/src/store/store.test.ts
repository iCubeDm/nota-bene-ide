import { afterEach, expect, it, vi } from 'vitest';
import { configureStore, type Middleware } from '@reduxjs/toolkit';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { makeStore } from '@/testing';
import { PLUGINS } from '../plugins.ts';
import { commentsSlice } from '../comments/slice.ts';
import { composerSlice } from '../composer/slice.ts';
import { historySlice } from '../composer/history.ts';
import { controlsSlice } from '../controls/slice.ts';
import { feedUiSlice } from '../feed/uiSlice.ts';
import { filesSlice } from '../files/slice.ts';
import { markupSlice } from '../media/markup/slice.ts';
import { remoteSlice } from '../remote/slice.ts';
import { statsSlice } from '../stats/slice.ts';
import { subagentsSlice } from '../subagent/slice.ts';
import { tasksSlice, tasksUiSlice } from '../tasks/slice.ts';
import { tabsSlice } from '../tabs/slice.ts';
import { treeSlice } from '../files/treeSlice.ts';
import { refusedMiddleware } from '../composer/refused.ts';
import { historyMiddleware } from '../composer/history.ts';
import { compactTimingMiddleware } from '../feed/compactTiming.ts';
import { enterRoot } from '../tabs/slice.ts';
import type { Plugin } from '../sdk/plugin.ts';
import { connSlice, devToolsEnabled, feedSlice, interrupt, makeStore as coreStore, middlewareOf, selectBusy, selectFeed, sendMessage, toastMiddleware } from './store.ts';

function fake() {
  const sent: ClientMessage[] = [];
  let onEvent!: (e: ServerEvent) => void;
  let onState!: (s: 'open' | 'closed') => void;
  const connect = vi.fn((_u: unknown, e: typeof onEvent, s: typeof onState) => {
    onEvent = e;
    onState = s;
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  return { sent, connect, ev: (e: ServerEvent) => onEvent(e), state: (s: 'open' | 'closed') => onState(s) };
}

afterEach(() => { vi.unstubAllEnvs(); });

it('the plugins inject every slice under its name of before issue 511, with the same initial state', () => {
  // the store as it was assembled before plugins (one reducer map naming every slice): persisted state and selectors rely on it
  const before = configureStore({
    reducer: { feed: feedSlice.reducer, conn: connSlice.reducer, comments: commentsSlice.reducer, composer: composerSlice.reducer, tabs: tabsSlice.reducer, tree: treeSlice.reducer, files: filesSlice.reducer, controls: controlsSlice.reducer, stats: statsSlice.reducer, remote: remoteSlice.reducer, tasks: tasksSlice.reducer, tasksUi: tasksUiSlice.reducer, markup: markupSlice.reducer, feedUi: feedUiSlice.reducer, subagents: subagentsSlice.reducer, promptHistory: historySlice.reducer },
  });
  const store = coreStore({ url: 'u', connect: fake().connect, plugins: PLUGINS });
  expect(Object.keys(store.getState()).sort()).toEqual(Object.keys(before.getState()).sort());
  expect(store.getState()).toEqual(before.getState());
});

it('a slice name two plugins declare fails at creation', () => {
  const twice = [{ id: 'a', slices: [statsSlice] }, { id: 'b', slices: [statsSlice] }];
  expect(() => coreStore({ url: 'u', connect: fake().connect, plugins: twice })).toThrow(/stats/);
});

it('inbound frames reach the feed', () => {
  const f = fake();
  const store = makeStore({ url: 'ws://x/ws', connect: f.connect });
  expect(f.connect).toHaveBeenCalledTimes(1);
  f.ev({ kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  expect(selectBusy(store.getState())).toBe(true);
  f.ev({ kind: 'agent', ts: 2, e: { t: 'turn-end', stop: 'done', secs: 0, answers: ['u1'], queued: 0 } });
  expect(selectBusy(store.getState())).toBe(false);
  expect(selectFeed(store.getState()).items).toHaveLength(2);
});

it('sendMessage returns false while closed', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  expect(store.dispatch(sendMessage('hi', false))).toBe(false);
  expect(f.sent).toEqual([]);
  f.state('open');
  expect(store.dispatch(sendMessage('hi', true))).toBe(true);
  expect(f.sent[0]).toMatchObject({ type: 'send', text: 'hi', force: false }); // idle: force dropped
});

it('interrupt while idle sends nothing', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  f.state('open');
  store.dispatch(interrupt());
  expect(f.sent).toEqual([]);
});

it('devtools only in dev', () => {
  vi.stubEnv('DEV', true);
  expect(devToolsEnabled()).toBe(true);
  vi.stubEnv('DEV', false);
  expect(devToolsEnabled()).toBe(false);
});

it('selectReplyLabel numbers final assistant items and names user messages', async () => {
  const { setLang } = await import('../i18n/index.ts');
  const { selectReplyLabel } = await import('../comments/send.ts');
  setLang('en');
  const f = fake();
  const store = makeStore({ url: 'ws://x/ws', connect: f.connect });
  f.ev({ kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  const a = (uuid: string, text: string) => f.ev({ kind: 'agent', ts: 2, e: { t: 'message', id: `${uuid}:0`, text } });
  a('a1', 'one');
  a('a2', 'two');
  const st = store.getState();
  expect(selectReplyLabel(st, 'u1')).toBe('my message');
  expect(selectReplyLabel(st, 'a1:0')).toBe('reply #1');
  expect(selectReplyLabel(st, 'a2:0')).toBe('reply #2');
  expect(selectReplyLabel(st, 'a2:0', true)).toBe('reply'); // the batch text: no unstable number
  const { whereOf } = await import('../comments/send.ts');
  const on = (id: string) => ({ anchor: { source: { kind: 'message', id }, start: 0, end: 1, quote: 'q', prefix: '', suffix: '' } }) as never;
  expect(whereOf(on('a2:0'), st)).toBe('reply'); // the agent never sees the UI numbering
  expect(whereOf(on('u1'), st)).toBe('my message');
  expect(selectReplyLabel(st, 'nope')).toBeNull();
});

it('a live compaction records its duration for the next estimate; a replayed one does not', () => {
  localStorage.clear();
  const f = fake();
  makeStore({ url: 'ws://x/ws', connect: f.connect });
  const cb = { t: 'compacted', preTokens: 1, ms: 42000 } as const;
  f.ev({ kind: 'replay', events: [{ kind: 'agent', ts: 1, e: cb }] });
  expect(localStorage.getItem('nb.compactMs')).toBeNull();
  f.ev({ kind: 'agent', ts: 2, e: cb });
  expect(JSON.parse(localStorage.getItem('nb.compactMs')!)).toEqual([42000]);
  localStorage.clear();
});

it('hello.lang sets the UI language; a hello without it leaves the local choice', async () => {
  const { getLang, setLang } = await import('../i18n/index.ts');
  const f = fake();
  makeStore({ url: 'u', connect: f.connect });
  setLang('en');
  f.ev({ kind: 'hello', protocol: 9, lang: 'ru' });
  expect(getLang()).toBe('ru');
  f.ev({ kind: 'hello', protocol: 9 });
  expect(getLang()).toBe('ru');
  setLang('en');
});

it('the appended middleware: the core\'s toast, each plugin\'s in PLUGINS order (compactTiming, now feed\'s, after composer\'s), media last', () => {
  const media: Middleware = () => (next) => next;
  expect(middlewareOf(PLUGINS, media)).toEqual([toastMiddleware, refusedMiddleware, historyMiddleware, compactTimingMiddleware, media]);
});

it('the listener middleware is prepended: its listeners run after every appended middleware has passed the action on', () => {
  const seen: string[] = [];
  const probe: Plugin = {
    id: 'probe',
    middleware: [() => (next) => (a) => { const r = next(a); if ((a as { type: string }).type === 'probe') seen.push('middleware'); return r; }],
    listeners: (start) => void start({ predicate: (a) => a.type === 'probe', effect: () => void seen.push('listener') }),
  };
  coreStore({ url: 'u', connect: fake().connect, plugins: [probe] }).dispatch({ type: 'probe' });
  expect(seen).toEqual(['middleware', 'listener']);
});

it('listeners run core first, then each plugin\'s in plugins order: a plugin sees the new root\'s tabs already restored', () => {
  localStorage.clear();
  localStorage.setItem('tabs:/r', JSON.stringify({ tabs: [{ file: { path: 'a.md' } }], active: 'file:a.md' }));
  const seen: string[] = [];
  const spy = (id: string): Plugin => ({
    id,
    listeners: (start) => void start({ actionCreator: enterRoot, effect: (_a, api) => void seen.push(`${id}:${api.getState().tabs.active}`) }),
  });
  const f = fake();
  // a subset of plugins: the core's own wiring touches no plugin's state
  coreStore({ url: 'u', connect: f.connect, plugins: [spy('b'), spy('a')] });
  f.ev({ kind: 'session', id: null, root: '/r', title: null, model: null });
  expect(seen).toEqual(['b:file:a.md', 'a:file:a.md']);
  localStorage.clear();
});
