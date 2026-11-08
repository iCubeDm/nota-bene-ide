import { describe, expect, it } from 'vitest';
import {
  CONN_WINDOW, DATA, decodeFrame, encodeFrame, FIN, MAX_CHUNK, MAX_STREAMS, Mux, STREAM_WINDOW, collect, type Frame, type Stream,
} from './mux.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 20; i++) await tick();
}

/** Two muxes back to back; `sent` counts the DATA body bytes each side put on the wire. */
function pair(onOpen?: (s: Stream, open: unknown) => void) {
  const sent = { phone: 0, host: 0 };
  const frames: Frame[] = [];
  let host!: Mux, phone!: Mux;
  const wire = (from: 'phone' | 'host') => (b: Buffer) => {
    const f = decodeFrame(b);
    if (f.type === DATA) sent[from] += f.data.length;
    if (from === 'phone') frames.push(f);
    queueMicrotask(() => (from === 'phone' ? host : phone).receive(b));
  };
  host = new Mux({ send: wire('host'), onOpen: onOpen ?? (() => {}) });
  phone = new Mux({ send: wire('phone') });
  return { host, phone, sent, frames };
}

describe('mux', () => {
  it('codec round trip', () => {
    const fs: Frame[] = [
      { type: 1, stream: 1, json: { kind: 'host' } },
      { type: 2, stream: 3, json: { status: 200 } },
      { type: 3, stream: 5, flags: FIN | 2, data: Buffer.from('abc') },
      { type: 4, stream: 7 },
      { type: 5, stream: 9, json: { code: 4904, reason: 'gone' } },
      { type: 6, stream: 0, n: 65536 },
    ];
    for (const f of fs) expect(decodeFrame(encodeFrame(f))).toEqual(f);
    expect(() => decodeFrame(Buffer.alloc(5))).toThrow();
    expect(() => decodeFrame(Buffer.from([9, 0, 0, 0, 1, 0]))).toThrow();
    expect(() => decodeFrame(Buffer.concat([Buffer.from([1, 0, 0, 0, 1, 0]), Buffer.from('{bad')]))).toThrow();
    expect(() => decodeFrame(Buffer.from([6, 0, 0, 0, 0, 0, 1]))).toThrow();
    // the DATA frame example of CHANNEL.md
    expect(encodeFrame({ type: 3, stream: 1, flags: FIN, data: Buffer.from('hi') }).toString('hex')).toBe('0300000001016869');
  });

  it('a message larger than a chunk arrives whole', async () => {
    let got: { data: Buffer; binary: boolean } | undefined;
    const { phone } = pair((s) => collect(s, (data, binary) => { got = { data, binary }; }));
    const big = Buffer.alloc(300 * 1024, 7);
    big[12345] = 1;
    phone.open({ kind: 'x' }).write(big, true);
    await settle();
    expect(got?.binary).toBe(true);
    expect(got?.data.equals(big)).toBe(true);
  });

  it('the sender stops at the stream credit and resumes', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let received = 0;
    const { phone, sent } = pair((s) => {
      s.ondata = async (chunk) => {
        received += chunk.length;
        await held;
      };
    });
    const s = phone.open({ kind: 'x' });
    let drained = false;
    s.on('drain', () => (drained = true));
    expect(s.write(Buffer.alloc(1024 * 1024))).toBe(false);
    await settle();
    expect(sent.phone).toBeLessThanOrEqual(STREAM_WINDOW);
    expect(sent.phone).toBeGreaterThan(0);
    release();
    await settle();
    expect(received).toBe(1024 * 1024);
    expect(drained).toBe(true);
  });

  it('the connection window bounds the total over all streams', async () => {
    const { phone, sent } = pair((s) => { s.ondata = () => new Promise(() => {}); });
    for (let i = 0; i < 4; i++) phone.open({ kind: 'x' }).write(Buffer.alloc(1024 * 1024));
    await settle();
    expect(sent.phone).toBeLessThanOrEqual(CONN_WINDOW);
    expect(sent.phone).toBeGreaterThan(STREAM_WINDOW);
  });

  it('data beyond the credit closes every stream with 4900', async () => {
    const codes: number[] = [];
    let failed: number | undefined;
    const host = new Mux({ send: () => {}, onOpen: (s) => s.on('close', (c: { code: number }) => codes.push(c.code)), onFail: (c) => (failed = c) });
    host.receive(encodeFrame({ type: 1, stream: 1, json: {} }));
    host.receive(encodeFrame({ type: 1, stream: 3, json: {} }));
    for (let i = 0; i < 5; i++) host.receive(encodeFrame({ type: DATA, stream: 1, flags: 0, data: Buffer.alloc(MAX_CHUNK) }));
    await settle();
    expect(codes).toEqual([4900, 4900]);
    expect(failed).toBe(4900);
  });

  it(`refuses open number ${MAX_STREAMS + 1}`, async () => {
    const { phone } = pair();
    const streams = Array.from({ length: MAX_STREAMS + 1 }, () => phone.open({ kind: 'x' }));
    const closed: number[] = [];
    streams.forEach((s, i) => s.on('close', (c: { code: number }) => closed.push(i, c.code)));
    await settle();
    expect(closed).toEqual([MAX_STREAMS, 4929]);
  });

  it('end comes before close, and a finished stream frees its slot', async () => {
    const order: string[] = [];
    const { phone, host } = pair((s) => {
      s.on('end', () => {
        s.head({ status: 200 });
        s.write(Buffer.from('ok'));
        s.end();
      });
    });
    const s = phone.open({ kind: 'x' });
    s.on('head', () => order.push('head'));
    collect(s, (d) => { order.push(`data:${d.toString()}`); });
    s.on('end', () => order.push('end'));
    s.on('close', (c: { code: number }) => order.push(`close:${c.code}`));
    s.end();
    await settle();
    expect(order).toEqual(['head', 'data:ok', 'end', 'close:1000']);
    expect(phone.size).toBe(0);
    expect(host.size).toBe(0);
  });

  it('close drops queued data and reaches the other side', async () => {
    const remote: number[] = [];
    const { phone, sent } = pair((s) => {
      s.ondata = () => new Promise(() => {});
      s.on('close', (c: { code: number }) => remote.push(c.code));
    });
    const s = phone.open({ kind: 'x' });
    s.write(Buffer.alloc(2 * 1024 * 1024));
    s.close(4001, 'taken over');
    await settle();
    expect(remote).toEqual([4001]);
    expect(sent.phone).toBeLessThanOrEqual(STREAM_WINDOW);
  });
});
