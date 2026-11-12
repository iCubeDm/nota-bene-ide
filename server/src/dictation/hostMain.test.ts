// The Whisper host, for real sockets (unix, in a short /tmp folder: sun_path is ~104 bytes) and a fake model thread.
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_DEADLINE_MIN_MS, jobDeadlineMs, LOAD_DEADLINE_MS, main, MAX_CLIENTS, MAX_QUEUED_BYTES, MAX_QUEUED_PER_CLIENT, MAX_QUEUED_TOTAL, startHost, WHISPER_IDLE_MS, type Host, type HostOptions } from './hostMain.ts';
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
    // pipelineWorker.mjs on {type:'dispose'}: frees the model and exits (a stuck thread does not even see it)
    if (m.type === 'dispose') {
      if (this.rig.throwOnDispose) throw new Error('the port is closed');
      this.disposed = true;
      if (!this.rig.stuck) queueMicrotask(() => this.emit('exit', 0));
      return;
    }
    this.rig.calls.push({ worker: this, id: m.id, audio: m.audio, opts: m.opts, detect: m.detect });
    this.rig.changed();
  }
  terminate(): Promise<number> {
    this.terminated++;
    if (!this.rig.stuck) queueMicrotask(() => this.emit('exit', 1));
    return this.rig.stuck ? new Promise(() => {}) : Promise.resolve(1);
  }
}

class Rig {
  workers: FakeWorker[] = [];
  /** What the model threads were asked, in order, across reloads. */
  calls: Call[] = [];
  autoReady = true;
  /** The thread is stuck in native code: it neither exits on `dispose` nor can be terminated. */
  stuck = false;
  throwOnDispose = false;
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
/** Hosts a test started besides `host`: stopped in afterEach. */
let extra: Host[];
let conns: Conn[];
let logs: string[];
const socketPath = () => path.join(tmp, 'whisper-host', 'h.sock');

async function start(o: Partial<HostOptions> = {}): Promise<Host> {
  host = await startHost({ socketPath: socketPath(), dir: path.join(tmp, 'whisper'), worker: rig.factory, log: (m) => logs.push(m), ...o });
  return host!;
}
/** Another host on the same socket (it may win it, or find it taken). */
async function startMore(): Promise<Host | null> {
  const h = await startHost({ socketPath: socketPath(), dir: path.join(tmp, 'whisper'), worker: rig.factory, log: (m) => logs.push(m) });
  if (h) extra.push(h);
  return h;
}
/** Runs the fake clock down until `p` settles: the stop's steps take turns of the event loop, its grace timers take fake time. */
async function runDown(p: Promise<unknown>): Promise<void> {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 100 && !settled; i++) {
    await new Promise<void>((r) => setImmediate(r));
    vi.advanceTimersByTime(1000);
  }
  expect(settled, 'the stop did not finish').toBe(true);
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
  extra = [];
  logs = [];
  host = undefined;
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const c of conns) c.sock.destroy();
  await host?.stop();
  for (const h of extra) await h.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the socket and the handshake', () => {
  it('listens on a socket only its user can use, in a folder only its user can enter', async () => {
    await start();
    expect(fs.statSync(socketPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(socketPath())).mode & 0o777).toBe(0o700);
  });
  it('tightens a folder that already exists', async () => {
    fs.mkdirSync(path.dirname(socketPath()), { mode: 0o755 });
    fs.chmodSync(path.dirname(socketPath()), 0o755);
    await start();
    expect(fs.statSync(path.dirname(socketPath())).mode & 0o777).toBe(0o700);
  });
  it('refuses a folder that belongs to another user', async () => {
    fs.mkdirSync(path.dirname(socketPath()));
    vi.spyOn(process, 'getuid').mockReturnValue((process.getuid!() + 1));
    await expect(startHost({ socketPath: socketPath(), dir: path.join(tmp, 'whisper'), worker: rig.factory })).rejects.toThrow(/belongs to another user/);
    expect(fs.readdirSync(path.dirname(socketPath()))).toEqual([]);
  });
  it('loads no model until the first job', async () => {
    rig.autoReady = false;
    const h = await start();
    const c = await open();
    expect(rig.workers).toHaveLength(0);
    c.send({ type: 'hello', proto: HOST_PROTO, version: '1.8.0', client: { pid: 1, port: 4777, provider: 'claude' } });
    expect(await c.next()).toEqual({ type: 'hello', proto: HOST_PROTO, pid: process.pid, pins: HOST_PINS, loaded: false, queued: 0 });
    c.send(job(1), pcm(1));
    await c.status();
    expect(rig.workers).toHaveLength(1);
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
  it('frames pipelined behind a hello of another protocol are not served', async () => {
    const h = await start();
    const c = await open();
    c.sock.write(Buffer.concat([encodeFrame({ type: 'hello', proto: HOST_PROTO + 1 }), encodeFrame(job(1), pcm(1))]));
    await c.closed();
    await until(() => h.status().clients === 0);
    expect(h.status().queued).toBe(0);
    expect(rig.workers).toHaveLength(0); // the job never made it to the queue, so nothing loaded a model for it
  });
  it('status says what is loaded, queued and running, and how many windows are connected', async () => {
    const h = await start();
    const a = await open();
    const b = await open();
    expect(await a.status()).toEqual({ type: 'status', loaded: false, queued: 0, running: false, clients: 2 });
    a.send(job(1), pcm(1));
    await rig.call(0);
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
  it('a window that comes while another one has a backlog gets the very next turn, not the one after its next job', async () => {
    await start();
    const a = await open();
    a.send(job(1), pcm(1));
    await rig.call(0);
    const b = await open(); // after A's first job was taken: A was the window served last
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
    a.send(job(1), pcm(1));
    await rig.call(0);
    for (let n = 2; n <= MAX_QUEUED_PER_CLIENT + 2; n++) a.send(job(n), pcm(1));
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

describe('a cancel is the sender\'s own', () => {
  it('another window\'s running job with the same id is not cancelled, nor is its queued one', async () => {
    await start();
    const a = await open();
    const b = await open();
    a.send(job(1), pcm(1)); // A's job 1 runs
    await rig.call(0);
    b.send({ type: 'cancel', id: 1 }); // B has no job 1
    await b.status();
    expect(b.inbox).toHaveLength(1); // the status only
    b.send(job(1), pcm(11)); // B's own job 1 waits behind A's
    await b.status();
    b.send({ type: 'cancel', id: 1 });
    expect(await b.next((m) => m.id === 1)).toEqual({ id: 1, error: 'cancelled' }); // B's, the queued one
    rig.answer(0, 'x');
    expect(await a.next()).toMatchObject({ id: 1, text: 'x' }); // A's was not touched
    expect(a.inbox).toHaveLength(1);
    expect(rig.ran).toEqual([1]);
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
    const a = await open();
    a.send(job(1), pcm(1));
    await rig.call(0);
    expect(await startMore()).toBeNull();
    expect(rig.workers).toHaveLength(1); // no second model
    expect(fs.readdirSync(path.dirname(socketPath()))).toEqual(['h.sock']); // and no name left behind
    const c = await open();
    expect(await c.status()).toMatchObject({ loaded: true });
    await until(() => first.status().clients === 2); // the second host's probe has gone
  });
  it('a stale socket file, with nobody answering, is replaced', async () => {
    fs.mkdirSync(path.dirname(socketPath()), { recursive: true });
    fs.writeFileSync(socketPath(), '');
    await start();
    const c = await open();
    expect(await c.status()).toMatchObject({ clients: 1 });
    expect(fs.readdirSync(path.dirname(socketPath()))).toEqual(['h.sock']);
  });
  it('hosts that race over a stale socket file: one is reachable, and stopping the others leaves its socket in place', async () => {
    fs.mkdirSync(path.dirname(socketPath()), { recursive: true });
    fs.writeFileSync(socketPath(), '');
    const racing = (await Promise.all([startMore(), startMore(), startMore()])).filter((h): h is Host => h !== null);
    expect(racing.length).toBeGreaterThan(0);
    const c = await open();
    await c.status();
    const reached = racing.filter((h) => h.status().clients === 1);
    expect(reached).toHaveLength(1);
    await Promise.all(racing.filter((h) => h !== reached[0]).map((h) => h.stop()));
    const again = await open(); // the name still leads to the host that was reached
    expect(await again.status()).toMatchObject({ clients: 2 });
    expect(reached[0]!.status().clients).toBe(2);
  });
  it('a host whose socket was replaced by another one\'s does not remove that one when it stops', async () => {
    const first = await start();
    fs.rmSync(socketPath()); // what a racing host recovering a "stale" file does to the host that just bound it
    const second = await startMore();
    expect(second).not.toBeNull();
    expect(await first.stop()).toBe(0);
    const c = await open();
    expect(await c.status()).toMatchObject({ clients: 1 });
    expect(second!.status().clients).toBe(1);
  });
  it('a host that cannot publish its socket closes what it opened and leaves nothing behind', async () => {
    fs.mkdirSync(socketPath(), { recursive: true }); // a folder where the socket should go
    await expect(startHost({ socketPath: socketPath(), dir: path.join(tmp, 'whisper'), worker: rig.factory })).rejects.toThrow();
    expect(fs.readdirSync(path.dirname(socketPath()))).toEqual(['h.sock']);
  });
});

describe('idle', () => {
  /** Only the timers the host sets are faked: the sockets run for real. */
  const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  it('is ten minutes, and the host\'s own default', () => {
    expect(WHISPER_IDLE_MS).toBe(10 * 60_000);
  });
  it('a host that never got a job holds no model and stops after the idle time, to the millisecond', async () => {
    fakeClock();
    const h = await start({ idleMs: 5000 });
    const c = await open();
    vi.advanceTimersByTime(4999);
    expect(await c.status()).toMatchObject({ loaded: false }); // connections are not work
    vi.advanceTimersByTime(1);
    expect(await h.done).toBe(0);
    expect(rig.workers).toHaveLength(0);
    await c.closed();
    expect(fs.existsSync(socketPath())).toBe(false);
  });
  it('the clock starts again when a job is done, does not run while one is running, and then unloads the model', async () => {
    fakeClock();
    const h = await start({ idleMs: 5000 });
    const c = await open();
    vi.advanceTimersByTime(4000);
    c.send(job(1), pcm(1));
    await rig.call(0);
    vi.advanceTimersByTime(60 * 1000); // a long job (under its deadline)
    expect(await c.status()).toMatchObject({ running: true });
    rig.answer(0, 'x');
    expect(await c.next()).toMatchObject({ id: 1, text: 'x' });
    vi.advanceTimersByTime(4999);
    expect(await c.status()).toMatchObject({ loaded: true, running: false });
    vi.advanceTimersByTime(1);
    expect(await h.done).toBe(0);
    expect(rig.workers[0]!.disposed).toBe(true);
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
  it('the clock starts when the model finishes a job that its window cancelled, with nothing else queued', async () => {
    fakeClock();
    const h = await start({ idleMs: 5000 });
    const c = await open();
    c.send(job(1), pcm(1));
    await rig.call(0);
    c.send({ type: 'cancel', id: 1 });
    expect(await c.next((m) => m.id === 1)).toEqual({ id: 1, error: 'cancelled' });
    vi.advanceTimersByTime(60 * 1000); // the model is still on it
    expect(h.status().running).toBe(true);
    rig.answer(0, 'late');
    await until(() => !h.status().running);
    vi.advanceTimersByTime(4999);
    expect(await c.status()).toMatchObject({ running: false });
    vi.advanceTimersByTime(1);
    expect(await h.done).toBe(0);
  });
  it('the clock starts when the model finishes a job whose window left, with nothing else queued', async () => {
    fakeClock();
    const h = await start({ idleMs: 5000 });
    const c = await open();
    c.send(job(1), pcm(1));
    await rig.call(0);
    c.sock.destroy();
    await until(() => h.status().clients === 0);
    vi.advanceTimersByTime(60 * 1000);
    expect(h.status().running).toBe(true);
    rig.answer(0, 'nobody listens');
    await until(() => !h.status().running);
    vi.advanceTimersByTime(5000);
    expect(await h.done).toBe(0);
  });
});

describe('a model that does not answer', () => {
  const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  it('a call has 2 minutes, or 10 times the audio\'s length when that is more', () => {
    expect(jobDeadlineMs(16_000)).toBe(JOB_DEADLINE_MIN_MS);
    expect(jobDeadlineMs(16_000 * 12)).toBe(JOB_DEADLINE_MIN_MS);
    expect(jobDeadlineMs(16_000 * 20)).toBe(200_000);
    expect(jobDeadlineMs(16_000 * 60)).toBe(600_000);
  });
  it('a call past its deadline fails its job and stops the host, whose windows see the connection close and start again', async () => {
    fakeClock();
    const h = await start();
    const a = await open();
    const b = await open();
    a.send(job(1), pcm(1));
    await rig.call(0);
    b.send(job(11), pcm(11));
    await b.status();
    vi.advanceTimersByTime(JOB_DEADLINE_MIN_MS - 1);
    expect(await a.status()).toMatchObject({ running: true });
    vi.advanceTimersByTime(1);
    expect(await a.next((m) => m.id === 1)).toEqual({ id: 1, error: 'failed' });
    expect(await h.done).toBe(1);
    await b.closed();
    expect(b.inbox.some((m) => m.id === 11)).toBe(false); // not failed: retryable on a new host
    expect(fs.existsSync(socketPath())).toBe(false);
    expect(h.wedged()).toBe(false);
    expect(logs.some((m) => m.includes('deadline'))).toBe(true);
  });
  it('the deadline follows the audio: 20 seconds of it is 200 seconds', async () => {
    fakeClock();
    const h = await start();
    const a = await open();
    a.send(job(1), pcm(16_000 * 20));
    await rig.call(0);
    vi.advanceTimersByTime(199_999);
    expect(await a.status()).toMatchObject({ running: true });
    vi.advanceTimersByTime(1);
    expect(await a.next((m) => m.id === 1)).toEqual({ id: 1, error: 'failed' });
    expect(await h.done).toBe(1);
  });
  it('a call that returns in time cancels its deadline', async () => {
    fakeClock();
    const h = await start();
    const a = await open();
    a.send(job(1), pcm(1));
    await rig.call(0);
    vi.advanceTimersByTime(JOB_DEADLINE_MIN_MS - 1);
    rig.answer(0, 'x');
    expect(await a.next((m) => m.id === 1)).toMatchObject({ id: 1, text: 'x' });
    expect(vi.getTimerCount()).toBe(1); // the idle clock; the deadline is gone, not just harmless
    vi.advanceTimersByTime(JOB_DEADLINE_MIN_MS * 2);
    expect(await a.status()).toMatchObject({ loaded: true, running: false });
    expect(h.status().loaded).toBe(true);
  });
  it('a thread that does not exit is reported as wedged once the host has stopped', async () => {
    fakeClock();
    const h = await start();
    const a = await open();
    a.send(job(1), pcm(1));
    await rig.call(0);
    rig.stuck = true; // from now on the thread neither exits on dispose nor can be terminated
    vi.advanceTimersByTime(JOB_DEADLINE_MIN_MS);
    await runDown(h.done);
    expect(await h.done).toBe(1);
    expect(h.wedged()).toBe(true);
    expect(await a.next((m) => m.id === 1)).toEqual({ id: 1, error: 'failed' });
  });
  it('a model load past its deadline fails the waiting jobs and stops the host', async () => {
    fakeClock();
    rig.autoReady = false;
    const h = await start();
    const a = await open();
    a.send(job(1), pcm(1));
    await a.status();
    vi.advanceTimersByTime(LOAD_DEADLINE_MS - 1);
    expect(await a.status()).toMatchObject({ queued: 1 });
    vi.advanceTimersByTime(1);
    expect(await a.next((m) => m.id === 1)).toEqual({ id: 1, error: 'failed' });
    expect(await h.done).toBe(1);
    expect(rig.workers[0]!.terminated).toBeGreaterThan(0);
  });
  it('a load that finishes in time cancels its deadline', async () => {
    fakeClock();
    rig.autoReady = false;
    const h = await start();
    const a = await open();
    a.send(job(1), pcm(1));
    await a.status();
    vi.advanceTimersByTime(LOAD_DEADLINE_MS - 1);
    rig.workers[0]!.ready();
    await rig.call(0);
    rig.answer(0, 'x');
    expect(await a.next((m) => m.id === 1)).toMatchObject({ id: 1, text: 'x' });
    expect(vi.getTimerCount()).toBe(1); // the idle clock; the load's deadline is gone
    vi.advanceTimersByTime(LOAD_DEADLINE_MS); // it would have passed long ago
    expect(await a.status()).toMatchObject({ loaded: true });
    expect(h.status().loaded).toBe(true);
  });
});

describe('limits on what a window can make the host hold', () => {
  it('PCM waiting across all windows is capped: past it a job is answered `busy`, and what is freed is usable again', async () => {
    rig.autoReady = false;
    await start();
    const a = await open();
    const b = await open();
    const big = pcm(4_000_000); // 8 MB; eight of them are under the cap
    expect(8 * big.length).toBeLessThanOrEqual(MAX_QUEUED_BYTES);
    expect(9 * big.length).toBeGreaterThan(MAX_QUEUED_BYTES);
    for (let n = 1; n <= 5; n++) a.send(job(n), big);
    for (let n = 1; n <= 3; n++) b.send(job(n), big);
    await a.status();
    await b.status();
    b.send(job(9), big);
    expect(await b.next()).toEqual({ id: 9, error: 'busy' });
    expect(await b.status()).toMatchObject({ queued: 8 }); // busy for the bytes: 8 jobs are far from the count limit
    a.send({ type: 'cancel', id: 1 });
    expect(await a.next((m) => m.id === 1)).toEqual({ id: 1, error: 'cancelled' });
    b.send(job(10), big);
    expect(await b.status()).toMatchObject({ queued: 8 }); // 7 after the cancel, 8 with the job that now fits
    expect(b.inbox.filter((m) => m.error === 'busy')).toHaveLength(1);
  });
  it('the bytes of jobs that ran or whose window left are no longer counted', async () => {
    rig.autoReady = false;
    const h = await start();
    const a = await open();
    const b = await open();
    const big = pcm(4_000_000);
    for (let n = 1; n <= 8; n++) a.send(job(n), big);
    await a.status();
    b.send(job(1), big);
    expect(await b.next()).toEqual({ id: 1, error: 'busy' });
    a.sock.destroy(); // eight jobs go at once
    await until(() => h.status().queued === 0);
    b.send(job(2), big);
    expect(await b.status()).toMatchObject({ queued: 1 });
    rig.workers[0]!.ready();
    await rig.call(0);
    rig.answer(0, 'x');
    for (let n = 3; n <= 11; n++) b.send(job(n), big); // the first of these runs at once; the rest fill the cap again
    expect(await b.status()).toMatchObject({ queued: 8, running: true });
    expect(b.inbox.filter((m) => m.error === 'busy')).toHaveLength(1);
  });
  it('a window past the cap of connections is closed at once', async () => {
    const h = await start();
    for (let i = 0; i < MAX_CLIENTS; i++) await open();
    expect(h.status().clients).toBe(MAX_CLIENTS);
    const extraSock = net.connect(socketPath());
    extraSock.on('error', () => {});
    await new Promise<void>((resolve) => extraSock.once('close', () => resolve()));
    expect(h.status().clients).toBe(MAX_CLIENTS);
    conns[0]!.sock.destroy();
    await until(() => h.status().clients === MAX_CLIENTS - 1);
    expect(await (await open()).status()).toMatchObject({ clients: MAX_CLIENTS });
  });
  it('a window that does not read its answers is dropped once a megabyte of them waits', async () => {
    const h = await start();
    const c = await open();
    c.sock.pause(); // takes nothing from the socket
    c.sock.write(Buffer.concat(Array.from({ length: 30_000 }, () => encodeFrame({ type: 'status' }))));
    await until(() => h.status().clients === 0);
  });
  it('a window that does not read cannot hold the stop: its connection is destroyed after a short grace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = await start();
    const c = await open();
    c.sock.pause();
    for (let n = 1; n <= 16; n++) {
      c.send(job(n), pcm(1));
      await rig.call(n - 1);
      rig.answer(n - 1, 'x'.repeat(60_000)); // ~1 MB in all: more than the socket holds, less than the cap
    }
    await until(() => !h.status().running);
    const stopping = h.stop('test');
    await runDown(stopping);
    expect(await stopping).toBe(0);
  });
});

describe('a stop that goes wrong', () => {
  it('still finishes, ends the model thread and removes the socket when the model refuses to be disposed', async () => {
    const h = await start();
    const c = await open();
    c.send(job(1), pcm(1));
    await rig.call(0);
    rig.answer(0, 'x');
    await c.next((m) => m.id === 1);
    rig.throwOnDispose = true;
    await expect(h.stop()).resolves.toBe(0);
    expect(rig.workers[0]!.terminated).toBeGreaterThan(0);
    expect(fs.existsSync(socketPath())).toBe(false);
    expect(logs.some((m) => m.includes('disposing the model failed'))).toBe(true);
  });
});

describe('the process entry, with the real model thread', () => {
  /** An install whose package answers `task|model|samples|language`, in place of transformers.js. */
  const fakeInstall = (body = `async (audio, opts) => ({ text: [task, model, audio.length, opts.language].join('|') })`): void => {
    const pkg = path.join(tmp, 'whisper', 'node_modules', ...WHISPER_PACKAGE.split('/'));
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: WHISPER_PACKAGE, version: '0.0.0', type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(pkg, 'index.js'), `import fs from 'node:fs';
export const env = {};
export const pipeline = async (task, model) => ${body};`);
  };
  const entry = fileURLToPath(new URL('./hostEntry.ts', import.meta.url));
  /** The host as the window side runs it: its own process, stderr read for the "listening" line. */
  const spawnHost = () => {
    const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH, NOTA_BENE_HOME: tmp }, stdio: ['ignore', 'ignore', 'pipe'] });
    const o = { child, gone: false, log: '', exited: undefined as unknown as Promise<{ code: number | null; signal: string | null }> };
    child.stderr.on('data', (d: Buffer) => { o.log += d.toString(); });
    o.exited = new Promise((resolve) => child.once('exit', (code, signal) => { o.gone = true; resolve({ code, signal }); }));
    return o;
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
      expect(await main({})).toEqual({ code: 0, wedged: false }); // another host answers: nothing to do
      const c = await Conn.open(hostSocketPath());
      conns.push(c);
      c.send(job(1, { lang: 'ru', detect: false }), pcm(5));
      expect(await c.next((m) => m.id === 1)).toEqual({ id: 1, text: `automatic-speech-recognition|${WHISPER_MODEL}|5|ru`, lang: 'ru' });
      c.send({ type: 'shutdown', reason: 'removed' });
      expect(await exit).toEqual({ code: 0, wedged: false });
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
    const h = spawnHost();
    try {
      await until(() => h.gone || h.log.includes('listening on')); // the socket is bound and listening, not just there
      expect(h.gone, h.log).toBe(false);
      const c = await Conn.open(hostSocketPath());
      conns.push(c);
      c.send(job(1), pcm(2));
      expect(await c.next((m) => m.id === 1)).toMatchObject({ id: 1, text: expect.stringMatching(/\|2\|en$/) });
      h.child.kill('SIGTERM');
      expect(await h.exited).toEqual({ code: 0, signal: null });
      expect(fs.existsSync(hostSocketPath())).toBe(false);
    } finally {
      h.child.kill('SIGKILL');
    }
  });
  it('a model thread stuck in a native call cannot be stopped, so the host kills its own process instead of hanging in exit()', async () => {
    // the stub's call blocks in a read(2) of a pipe nobody writes to: no terminate() or exit() gets that thread out of it
    const fifo = path.join(tmp, 'block.fifo');
    const marker = path.join(tmp, 'in-the-call');
    execFileSync('mkfifo', [fifo]);
    fakeInstall(`async () => { fs.writeFileSync(${JSON.stringify(marker)}, ''); const fd = fs.openSync(${JSON.stringify(fifo)}, 'r+'); fs.readSync(fd, Buffer.alloc(1)); return { text: '' }; }`);
    const h = spawnHost();
    try {
      await until(() => h.gone || h.log.includes('listening on'));
      expect(h.gone, h.log).toBe(false);
      const c = await Conn.open(hostSocketPath());
      conns.push(c);
      c.send(job(1), pcm(2));
      await until(() => h.gone || fs.existsSync(marker)); // the thread is in the call
      expect(h.gone, h.log).toBe(false);
      h.child.kill('SIGTERM');
      expect(await h.exited).toEqual({ code: null, signal: 'SIGKILL' });
      expect(h.log).toContain('stopping (shutdown)');
    } finally {
      h.child.kill('SIGKILL');
    }
  }, 30_000);
  it('NOTA_BENE_TEST_WHISPER_IDLE_MS shortens the idle time', async () => {
    expect(await main({ NOTA_BENE_TEST_WHISPER_IDLE_MS: '1' })).toEqual({ code: 0, wedged: false });
    expect(fs.existsSync(hostSocketPath())).toBe(false);
  });
});
