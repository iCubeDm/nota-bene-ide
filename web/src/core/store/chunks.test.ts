import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { coalesceChunks } from './chunks.ts';

const chunk = (text: string): ServerEvent => ({ kind: 'agent', ts: 1, e: { t: 'message-chunk', text } });
const message: ServerEvent = { kind: 'agent', ts: 2, e: { t: 'message', id: 'm', text: 'abc' } };

function setup() {
  const out: ServerEvent[] = [];
  const frames = new Map<number, () => void>();
  let n = 0;
  const on = coalesceChunks((ev) => out.push(ev), (cb) => (frames.set(++n, cb), n), (id) => frames.delete(id));
  const tick = () => { const cbs = [...frames.values()]; frames.clear(); for (const cb of cbs) cb(); };
  return { out, on, tick, frames };
}

describe('coalesceChunks (issue 471)', () => {
  it('the chunks of one frame reach the store as one, texts joined', () => {
    const { out, on, tick } = setup();
    for (const t of ['a', 'b', 'c']) on(chunk(t));
    expect(out).toEqual([]);
    tick();
    expect(out).toEqual([chunk('abc')]);
    on(chunk('d'));
    tick();
    expect(out).toEqual([chunk('abc'), chunk('d')]);
  });

  it('another event delivers the pending chunk first and cancels its frame', () => {
    const { out, on, frames } = setup();
    on(chunk('a'));
    on(chunk('b'));
    on(message);
    expect(out).toEqual([chunk('ab'), message]);
    expect(frames.size).toBe(0);
  });
});
