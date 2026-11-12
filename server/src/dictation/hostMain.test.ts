// The Whisper host, for real sockets (unix, in a short /tmp folder: sun_path is ~104 bytes) and a fake model thread.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, MAX_QUEUED_PER_CLIENT, MAX_QUEUED_TOTAL, startHost, WHISPER_IDLE_MS, type Host, type HostOptions } from './hostMain.ts';
import { encodeFrame, FrameDecoder, HOST_PINS, HOST_PROTO, hostSocketPath, MAX_HEADER, pcmToInt16, type Header } from './hostWire.ts';
import type { WorkerData, WorkerFactory, WorkerLike } from './pipelineHost.ts';
import { WHISPER_MODEL, WHISPER_PACKAGE } from './whisper.ts';

type Call = { worker: FakeWorker; id: number; audio: Float32Array; opts?: Record<string, unknown>; detect?: boolean };

/** A model thread that answers when the test says so. */
class FakeWorker extends EventEmitter implements WorkerLike {
  disposed = false;
  terminated = 0;
  private readonly rig: Rig;
  readonly data: WorkerData;
  constructor(rig: Rig, data: WorkerData) {
    super();
    this.rig = rig;
    this.data = data;
    if (rig.autoReady) queueMicrotask(() => this.ready());
  }
  ready(): void { this.emit('message', { type: 'ready' }); }
  postMessage(m: { type?: string; id: number; audio: Float32Array; opts?: Record<string, unknown>; detect?: boolean }): void {
    // pipelineWorker.mjs on {type:'dispose'}: frees the model and exits
    if (m.type === 'dispose') { this.disposed = true; queueMicrotask(() => this.emit('exit', 0)); return; }
    this.rig.calls.push({ worker: this, id: m.id, audio: m.audio, opts: m.opts, detect: m.detect });
    this.rig.changed();
  }
  terminate(): Promise<number> { this.terminated++; return Promise.resolve(0); }
}

class Rig {
  workers: FakeWorker[] = [];
  /** What the model threads were asked, in order, across reloads. */
  calls: Call[] = [];
  autoReady = true;
  private waiting: (() => void)[] = [];
  readonly factory: WorkerFactory = (data) => { const w = new FakeWorker(this, data); this.workers.push(w); return w; };
  changed(): void { for (const f of this.waiting.splice(0)) f(); }
  /** The nth call to a model thread, once it has been made. */
  async call(n: number): Promise<Call> {
    while (this.calls.length <= n) await new Promise<void>((r) => this.waiting.push(r));
    return this.calls[n]!;
  }
  answer(n: number, text: string): void { const c = this.calls[n]!; c.worker.emit('message', { id: c.id, text }); }
  answerProbs(n: number, probs: Record<string, number>): void { const c = this.calls[n]!; c.worker.emit('message', { id: c.id, probs }); }
  /** Which jobs ran, in order: a job's PCM has as many samples as its tag. */
  get ran(): number[] { return this.calls.map((c) => c.audio.length); }
}

/** A window's end of the socket. */
class Conn {
  readonly inbox: Header[] = [];
  ended = false;
  readonly sock: net.Socket;
  private used = new Set<number>();
  private waiting: (() => void)[] = [];
  private constructor(sock: net.Socket) {
    this.sock = sock;
    const decoder = new FrameDecoder();
    sock.on('data', (d: Buffer) => { for (const f of decoder.push(d)) this.inbox.push(f.header); this.wake(); });
    sock.on('close', () => { this.ended = true; this.wake(); });
    sock.on('error', () => {});
  }
  /** Connects and waits until the host has accepted the connection (so the windows are in the order they were opened). */
  static async open(p: string): Promise<Conn> {
    const c = await new Promise<Conn>((resolve, reject) => {
      const s = net.connect(p);
      s.once('connect', () => resolve(new Conn(s)));
      s.once('error', reject);
    });
    await c.status();
    c.inbox.length = 0;
    c.used.clear();
    return c;
  }
  private wake(): void { for (const f of this.waiting.splice(0)) f(); }
  send(header: Header, body?: Uint8Array): void { this.sock.write(encodeFrame(header, body)); }
  /** The first frame not taken yet that matches. */
  async next(match: (h: Header) => boolean = () => true): Promise<Header> {
    for (;;) {
      const i = this.inbox.findIndex((h, k) => !this.used.has(k) && match(h));
      if (i >= 0) { this.used.add(i); return this.inbox[i]!; }
      if (this.ended) throw new Error('the host closed the connection');
      await new Promise<void>((r) => this.waiting.push(r));
    }
  }
  /** A round trip: once it answers, the host has handled every frame sent before it on this connection. */
  async status(): Promise<Header> {
    this.send({ type: 'status' });
    return this.next((h) => h.type === 'status');
  }
  async closed(): Promise<void> { while (!this.ended) await new Promise<void>((r) => this.waiting.push(r)); }
}

const OPTS = { lang: 'en', detect: false };
const job = (id: number, opts: object = OPTS): Header => ({ type: 'job', id, opts });
/** A PCM body of `n` samples. */
const pcm = (n: number): Uint8Array => pcmToInt16(new Float32Array(n).fill(0.25));
/** Waits, without a clock, until something the host does on its own has happened. */
const until = async (cond: () => boolean): Promise<void> => { while (!cond()) await new Promise<void>((r) => setImmediate(r)); };

let tmp: string;
let rig: Rig;
let host: Host | null | undefined;
let conns: Conn[];
let logs: string[];
const socketPath = () => path.join(tmp, 'whisper-host', 'h.sock');

async function start(o: Partial<HostOptions> = {}): Promise<Host> {
  host = await startHost({ socketPath: socketPath(), dir: path.join(tmp, 'whisper'), worker: rig.factory, log: (m) => logs.push(m), ...o });
  if (rig.autoReady) await until(() => host!.status().loaded);
  return host!;
}
async function open(): Promise<Conn> {
  const c = await Conn.open(socketPath());
  conns.push(c);
  return c;
}

beforeEach(() => {
  tmp = fs.mkdtempSync('/tmp/nbw-');
  rig = new Rig();
  conns = [];
  logs = [];
  host = undefined;
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const c of conns) c.sock.destroy();
  await host?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the socket and the handshake', () => {
  it('listens on a socket only its user can use, in a folder only its user can enter', async () => {
    await start();
    expect(fs.statSync(socketPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(socketPath())).mode & 0o777).toBe(0o700);
  });
  it('answers hello with the protocol, the pins, its pid and what it holds', async () => {
    rig.autoReady = false;
    const h = await start();
    const c = await open();
    c.send({ type: 'hello', proto: HOST_PROTO, version: '1.8.0', client: { pid: 1, port: 4777, provider: 'claude' } });
    expect(await c.next()).toEqual({ type: 'hello', proto: HOST_PROTO, pid: process.pid, pins: HOST_PINS, loaded: false, queued: 0 });
    rig.workers[0]!.ready();
    await until(() => h.status().loaded);
    c.send({ type: 'hello', proto: HOST_PROTO });
    expect(await c.next()).toMatchObject({ type: 'hello', loaded: true });
  });
  it('answers hello of another protocol with its own, then closes the connection', async () => {
    const h = await start();
    const c = await open();
    c.send({ type: 'hello', proto: HOST_PROTO + 1 });
    expect(await c.next()).toMatchObject({ type: 'hello', proto: HOST_PROTO });
    await c.closed();
    await until(() => h.status().clients === 0);
  });
  it('status says what is loaded, queued and running, and how many windows are connected', async () => {
    const h = await start();
    const a = await open();
    const b = await open();
    expect(await a.status()).toEqual({ type: 'status', loaded: true, queued: 0, running: false, clients: 2 });
    a.send(job(1), pcm(1));
    a.send(job(2), pcm(2));
    expect(await a.status()).toEqual({ type: 'status', loaded: true, queued: 1, running: true, clients: 2 });
    expect(h.status()).toEqual({ loaded: true, queued: 1, running: true, clients: 2 });
    b.sock.destroy();
    await until(() => h.status().clients === 1);
  });
  it('frames arrive in whatever pieces the socket cuts them: a byte at a time, or two in one write', async () => {
    await start();
    const c = await open();
    const bytes = encodeFrame(job(1), pcm(3));
    for (let i = 0; i < 12; i++) await new Promise<void>((r) => c.sock.write(bytes.subarray(i, i + 1), () => r()));
    c.sock.write(bytes.subarray(12));
    expect((await rig.call(0)).audio).toHaveLength(3);
    rig.answer(0, 'x');
    expect(await c.next()).toMatchObject({ id: 1, text: 'x' });
    c.sock.write(Buffer.concat([encodeFrame({ type: 'status' }), encodeFrame({ type: 'status' })]));
    await c.next((h) => h.type === 'status');
    await c.next((h) => h.type === 'status');
  });
});

describe('jobs', () => {
  it('runs a job in the model thread with the pipeline options and the samples as floats, and answers text and language', async () => {
    await start();
    const c = await open();
    c.send(job(1, { lang: 'ru', detect: false }), pcmToInt16(Float32Array.from([0.5, -0.5, 0.25])));
    const call = await rig.call(0);
    expect(call.opts).toEqual({ language: 'ru', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    expect([...call.audio]).toEqual([0.5, -0.5, 0.25]);
    rig.answer(0, '  hello ');
    expect(await c.next()).toEqual({ id: 1, text: 'hello', lang: 'ru' });
  });
  it('with detect it asks the model for the language first and answers the one it found', async () => {
    await start();
    const c = await open();
    c.send(job(1, { lang: 'en', detect: true }), pcm(20_000));
    expect((await rig.call(0)).detect).toBe(true);
    rig.answerProbs(0, { fr: 0.9, en: 0.1 });
    expect((await rig.call(1)).opts).toMatchObject({ language: 'fr' });
    rig.answer(1, 'bonjour');
    expect(await c.next()).toEqual({ id: 1, text: 'bonjour', lang: 'fr' });
  });
  it('a job the model fails answers `failed` and the next one still runs', async () => {
    await start();
    const c = await open();
    c.send(job(1), pcm(1));
    const first = await rig.call(0);
    first.worker.emit('message', { id: first.id, error: 'bad audio' });
    expect(await c.next()).toEqual({ id: 1, error: 'failed' });
    c.send(job(2), pcm(2));
    await rig.call(1);
    rig.answer(1, 'ok');
    expect(await c.next()).toMatchObject({ id: 2, text: 'ok' });
  });
  it('a transcript too long for a frame is a failed job, not a crashed host', async () => {
    await start();
    const c = await open();
    c.send(job(1), pcm(1));
    await rig.call(0);
    rig.answer(0, 'x'.repeat(MAX_HEADER + 1));
    expect(await c.next()).toEqual({ id: 1, error: 'failed' });
    c.send(job(2), pcm(2));
    await rig.call(1);
    rig.answer(1, 'ok');
    expect(await c.next()).toMatchObject({ id: 2, text: 'ok' });
  });
  it('waits for the model to load, and answers once it has', async () => {
    rig.autoReady = false;
    await start();
    const c = await open();
    c.send(job(1), pcm(1));
    await c.status();
    expect(rig.calls).toHaveLength(0);
    rig.workers[0]!.ready();
    await rig.call(0);
    rig.answer(0, 'x');
    expect(await c.next()).toMatchObject({ id: 1, text: 'x' });
  });
});

describe('the queue', () => {
  it('serves the windows in turn: one job of each, then the next of each', async () => {
    rig.autoReady = false;
    await start();
    const a = await open();
    const b = await open();
    for (const n of [1, 2, 3]) a.send(job(n), pcm(n));
    for (const n of [11, 12]) b.send(job(n), pcm(n));
    await a.status();
    await b.status();
    rig.workers[0]!.ready();
    for (let i = 0; i < 5; i++) { await rig.call(i); rig.answer(i, 'x'); }
    expect(rig.ran).toEqual([1, 11, 2, 12, 3]);
    for (const n of [1, 2, 3]) expect(await a.next()).toMatchObject({ id: n, text: 'x' });
    for (const n of [11, 12]) expect(await b.next()).toMatchObject({ id: n, text: 'x' });
  });
  it('a window that comes while another one has a backlog gets the very next turn', async () => {
    await start();
    const a = await open();
    const b = await open();
    a.send(job(1), pcm(1));
    await rig.call(0);
    a.send(job(2), pcm(2));
    a.send(job(3), pcm(3));
    await a.status();
    b.send(job(11), pcm(11));
    await b.status();
    for (let i = 0; i < 4; i++) { await rig.call(i); rig.answer(i, 'x'); }
    expect(rig.ran).toEqual([1, 11, 2, 3]);
  });
  it('one window\'s jobs run in the order it sent them', async () => {
    rig.autoReady = false;
    await start();
    const a = await open();
    for (const n of [5, 3, 9, 1]) a.send(job(n), pcm(n));
    await a.status();
    rig.workers[0]!.ready();
    for (let i = 0; i < 4; i++) { await rig.call(i); rig.answer(i, 'x'); }
    expect(rig.ran).toEqual([5, 3, 9, 1]);
  });
  it('a window over its limit of waiting jobs gets `busy` for the next one, other windows are not affected', async () => {
    rig.autoReady = false;
    await start();
    const a = await open();
    const b = await open();
    for (let n = 1; n <= MAX_QUEUED_PER_CLIENT; n++) a.send(job(n), pcm(1));
    a.send(job(100), pcm(1));
    expect(await a.next()).toEqual({ id: 100, error: 'busy' });
    expect(await a.status()).toMatchObject({ queued: MAX_QUEUED_PER_CLIENT });
    b.send(job(1), pcm(1));
    await b.status();
    expect(b.inbox).toHaveLength(1); // the status: no `busy`
  });
  it('the running job is not counted as waiting', async () => {
    await start();
    const a = await open();
    for (let n = 1; n <= MAX_QUEUED_PER_CLIENT + 2; n++) a.send(job(n), pcm(1));
    expect(await a.next()).toEqual({ id: MAX_QUEUED_PER_CLIENT + 2, error: 'busy' });
    expect(await a.status()).toMatchObject({ queued: MAX_QUEUED_PER_CLIENT, running: true });
  });
  it('over the total of waiting jobs, even a window with none waiting gets `busy`', async () => {
    rig.autoReady = false;
    await start();
    const full = [];
    for (let i = 0; i < MAX_QUEUED_TOTAL / MAX_QUEUED_PER_CLIENT; i++) {
      const c = await open();
      for (let n = 1; n <= MAX_QUEUED_PER_CLIENT; n++) c.send(job(n), pcm(1));
      full.push(c);
    }
    for (const c of full) await c.status();
    const late = await open();
    late.send(job(1), pcm(1));
    expect(await late.next()).toEqual({ id: 1, error: 'busy' });
    expect(await late.status()).toMatchObject({ queued: MAX_QUEUED_TOTAL });
  });
});

describe('cancel and disconnect', () => {
  it('cancelling a queued job answers `cancelled`, and the job never reaches the model; its id may be used again', async () => {
    rig.autoReady = false;
    await start();
    const c = await open();
    c.send(job(1), pcm(1));
    c.send(job(2), pcm(2));
    c.send({ type: 'cancel', id: 1 });
    expect(await c.next()).toEqual({ id: 1, error: 'cancelled' });
    expect(await c.status()).toMatchObject({ queued: 1 });
    c.send(job(1), pcm(3));
    await c.status();
    rig.workers[0]!.ready();
    for (let i = 0; i < 2; i++) { await rig.call(i); rig.answer(i, 'x'); }
    expect(rig.ran).toEqual([2, 3]);
  });
  it('cancelling an id that is not there (it just finished) is nothing', async () => {
    await start();
    const c = await open();
    c.send({ type: 'cancel', id: 99 });
    await c.status();
    expect(c.inbox).toHaveLength(1);
    expect(c.ended).toBe(false);
  });
  it('a running job cannot be interrupted: cancelling answers at once, the model finishes, the result is dropped', async () => {
    const h = await start();
    const c = await open();
    c.send(job(1), pcm(1));
    await rig.call(0);
    c.send({ type: 'cancel', id: 1 });
    expect(await c.next()).toEqual({ id: 1, error: 'cancelled' });
    c.send(job(2), pcm(2));
    expect(await c.status()).toMatchObject({ queued: 1, running: true }); // the model is still on job 1
    expect(rig.calls).toHaveLength(1);
    rig.answer(0, 'late');
    await rig.call(1);
    rig.answer(1, 'second');
    expect(await c.next((m) => m.id === 2)).toEqual({ id: 2, text: 'second', lang: 'en' });
    expect(c.inbox.filter((m) => m.id === 1)).toHaveLength(1); // the cancelled answer only
    expect(c.inbox.some((m) => m.text === 'late')).toBe(false);
    expect(h.status().running).toBe(false);
  });
  it('a window that disconnects loses its waiting jobs, the others keep theirs', async () => {
    rig.autoReady = false;
    const h = await start();
    const a = await open();
    const b = await open();
    a.send(job(1), pcm(1));
    a.send(job(2), pcm(2));
    b.send(job(11), pcm(11));
    await a.status();
    await b.status();
    a.sock.destroy();
    await until(() => h.status().clients === 1);
    expect(h.status().queued).toBe(1);
    rig.workers[0]!.ready();
    await rig.call(0);
    rig.answer(0, 'x');
    expect(await b.next()).toMatchObject({ id: 11, text: 'x' });
    expect(rig.ran).toEqual([11]);
  });
  it('a window that disconnects while its job runs: the result is dropped and the next window\'s job runs', async () => {
    const h = await start();
    const a = await open();
    const b = await open();
    a.send(job(1), pcm(1));
    await rig.call(0);
    b.send(job(11), pcm(11));
    await b.status();
    a.sock.destroy();
    await until(() => h.status().clients === 1);
    rig.answer(0, 'nobody listens');
    await rig.call(1);
    rig.answer(1, 'x');
    expect(await b.next()).toMatchObject({ id: 11, text: 'x' });
    expect(rig.ran).toEqual([1, 11]);
  });
});

describe('a connection that breaks the protocol is ended', () => {
  const header = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const cases: [string, (c: Conn) => void][] = [
    ['an unknown message type', (c) => c.send({ type: 'frobnicate' })],
    ['a header that is not JSON', (c) => c.sock.write(Buffer.concat([header(5), Buffer.from('{nope'), header(0)]))],
    ['a header over the cap', (c) => c.sock.write(header(MAX_HEADER + 1))],
    ['a frame over the cap', (c) => c.sock.write(Buffer.concat([header(2), Buffer.from('{}'), header(0x7fffffff)]))],
    ['a job without a valid id', (c) => c.send({ type: 'job', opts: OPTS }, pcm(1))],
    ['a job with a language that is not a code', (c) => c.send(job(1, { lang: '../etc', detect: false }), pcm(1))],
    ['a PCM body of an odd length', (c) => c.send(job(1), new Uint8Array(3))],
    ['a body on a message that is not a job', (c) => c.send({ type: 'status' }, pcm(1))],
    ['a job id that is still in use', (c) => { c.send(job(1), pcm(1)); c.send(job(1), pcm(1)); }],
  ];
  it.each(cases)('%s', async (_name, misbehave) => {
    rig.autoReady = false; // so that a job's id stays in use
    const h = await start();
    const good = await open();
    const bad = await open();
    misbehave(bad);
    await bad.closed();
    await until(() => h.status().clients === 1);
    expect(h.status().queued).toBe(0); // what the bad window had queued went with it
    expect(await good.status()).toMatchObject({ clients: 1 });
  });
});

describe('shutdown', () => {
  it('fails the queued and the running jobs `off`, closes every connection, disposes the model and removes the socket', async () => {
    const h = await start();
    const a = await open();
    const b = await open();
    a.send(job(1), pcm(1));
    await rig.call(0);
    a.send(job(2), pcm(2));
    b.send(job(11), pcm(11));
    await a.status();
    await b.status();
    a.send({ type: 'shutdown', reason: 'removed' });
    expect(await h.done).toBe(0);
    await a.closed();
    await b.closed();
    expect(a.inbox.filter((m) => 'error' in m).sort((x, y) => (x.id as number) - (y.id as number))).toEqual([{ id: 1, error: 'off' }, { id: 2, error: 'off' }]);
    expect(b.inbox.filter((m) => 'error' in m)).toEqual([{ id: 11, error: 'off' }]);
    expect(rig.workers[0]!.disposed).toBe(true);
    expect(fs.existsSync(socketPath())).toBe(false);
    expect(rig.calls).toHaveLength(1); // the queued jobs never ran
  });
  it('while the model is still loading it ends the model thread', async () => {
    rig.autoReady = false;
    const h = await start();
    const c = await open();
    c.send(job(1), pcm(1));
    await c.status();
    c.send({ type: 'shutdown' });
    expect(await h.done).toBe(0);
    expect(await c.next((m) => m.id === 1)).toEqual({ id: 1, error: 'off' });
    expect(rig.workers[0]!.terminated).toBeGreaterThan(0);
  });
  it('stop() does the same from inside, and twice is once', async () => {
    const h = await start();
    const c = await open();
    expect(await Promise.all([h.stop('test'), h.stop('again')])).toEqual([0, 0]);
    await c.closed();
    expect(fs.existsSync(socketPath())).toBe(false);
  });
});

describe('the model', () => {
  it('a model that fails to load fails every waiting job and stops the host with exit code 1', async () => {
    rig.autoReady = false;
    const h = await start();
    const a = await open();
    const b = await open();
    a.send(job(1), pcm(1));
    b.send(job(2), pcm(1));
    await a.status();
    await b.status();
    rig.workers[0]!.emit('message', { type: 'error', message: 'no model' });
    expect(await h.done).toBe(1);
    expect(await a.next((m) => m.id === 1)).toEqual({ id: 1, error: 'failed' });
    expect(await b.next((m) => m.id === 2)).toEqual({ id: 2, error: 'failed' });
    await a.closed();
    expect(fs.existsSync(socketPath())).toBe(false);
    expect(logs.some((m) => m.includes('no model'))).toBe(true);
  });
  it('a dead model thread fails the job it was on and is reloaded for the next one; a later death is reloaded again', async () => {
    const h = await start();
    const c = await open();
    c.send(job(1), pcm(1));
    await rig.call(0);
    rig.workers[0]!.emit('exit', 1);
    expect(await c.next()).toEqual({ id: 1, error: 'failed' });
    c.send(job(2), pcm(2));
    await rig.call(1);
    expect(rig.workers).toHaveLength(2);
    rig.answer(1, 'ok');
    expect(await c.next()).toMatchObject({ id: 2, text: 'ok' });
    c.send(job(3), pcm(3));
    await rig.call(2);
    rig.workers[1]!.emit('exit', 1);
    expect(await c.next()).toEqual({ id: 3, error: 'failed' });
    c.send(job(4), pcm(4));
    await rig.call(3);
    expect(rig.workers).toHaveLength(3);
    rig.answer(3, 'again');
    expect(await c.next()).toMatchObject({ id: 4, text: 'again' });
    expect(h.status().loaded).toBe(true);
  });
  it('a model thread that dies again without a job done in between stops the host with exit code 1', async () => {
    const h = await start();
    const c = await open();
    c.send(job(1), pcm(1));
    await rig.call(0);
    rig.workers[0]!.emit('exit', 1);
    expect(await c.next()).toEqual({ id: 1, error: 'failed' });
    c.send(job(2), pcm(2));
    await rig.call(1);
    rig.workers[1]!.emit('exit', 1);
    expect(await c.next((m) => m.id === 2)).toEqual({ id: 2, error: 'failed' });
    c.send(job(3), pcm(3));
    expect(await c.next((m) => m.id === 3)).toEqual({ id: 3, error: 'failed' });
    expect(await h.done).toBe(1);
    expect(rig.workers).toHaveLength(2); // no third load
  });
});

describe('one host per socket', () => {
  it('a second host on a socket that is answering serves nothing and leaves the first alone', async () => {
    const first = await start();
    const second = await startHost({ socketPath: socketPath(), dir: path.join(tmp, 'whisper'), worker: rig.factory });
    expect(second).toBeNull();
    expect(rig.workers).toHaveLength(1); // no second model
    const c = await open();
    expect(await c.status()).toMatchObject({ loaded: true });
    await until(() => first.status().clients === 1); // the second host's probe has gone
  });
  it('a stale socket file, with nobody answering, is replaced', async () => {
    fs.mkdirSync(path.dirname(socketPath()), { recursive: true });
    fs.writeFileSync(socketPath(), '');
    await start();
    const c = await open();
    expect(await c.status()).toMatchObject({ loaded: true });
  });
});

describe('idle', () => {
  /** Only the timers the host sets are faked: the sockets run for real. */
  const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  it('is ten minutes, and the host\'s own default', () => {
    expect(WHISPER_IDLE_MS).toBe(10 * 60_000);
  });
  it('a host with nothing to do unloads the model and stops after the idle time, to the millisecond', async () => {
    fakeClock();
    const h = await start({ idleMs: 5000 });
    const c = await open();
    vi.advanceTimersByTime(4999);
    expect(await c.status()).toMatchObject({ loaded: true }); // connections are not work
    vi.advanceTimersByTime(1);
    expect(await h.done).toBe(0);
    expect(rig.workers[0]!.disposed).toBe(true);
    await c.closed();
    expect(fs.existsSync(socketPath())).toBe(false);
  });
  it('the clock starts again when a job is done, and does not run while one is running', async () => {
    fakeClock();
    const h = await start({ idleMs: 5000 });
    const c = await open();
    vi.advanceTimersByTime(4000);
    c.send(job(1), pcm(1));
    await rig.call(0);
    vi.advanceTimersByTime(60 * 5000); // a long job
    expect(await c.status()).toMatchObject({ running: true });
    rig.answer(0, 'x');
    expect(await c.next()).toMatchObject({ id: 1, text: 'x' });
    vi.advanceTimersByTime(4999);
    expect(await c.status()).toMatchObject({ loaded: true, running: false });
    vi.advanceTimersByTime(1);
    expect(await h.done).toBe(0);
  });
  it('does not run while jobs wait for the model', async () => {
    fakeClock();
    rig.autoReady = false;
    const h = await start({ idleMs: 5000 });
    const c = await open();
    c.send(job(1), pcm(1));
    await c.status();
    vi.advanceTimersByTime(10 * 5000);
    expect(await c.status()).toMatchObject({ queued: 1 });
    c.send({ type: 'cancel', id: 1 }); // nothing left to do: the clock starts
    expect(await c.next((m) => m.id === 1)).toEqual({ id: 1, error: 'cancelled' });
    vi.advanceTimersByTime(5000);
    expect(await h.done).toBe(0);
    expect(rig.workers[0]!.terminated).toBeGreaterThan(0);
  });
  it('a window that leaves with its job waiting starts the clock too', async () => {
    fakeClock();
    rig.autoReady = false;
    const h = await start({ idleMs: 5000 });
    const c = await open();
    c.send(job(1), pcm(1));
    await c.status();
    c.sock.destroy();
    await until(() => h.status().clients === 0);
    vi.advanceTimersByTime(5000);
    expect(await h.done).toBe(0);
  });
});

describe('the process entry, with the real model thread', () => {
  /** An install whose package answers `task|model|samples|language`, in place of transformers.js. */
  const fakeInstall = (): void => {
    const pkg = path.join(tmp, 'whisper', 'node_modules', ...WHISPER_PACKAGE.split('/'));
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: WHISPER_PACKAGE, version: '0.0.0', type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(pkg, 'index.js'), `export const env = {};
export const pipeline = async (task, model) => async (audio, opts) => ({ text: [task, model, audio.length, opts.language].join('|') });`);
  };
  beforeEach(() => {
    vi.stubEnv('NOTA_BENE_HOME', tmp);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fakeInstall();
  });

  it('serves on the host socket of the state base, runs a job in a real thread, and exits 0 on shutdown; a second one finds the socket taken', async () => {
    const exit = main({});
    try {
      await until(() => fs.existsSync(hostSocketPath()));
      expect(await main({})).toBe(0); // another host answers: nothing to do
      const c = await Conn.open(hostSocketPath());
      conns.push(c);
      c.send(job(1, { lang: 'ru', detect: false }), pcm(5));
      expect(await c.next((m) => m.id === 1)).toEqual({ id: 1, text: `automatic-speech-recognition|${WHISPER_MODEL}|5|ru`, lang: 'ru' });
      c.send({ type: 'shutdown', reason: 'removed' });
      expect(await exit).toBe(0);
      expect(fs.existsSync(hostSocketPath())).toBe(false);
    } finally {
      if (fs.existsSync(hostSocketPath())) { // a failed test must not leave a host running
        const c = await Conn.open(hostSocketPath());
        c.send({ type: 'shutdown' });
        await exit;
      }
    }
  });
  it('run as a script (what the window side spawns) it serves, and exits 0 on SIGTERM, its socket removed', async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./hostMain.ts', import.meta.url))], { env: { PATH: process.env.PATH, NOTA_BENE_HOME: tmp }, stdio: ['ignore', 'ignore', 'pipe'] });
    let gone = false;
    let log = '';
    child.stderr.on('data', (d: Buffer) => { log += d.toString(); });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => { gone = true; resolve(code); }));
    try {
      await until(() => gone || log.includes('listening on')); // the socket is bound and listening, not just there
      expect(gone, log).toBe(false);
      const c = await Conn.open(hostSocketPath());
      conns.push(c);
      c.send(job(1), pcm(2));
      expect(await c.next((m) => m.id === 1)).toMatchObject({ id: 1, text: expect.stringMatching(/\|2\|en$/) });
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(fs.existsSync(hostSocketPath())).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });
  it('NOTA_BENE_TEST_WHISPER_IDLE_MS shortens the idle time', async () => {
    expect(await main({ NOTA_BENE_TEST_WHISPER_IDLE_MS: '1' })).toBe(0);
    expect(fs.existsSync(hostSocketPath())).toBe(false);
  });
});
