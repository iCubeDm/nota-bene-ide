import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_AUDIO } from './whisper.ts';
import {
  encodeFrame, FrameDecoder, helloProof, HOST_PINS, HOST_PROTO, hostDir, hostSecret, hostSocketPath, isPipePath, MAX_FRAME, MAX_HEADER, newNonce, parseRequest,
  pcmFromInt16, pcmToInt16, proofMatches, WireError,
} from './hostWire.ts';

const WIN = process.platform === 'win32';

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const raw = (header: unknown, body: Buffer = Buffer.alloc(0)): Buffer => {
  const h = Buffer.from(JSON.stringify(header));
  return Buffer.concat([u32(h.length), h, u32(body.length), body]);
};

describe('frames', () => {
  it('encode then decode gives the header and the body back', () => {
    const body = Buffer.from([1, 2, 3, 4]);
    const frames = new FrameDecoder().push(encodeFrame({ type: 'job', id: 7, opts: { lang: 'en', detect: false } }, body));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.header).toEqual({ type: 'job', id: 7, opts: { lang: 'en', detect: false } });
    expect([...frames[0]!.body]).toEqual([1, 2, 3, 4]);
  });
  it('a frame without a body has an empty one', () => {
    expect(new FrameDecoder().push(encodeFrame({ type: 'status' }))[0]!.body).toHaveLength(0);
  });
  it('lays the frame out as [u32 header length][JSON][u32 body length][body], big-endian', () => {
    const b = encodeFrame({ a: 1 }, Buffer.from([9, 9, 9]));
    expect([...b]).toEqual([0, 0, 0, 7, ...Buffer.from('{"a":1}'), 0, 0, 0, 3, 9, 9, 9]);
  });
  it('a frame split into single bytes still decodes, once, at its last byte', () => {
    const d = new FrameDecoder();
    const bytes = encodeFrame({ type: 'job', id: 1 }, Buffer.from([5, 6, 7, 8]));
    const got = [];
    for (let i = 0; i < bytes.length; i++) {
      const f = d.push(bytes.subarray(i, i + 1));
      if (i < bytes.length - 1) expect(f).toHaveLength(0);
      got.push(...f);
    }
    expect(got).toHaveLength(1);
    expect([...got[0]!.body]).toEqual([5, 6, 7, 8]);
  });
  it('frames coalesced into one chunk, with one cut in the middle of the next, all come out in order', () => {
    const all = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 }, Buffer.from([2, 2])), encodeFrame({ n: 3 }, Buffer.from([3]))]);
    const d = new FrameDecoder();
    const cut = all.length - 5;
    const first = d.push(all.subarray(0, cut));
    expect(first.map((f) => f.header.n)).toEqual([1, 2]);
    expect(d.push(all.subarray(cut)).map((f) => f.header.n)).toEqual([3]);
  });
  it('a large body arriving in many small chunks is intact', () => {
    const body = Buffer.alloc(1_500_000);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const bytes = encodeFrame({ type: 'job' }, body);
    const d = new FrameDecoder();
    const got = [];
    for (let at = 0; at < bytes.length; at += 65_536) got.push(...d.push(bytes.subarray(at, at + 65_536)));
    expect(got).toHaveLength(1);
    expect(got[0]!.body.equals(body)).toBe(true);
  });
  it('a header length over the cap fails at the prefix, without waiting for the data', () => {
    expect(() => new FrameDecoder().push(u32(MAX_HEADER + 1))).toThrow(WireError);
    expect(() => new FrameDecoder().push(u32(0))).toThrow(WireError);
    expect(() => new FrameDecoder().push(u32(0xffffffff))).toThrow(WireError);
  });
  it('a body that would make the frame exceed the cap fails at its length, without waiting for the data', () => {
    const head = Buffer.from('{"a":1}');
    const d = new FrameDecoder();
    expect(() => d.push(Buffer.concat([u32(head.length), head, u32(MAX_FRAME - head.length + 1)]))).toThrow(/too large/);
  });
  it('the cap is the most audio a request carries plus a full header, so the host and the HTTP routes cannot drift', () => {
    expect(MAX_FRAME).toBe(MAX_AUDIO + MAX_HEADER);
    expect(encodeFrame({ type: 'job' }, Buffer.alloc(MAX_AUDIO)).length).toBeLessThanOrEqual(MAX_FRAME + 8);
  });
  it('a frame of exactly the cap is accepted', () => {
    const head = Buffer.from('{"a":1}');
    const body = Buffer.alloc(MAX_FRAME - head.length, 1);
    const got = new FrameDecoder().push(raw({ a: 1 }, body));
    expect(got[0]!.body).toHaveLength(body.length);
  });
  it('encodeFrame refuses what the other end would refuse', () => {
    expect(() => encodeFrame({ a: 1 }, Buffer.alloc(MAX_FRAME))).toThrow(/too large/);
    expect(() => encodeFrame({ a: 'x'.repeat(MAX_HEADER) })).toThrow(/too large/);
  });
  it('a header that is not JSON, or not an object, fails', () => {
    for (const bad of [Buffer.from('{nope'), Buffer.from('[1]'), Buffer.from('null'), Buffer.from('"s"'), Buffer.from('7')]) {
      expect(() => new FrameDecoder().push(Buffer.concat([u32(bad.length), bad, u32(0)]))).toThrow(WireError);
    }
  });
  it('after an error the decoder stays failed, whatever comes next', () => {
    const d = new FrameDecoder();
    expect(() => d.push(u32(0))).toThrow(WireError);
    expect(() => d.push(encodeFrame({ type: 'status' }))).toThrow(WireError);
  });
});

describe('requests', () => {
  it('parses each message the host knows', () => {
    expect(parseRequest({ type: 'hello', proto: 1, version: '1.8.0', client: { pid: 1 } })).toEqual({ type: 'hello', proto: 1 });
    expect(parseRequest({ type: 'status' })).toEqual({ type: 'status' });
    expect(parseRequest({ type: 'job', id: 3, opts: { lang: 'ru', detect: true } })).toEqual({ type: 'job', id: 3, opts: { lang: 'ru', detect: true } });
    expect(parseRequest({ type: 'job', id: 0, opts: { lang: 'yue' } })).toEqual({ type: 'job', id: 0, opts: { lang: 'yue', detect: false } });
    expect(parseRequest({ type: 'cancel', id: 3 })).toEqual({ type: 'cancel', id: 3 });
    expect(parseRequest({ type: 'shutdown', reason: 'removed' })).toEqual({ type: 'shutdown', reason: 'removed' });
    expect(parseRequest({ type: 'shutdown' })).toEqual({ type: 'shutdown', reason: 'shutdown' });
  });
  it('refuses an unknown type and fields it cannot use', () => {
    const bad: Record<string, unknown>[] = [
      {}, { type: 'frobnicate' }, { type: 5 },
      { type: 'hello' }, { type: 'hello', proto: 1.5 }, { type: 'hello', proto: '1' },
      { type: 'job', opts: { lang: 'en' } }, { type: 'job', id: -1, opts: { lang: 'en' } }, { type: 'job', id: 1.5, opts: { lang: 'en' } }, { type: 'job', id: '1', opts: { lang: 'en' } },
      { type: 'job', id: 1 }, { type: 'job', id: 1, opts: null }, { type: 'job', id: 1, opts: { lang: '../x' } }, { type: 'job', id: 1, opts: { lang: 'EN' } },
      { type: 'job', id: 1, opts: { lang: 'en', detect: 'yes' } },
      { type: 'cancel' }, { type: 'cancel', id: 'a' }, { type: 'shutdown', reason: 3 },
    ];
    for (const h of bad) expect(() => parseRequest(h), JSON.stringify(h)).toThrow(WireError);
  });
  it('keeps a shutdown reason short', () => {
    expect(parseRequest({ type: 'shutdown', reason: 'x'.repeat(500) })).toEqual({ type: 'shutdown', reason: 'x'.repeat(64) });
  });
});

describe('PCM', () => {
  it('Int16 little-endian bytes and back, up to rounding', () => {
    const pcm = Float32Array.from([0, 0.5, -0.5, 1 / 32768, -1]);
    const bytes = pcmToInt16(pcm);
    expect([...bytes]).toEqual([0, 0, 0, 0x40, 0, 0xc0, 1, 0, 0, 0x80]);
    expect([...pcmFromInt16(bytes)]).toEqual([...pcm]);
  });
  it('clips what is out of range and takes NaN for silence', () => {
    expect([...pcmFromInt16(pcmToInt16(Float32Array.from([2, -2, NaN])))]).toEqual([32767 / 32768, -1, 0]);
  });
  it('reads a body at an odd offset in its buffer', () => {
    const bytes = pcmToInt16(Float32Array.from([0.25, -0.25]));
    const odd = Buffer.concat([Buffer.from([0xff]), bytes]).subarray(1);
    expect(odd.byteOffset % 2).toBe(1);
    expect([...pcmFromInt16(odd)]).toEqual([0.25, -0.25]);
  });
  it('refuses a body of an odd length', () => {
    expect(() => pcmFromInt16(new Uint8Array(3))).toThrow(WireError);
  });
});

describe('the socket path', () => {
  afterEach(() => vi.unstubAllEnvs());
  // POSIX only (this and the next): Windows has the named pipe below
  it.skipIf(WIN)('names the protocol and the pins, in a folder of its own under the state base', () => {
    vi.stubEnv('NOTA_BENE_HOME', '/tmp/nbw-x');
    expect(hostSocketPath()).toBe(`/tmp/nbw-x/whisper-host/h${HOST_PROTO}-${HOST_PINS}.sock`);
    expect(HOST_PINS).toMatch(/^[0-9a-f]{8}$/);
  });
  it.skipIf(WIN)('throws when it would not fit a unix socket', () => {
    vi.stubEnv('NOTA_BENE_HOME', `/tmp/${'a'.repeat(90)}`);
    expect(() => hostSocketPath()).toThrow(/too long/);
  });
  it.skipIf(!WIN)('Windows: a named pipe that names the home (whatever its spelling), the protocol and the pins', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nbw-'));
    try {
      vi.stubEnv('NOTA_BENE_HOME', home);
      const p = hostSocketPath();
      expect(p.startsWith(String.raw`\\.\pipe\nota-bene-whisper-`)).toBe(true);
      expect(p).toMatch(new RegExp(`-[0-9a-f]{16}-h${HOST_PROTO}-${HOST_PINS}$`));
      expect(isPipePath(p)).toBe(true);
      vi.stubEnv('NOTA_BENE_HOME', `${home.toUpperCase()}\\`);
      expect(hostSocketPath()).toBe(p);
      vi.stubEnv('NOTA_BENE_HOME', `${home}-other`);
      expect(hostSocketPath()).not.toBe(p);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it('a path on disk is not a pipe', () => {
    expect(isPipePath(path.join(os.tmpdir(), 'h.sock'))).toBe(false);
  });
});

describe('the secret handshake of a pipe', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('the secret is made once in the host folder, 64 hex characters, private', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nbw-'));
    try {
      vi.stubEnv('NOTA_BENE_HOME', home);
      const s = hostSecret();
      expect(s).toMatch(/^[0-9a-f]{64}$/);
      expect(hostSecret()).toBe(s);
      const file = path.join(hostDir(), 'host-secret');
      expect(fs.readFileSync(file, 'utf8')).toBe(s);
      if (!WIN) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(hostDir())).toEqual(['host-secret']); // no temp file left
      fs.writeFileSync(file, 'not a secret');
      expect(() => hostSecret()).toThrow(/does not hold a secret/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it('a proof is for one secret, one side and one pair of nonces, and is checked in constant time', () => {
    const secret = 'ab'.repeat(32);
    const [ns, nc] = [newNonce(), newNonce()];
    const p = helloProof(secret, 'window', ns, nc);
    expect(p).toMatch(/^[0-9a-f]{64}$/);
    expect(proofMatches(p, helloProof(secret, 'window', ns, nc))).toBe(true);
    for (const other of [helloProof('cd'.repeat(32), 'window', ns, nc), helloProof(secret, 'host', ns, nc), helloProof(secret, 'window', nc, ns), helloProof(secret, 'window', newNonce(), nc)]) {
      expect(proofMatches(other, p)).toBe(false);
    }
    for (const junk of [undefined, 1, '', 'zz'.repeat(32), p.slice(1), `${p}0`]) expect(proofMatches(junk, p)).toBe(false);
  });
  it('hello may carry a nonce and a proof; a nonce that is not 64 hex characters or a proof that is not a string is bad', () => {
    const nonce = newNonce();
    expect(parseRequest({ type: 'hello', proto: 1, nonce, proof: 'x' })).toEqual({ type: 'hello', proto: 1, nonce, proof: 'x' });
    for (const h of [{ type: 'hello', proto: 1, nonce: 'abc' }, { type: 'hello', proto: 1, nonce: 5 }, { type: 'hello', proto: 1, nonce, proof: 5 }]) {
      expect(() => parseRequest(h), JSON.stringify(h)).toThrow(WireError);
    }
  });
});
