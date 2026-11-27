import { afterEach, expect, it, vi } from 'vitest';
import { DRAFT_MAX, type ClientMessage, type ServerEvent } from '@nota-bene/shared';
import { testStore, type FakeConnection } from '@/core/testing';
import { addImage, chat, markAttachment } from '@/sdk';
import { composerPlugin } from './plugin.ts';
import { flushDraft, setDraft } from './slice.ts';

afterEach(() => vi.useRealTimers());

type Draft = Extract<ClientMessage, { type: 'draft' }>;
const img = { id: 'a'.repeat(64), mediaType: 'image/png' as const };
const draft = (sessionId: string | null, text: string, o: { ack?: string; images?: typeof img[] } = {}): ServerEvent => ({ kind: 'draft', sessionId, text, ...o });
const writes = (conn: FakeConnection) => conn.sent.filter((m): m is Draft => m.type === 'draft');
/** a store attached to session `s1` (its draft before hello, as the server sends it) */
function attached(sessionId: string | null = 's1', protocol?: number) {
  const { store, conn } = testStore();
  conn.emit(draft(sessionId, ''));
  conn.emit({ kind: 'hello', protocol: protocol ?? 40 });
  return { store, conn, text: () => store.getState().composer.draft };
}

it('a local edit is written at once, tagged with its session; its own echo leaves the text', () => {
  const { store, conn, text } = attached();
  store.dispatch(setDraft('ab'));
  expect(writes(conn)).toEqual([{ type: 'draft', id: expect.any(String), sessionId: 's1', text: 'ab' }]);
  store.dispatch(setDraft('abc')); // typed since, inside the throttle
  conn.emit(draft('s1', 'ab', { ack: writes(conn)[0]!.id }));
  expect(text()).toBe('abc');
});

it('a foreign draft applies while clean, not over a pending or dirty one; a draft without ack ends the wait', () => {
  const { store, conn, text } = attached();
  conn.emit(draft('s1', 'from the phone', { ack: 'theirs' }));
  expect(text()).toBe('from the phone');
  store.dispatch(setDraft('mine'));
  conn.emit(draft('s1', 'theirs again', { ack: 'theirs2' }));
  expect(text()).toBe('mine');
  conn.emit(draft('s1', 'mine')); // a failed switch elsewhere: no ack is coming for the write
  conn.emit(draft('s1', 'later', { ack: 'theirs3' }));
  expect(text()).toBe('later');
});

it('a scope change writes the dirty text to the old session and shows the new one', () => {
  const { store, conn, text } = attached();
  store.dispatch(setDraft('half'));
  store.dispatch(setDraft('half more')); // not written yet: the throttle holds it
  expect(writes(conn).map((w) => w.text)).toEqual(['half']);
  conn.emit(draft('s2', 'in s2'));
  expect(writes(conn).at(-1)).toMatchObject({ sessionId: 's1', text: 'half more' });
  expect(text()).toBe('in s2');
  conn.emit(draft('s2', 'phone in s2', { ack: 'x' }));
  expect(text()).toBe('phone in s2');
});

it('typing in a switch is held, and carried to the new session', () => {
  const { store, conn, text } = attached();
  store.dispatch({ type: 'controls/switchStarted', payload: false });
  store.dispatch(setDraft('typed while switching'));
  store.dispatch(flushDraft());
  store.dispatch({ type: 'controls/switchCleared' });
  expect(writes(conn)).toEqual([]);
  conn.emit(draft('s2', 'old words of s2'));
  expect(text()).toBe('typed while switching');
  expect(writes(conn)).toEqual([expect.objectContaining({ sessionId: 's2', text: 'typed while switching' })]);
});

it('an adoption keeps a dirty text and retags it; a non-empty draft of another session wins', () => {
  const { store, conn, text } = attached(null);
  store.dispatch(setDraft('a'));
  store.dispatch(setDraft('ab'));
  conn.emit(draft('s1', ''));
  expect(text()).toBe('ab');
  store.dispatch(flushDraft());
  expect(writes(conn).at(-1)).toMatchObject({ sessionId: 's1', text: 'ab' });

  const other = attached(null);
  other.store.dispatch(setDraft('x'));
  other.store.dispatch(setDraft('xy'));
  other.conn.emit(draft('s9', 'the other session'));
  expect(other.text()).toBe('the other session');
});

it('reconcile at hello: a text typed before the attach draft wins, and so does one typed offline', () => {
  const { store, conn } = testStore();
  store.dispatch(setDraft('typed early'));
  conn.emit(draft('s1', 'stored'));
  expect(store.getState().composer.draft).toBe('typed early');
  conn.emit({ kind: 'hello', protocol: 40 });
  expect(writes(conn)).toEqual([expect.objectContaining({ sessionId: 's1', text: 'typed early' })]);

  vi.useFakeTimers();
  store.dispatch(setDraft('offline words')); // pending: lost with the socket
  const before = writes(conn).length;
  conn.setState('closed');
  conn.setState('open');
  conn.emit(draft('s1', 'typed early'));
  expect(store.getState().composer.draft).toBe('offline words');
  vi.advanceTimersByTime(400);
  conn.emit({ kind: 'hello', protocol: 40 });
  expect(writes(conn).slice(before).at(-1)).toMatchObject({ sessionId: 's1', text: 'offline words' });
});

it('a send flushes the emptied draft at once', () => {
  const { store, conn } = attached();
  store.dispatch(setDraft('hello'));
  store.dispatch(chat.send('', { force: false }));
  expect(conn.sent.map((m) => m.type)).toEqual(['draft', 'send', 'draft']);
  expect(writes(conn).at(-1)).toMatchObject({ text: '' });
});

it('no write below protocol 40; an oversized draft stays local', () => {
  const old = attached('s1', 39);
  old.store.dispatch(setDraft('x'));
  old.store.dispatch(flushDraft());
  expect(writes(old.conn)).toEqual([]);
  const { store, conn } = attached();
  store.dispatch(setDraft('x'.repeat(DRAFT_MAX + 1)));
  expect(writes(conn)).toEqual([]);
});

it('a foreign draft replaces the images; the markup of an image that went closes', () => {
  const { store, conn } = attached();
  conn.emit(draft('s1', '', { images: [img] }));
  expect(store.getState().message.images).toEqual([img]);
  store.dispatch(markAttachment(img.id));
  conn.emit(draft('s1', ''));
  expect(store.getState().message).toMatchObject({ images: [], marking: null });
  store.dispatch(addImage(img)); // an upload is a local edit
  expect(writes(conn).at(-1)).toMatchObject({ text: '', images: [img] });
});

it('the update pause counts the draft only while it is unsynced', () => {
  const { store, conn } = attached();
  const pause = () => composerPlugin.pause!(store.getState(), { draft: true });
  store.dispatch(setDraft('words'));
  expect(pause()).toBe(false);
  conn.emit(draft('s1', 'words', { ack: writes(conn)[0]!.id }));
  expect(pause()).toBe(true);
  const old = attached('s1', 39);
  old.store.dispatch(setDraft('words'));
  expect(composerPlugin.pause!(old.store.getState(), { draft: true })).toBe(false);
});
