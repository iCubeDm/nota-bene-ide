import { act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { makeStore, serverEvent } from '@/store/store.ts';
import { claim, SETTLE_MS, startSounds, type Cue, type Sounds } from './sounds.ts';

let stops: (() => void)[] = [];
let focused = false;
let hidden = true;
let prefs: Sounds | null;
let played: Cue[];
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  focused = false; hidden = true;
  prefs = { ask: true, done: false };
  played = [];
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
});
afterEach(() => { for (const s of stops) s(); stops = []; vi.useRealTimers(); vi.restoreAllMocks(); });

const user: ServerEvent = { kind: 'user', id: 'u1', text: 'hi', ts: 1 } as ServerEvent;
const perm = (id: string): ServerEvent => ({ kind: 'permission', id, toolName: 'Bash', input: {}, ts: 2 } as unknown as ServerEvent);
const answered = (id: string): ServerEvent => ({ kind: 'permission-done', id, allow: true, ts: 3 } as unknown as ServerEvent);
const turnEnd = (stop: 'done' | 'failed', ts = 4): ServerEvent => ({ kind: 'agent', ts, e: { t: 'turn-end', stop, secs: 0, answers: ['u1'], queued: 0, ...(stop === 'failed' ? { error: 'boom' } : {}) } } as ServerEvent);

/** One tab: a store with the sounds running; `ev` lands an event in it. */
function tab(doc?: { hidden: boolean; hasFocus: () => boolean }) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  stops.push(startSounds(store, { read: async () => prefs, play: (c) => void played.push(c), ...(doc ? { doc: doc as Document } : {}) }));
  return (e: ServerEvent) => act(() => { store.dispatch(serverEvent(e)); });
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_MS); });

it('a question while the tab is not looked at sounds once, after the settle time', async () => {
  const ev = tab();
  ev(user);
  ev(perm('p1'));
  expect(played).toEqual([]);
  await settle();
  expect(played).toEqual(['ask']);
  ev(user); // later updates of the same prompt do not sound again
  await settle();
  expect(played).toEqual(['ask']);
});

it('no sound while the tab is looked at, nor for a prompt answered before the settle time', async () => {
  focused = true; hidden = false;
  const ev = tab();
  ev(perm('p1'));
  await settle();
  expect(played).toEqual([]);
  focused = false; hidden = true;
  ev(perm('p2'));
  ev(answered('p2'));
  await settle();
  expect(played).toEqual([]);
});

it('a replay never sounds: neither its prompts nor its results', async () => {
  prefs = { ask: true, done: true };
  const ev = tab();
  ev({ kind: 'replay', events: [user, turnEnd('done')] } as ServerEvent);
  ev({ kind: 'replay', events: [user, perm('p1')] } as ServerEvent);
  await settle();
  ev(user); // the next live event: the replayed prompt is still not news
  await settle();
  expect(played).toEqual([]);
});

it('a turn end sounds only when the setting says so; a failure has its own cue', async () => {
  const ev = tab();
  ev(user);
  ev(turnEnd('done', 4));
  await settle();
  expect(played).toEqual([]); // done is off by default
  prefs = { ask: true, done: true };
  ev(user);
  ev(turnEnd('done', 5));
  await settle();
  ev(user);
  ev(turnEnd('failed', 6));
  await settle();
  expect(played).toEqual(['done', 'error']);
});

it('the setting is read for each cue: turned off, the question is silent', async () => {
  prefs = { ask: false, done: true };
  const ev = tab();
  ev(perm('p1'));
  await settle();
  expect(played).toEqual([]);
  prefs = null; // the server cannot be read: silence, not a guess
  ev(perm('p2'));
  await settle();
  expect(played).toEqual([]);
});

it('of two tabs of one window, one sounds; none when one of them is looked at', async () => {
  const a = tab();
  const b = tab();
  a(perm('p1'));
  b(perm('p1'));
  await settle();
  expect(played).toEqual(['ask']);
  expect(claim('ask:p1')).toBe(false); // taken
});

it('a tab that is looked at keeps the window\'s other tabs quiet', async () => {
  const seen = tab({ hidden: false, hasFocus: () => true });
  const away = tab({ hidden: true, hasFocus: () => false });
  away(perm('p1'));
  seen(perm('p1'));
  await settle();
  expect(played).toEqual([]);
});
