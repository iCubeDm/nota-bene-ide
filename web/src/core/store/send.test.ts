import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ImageRef, ServerEvent } from '@nota-bene/shared';
import { controlsPlugin } from '@/plugins/controls/plugin.ts';
import { chat, definePlugin, type SendPart, type Taken } from '@/sdk';
import { makeStore } from '@/core/testing';
import { COMPOSITE_MS } from './send.ts';

// The core's send over the plugins' parts (issue 511, step 10d): taken in order at the click, composed in order once
// every part is ready, given back on a failure or a refusal.
const log: string[] = [];
beforeEach(() => void (log.length = 0));
afterEach(() => vi.useRealTimers());

function part(id: string, order: number, o: { text?: string; image?: string; ready?: Promise<void>; same?: () => boolean } = {}): SendPart {
  return {
    id, order,
    take: () => {
      log.push(`take ${id}`);
      const t: Taken = {
        ...(o.ready && { ready: o.ready }),
        unchanged: () => o.same?.() ?? true,
        compose: ({ images }) => (log.push(`compose ${id} after ${images.length}`), {
          ...(o.text && { text: o.text }),
          ...(o.image && { images: [{ id: o.image, mediaType: 'image/png', label: `#${images.length + 1}` } satisfies ImageRef] }),
          commentIds: [id],
        }),
        released: () => void log.push(`released ${id}`),
      };
      return t;
    },
  };
}

function setup(parts: SendPart[]) {
  const sent: ClientMessage[] = [];
  let emit: (ev: ServerEvent) => void = () => {};
  const store = makeStore({
    url: 'ws://x',
    plugins: [controlsPlugin, definePlugin({ id: 't', sendParts: parts })],
    connect: (_u, onEvent, onState) => {
      emit = onEvent;
      queueMicrotask(() => onState('open'));
      return { send: (m) => (sent.push(m), true), close() {} };
    },
  });
  return { store, sent: () => sent.filter((m): m is Extract<ClientMessage, { type: 'send' }> => m.type === 'send'), emit: (ev: ServerEvent) => emit(ev) };
}
const open = () => new Promise<void>((r) => queueMicrotask(r));

it('takes every part in order, composes in order with the images so far, and sends one message', async () => {
  const { store, sent } = setup([part('b', 20, { text: 'B', image: 'b.png' }), part('a', 10, { text: 'A', image: 'a.png' })]);
  await open();
  expect(store.dispatch(chat.send('', { force: false }))).toBe('sent');
  expect(log).toEqual(['take a', 'take b', 'compose a after 0', 'compose b after 1']);
  expect(sent()).toMatchObject([{ text: 'A\n\nB', commentIds: ['a', 'b'], images: [{ id: 'a.png', label: '#1' }, { id: 'b.png', label: '#2' }] }]);
});

it('a parts filter takes only those parts', async () => {
  const { store, sent } = setup([part('a', 10, { text: 'A' }), part('b', 20, { text: 'B' })]);
  await open();
  store.dispatch(chat.send('', { parts: ['b'] }));
  expect(sent()[0].text).toBe('B');
  expect(log).toEqual(['take b', 'compose b after 0']);
});

it('waits for every part to be ready before composing, the send building meanwhile', async () => {
  let done!: () => void;
  const { store, sent } = setup([part('a', 10, { text: 'A', ready: new Promise<void>((r) => (done = r)) })]);
  await open();
  expect(store.dispatch(chat.send(''))).toBe('building');
  expect(store.getState().message.building).toBe(true); // the core holds it: the send buttons are off meanwhile
  expect(sent()).toEqual([]);
  done();
  await vi.waitFor(() => expect(sent()).toHaveLength(1));
});

it('a part that is not ready in COMPOSITE_MS does not hold the send', async () => {
  vi.useFakeTimers();
  const { store, sent } = setup([part('a', 10, { text: 'A', ready: new Promise<void>(() => {}) })]);
  await vi.advanceTimersByTimeAsync(0);
  store.dispatch(chat.send(''));
  await vi.advanceTimersByTimeAsync(COMPOSITE_MS - 1);
  expect(sent()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(sent()).toHaveLength(1);
});

it('a part changed while waiting: nothing is sent and every part is given back', async () => {
  let done!: () => void;
  const { store, sent } = setup([part('a', 10, { text: 'A' }), part('b', 20, { text: 'B', ready: new Promise<void>((r) => (done = r)), same: () => false })]);
  await open();
  store.dispatch(chat.send(''));
  done();
  await vi.waitFor(() => expect(log).toContain('released b'));
  expect(log).toContain('released a');
  expect(sent()).toEqual([]);
});

it('a refused send gives its parts back; an echoed one is forgotten', async () => {
  const { store, sent, emit } = setup([part('a', 10, { text: 'A' })]);
  await open();
  store.dispatch(chat.send('', { id: 'm1' }));
  store.dispatch(chat.send('', { id: 'm2' }));
  emit({ kind: 'user', id: 'm1', text: 'A', ts: 0 });
  emit({ kind: 'send-refused', id: 'm1', reason: 'busy' });
  expect(log).not.toContain('released a');
  emit({ kind: 'send-refused', id: 'm2', reason: 'busy' });
  expect(log.filter((l) => l === 'released a')).toHaveLength(1);
  expect(sent()).toHaveLength(2);
});

it('offline: nothing goes and the parts are given back', () => {
  const { store } = setup([part('a', 10, { text: 'A' })]);
  expect(store.dispatch(chat.send(''))).toBe('offline');
  expect(log).toEqual(['take a', 'compose a after 0', 'released a']);
});

it('a message with no part to take: the text alone, or nothing', async () => {
  const { store, sent } = setup([]);
  await open();
  expect(store.dispatch(chat.send(''))).toBe('empty');
  expect(store.dispatch(chat.send('go on', { parts: [] }))).toBe('sent');
  expect(sent()).toMatchObject([{ text: 'go on', force: false }]);
});
