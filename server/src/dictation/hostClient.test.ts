// The window's side of the Whisper host: protocol behaviour against a scripted host on the real socket path, and the connect-or-
// spawn path against real host processes (hostEntry.ts, with a stub in place of transformers.js). Unix sockets only, in a short
// /tmp folder (sun_path is ~104 bytes); every host a test starts is killed in afterEach.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF_FAILURES, BACKOFF_WINDOW_MS, FALLBACK_MS, HostClient, hostEntryFile, IDLE_CLOSE_MS, WhisperBusy, WhisperOff, type HostClientOptions } from './hostClient.ts';
import { encodeFrame, FrameDecoder, HOST_PINS, HOST_PROTO, hostDir, hostSocketPath, pcmFromInt16, privateDir, type Header } from './hostWire.ts';
import { WHISPER_PACKAGE } from './whisper.ts';

/** `n` samples of a quarter of full scale. */
const pcm = (n: number): Float32Array => new Float32Array(n).fill(0.25);
/** Waits, without a clock, until something that happens on its own has happened. */
const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => { while (!await cond()) await new Promise<void>((r) => setImmediate(r)); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let home: string;
let clients: HostClient[];
let fakes: FakeHost[];
let servers: net.Server[];
let reports: [string, unknown][];

beforeEach(() => {
  home = fs.mkdtempSync('/tmp/nbw-');
  reports = [];
  clients = [];
  fakes = [];
  servers = [];
  vi.stubEnv('NOTA_BENE_HOME', home);
  vi.stubEnv('NOTA_BENE_TEST_WHISPER_IDLE_MS', '60000'); // a host a failed test leaves behind goes by itself
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  for (const c of clients) c.close();
  for (const f of fakes) await f.stop();
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  hostPids().forEach((pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The pid of every host the log of this test's host folder names. */
function hostPids(): number[] {
  try {
    return [...fs.readFileSync(path.join(hostDir(), 'host.log'), 'utf8').matchAll(/whisper-host (\d+):/g)].map((m) => Number(m[1]));
  } catch { return []; }
}

function make(o: HostClientOptions = {}): HostClient {
  const c = new HostClient({ report: (where, e) => { reports.push([where, e]); }, ...o });
  clients.push(c);
  return c;
}
/** What the window was told went wrong. */
const told = (): string[] => reports.map(([, e]) => (e as Error).message);

// ---------------------------------------------------------------------------------------------------------------------------
// A scripted host

type Seen = { conn: number; header: Header; body: Buffer };

/** A host on the real socket path that does what the test says. It answers `hello` and `status` itself. */
class FakeHost {
  readonly socks: net.Socket[] = [];
  readonly seen: Seen[] = [];
  private readonly server = net.createServer();
  private waiting: (() => void)[] = [];
  /** What it does with a frame that is not hello or status. */
  on: (s: Seen, sock: net.Socket) => void = () => {};
  hello: Header = { type: 'hello', proto: HOST_PROTO, pid: 4242, pins: HOST_PINS, loaded: false, queued: 0 };
  /** While set, `hello` is not answered until it settles. */
  gate: Promise<void> | undefined;

  static async start(): Promise<FakeHost> {
    const f = new FakeHost();
    privateDir(hostDir());
    await new Promise<void>((resolve) => f.server.listen(hostSocketPath(), resolve));
    f.server.on('connection', (sock) => {
      const conn = f.socks.push(sock) - 1;
      const decoder = new FrameDecoder();
      sock.on('error', () => {});
      sock.on('data', (d: Buffer) => {
        for (const fr of decoder.push(d)) {
          if (fr.header.type === 'hello') void (f.gate ?? Promise.resolve()).then(() => { if (!sock.destroyed) sock.write(encodeFrame(f.hello)); });
          else if (fr.header.type === 'status') sock.write(encodeFrame({ type: 'status', loaded: true, queued: 3, running: false, clients: 1 }));
          else {
            const s = { conn, header: fr.header, body: fr.body };
            f.seen.push(s);
            f.on(s, sock);
            for (const w of f.waiting.splice(0)) w();
          }
        }
      });
    });
    fakes.push(f);
    return f;
  }
  /** The first frame of this kind not taken yet. */
  async next(type: string, skip = 0): Promise<Seen> {
    for (;;) {
      const hits = this.seen.filter((s) => s.header.type === type);
      if (hits.length > skip) return hits[skip]!;
      await new Promise<void>((r) => this.waiting.push(r));
    }
  }
  of(type: string): Seen[] { return this.seen.filter((s) => s.header.type === type); }
  answer(sock: net.Socket, header: Header): void { sock.write(encodeFrame(header)); }
  async stop(): Promise<void> {
    for (const s of this.socks) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

describe('a host that answers', () => {
  it('takes the job as 16-bit PCM and the answer is the transcript and its language', async () => {
    const f = await FakeHost.start();
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, text: 'hello there', lang: 'de' });
    const c = make();
    expect(await c.transcribe(pcm(8), 'en', true)).toEqual({ text: 'hello there', lang: 'de' });
    const job = f.of('job')[0]!;
    expect(job.header).toEqual({ type: 'job', id: 0, opts: { lang: 'en', detect: true } });
    expect(Array.from(pcmFromInt16(job.body))).toEqual(Array(8).fill(0.25));
    expect(c.spawned).toBe(0);
  });

  it('a host that has not loaded the model yet (lazy load) is a healthy one', async () => {
    const f = await FakeHost.start();
    f.hello = { ...f.hello, loaded: false };
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, text: 'x', lang: 'en' });
    const c = make();
    expect(await c.transcribe(pcm(1), 'en', false)).toEqual({ text: 'x', lang: 'en' });
    expect(reports).toEqual([]);
  });

  it('jobs of one connection are told apart by id, whatever the order of the answers', async () => {
    const f = await FakeHost.start();
    const c = make();
    const a = c.transcribe(pcm(1), 'en', false);
    const b = c.transcribe(pcm(2), 'ru', false);
    const first = await f.next('job', 0);
    const second = await f.next('job', 1);
    expect(f.socks).toHaveLength(1); // one connection per window
    expect([first.header.id, second.header.id]).toEqual([0, 1]);
    f.answer(f.socks[0]!, { id: 1, text: 'second', lang: 'ru' });
    f.answer(f.socks[0]!, { id: 0, text: 'first', lang: 'en' });
    expect(await a).toEqual({ text: 'first', lang: 'en' });
    expect(await b).toEqual({ text: 'second', lang: 'ru' });
  });

  it('a `failed` answer is the job\'s error and is not retried', async () => {
    const f = await FakeHost.start();
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, error: 'failed' });
    const c = make();
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toThrow('could not transcribe');
    expect(f.of('job')).toHaveLength(1);
    expect(reports).toEqual([]); // a failed job is not a dead host
  });

  it('`busy` is a distinct error and is not retried; `off` too', async () => {
    const f = await FakeHost.start();
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, error: s.body.length === 2 ? 'busy' : 'off' });
    const c = make();
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(WhisperBusy);
    await expect(c.transcribe(pcm(2), 'en', false)).rejects.toBeInstanceOf(WhisperOff);
    expect(f.of('job')).toHaveLength(2);
  });

  it('a job larger than a frame runs in this process (null), nothing sent', async () => {
    const f = await FakeHost.start();
    const c = make();
    expect(await c.transcribe(new Float32Array(2_200_000), 'en', false)).toBeNull();
    expect(f.seen).toEqual([]);
  });
});

describe('a host that goes while it has the job', () => {
  it('the job is sent once more on a fresh connection, and only once more', async () => {
    const f = await FakeHost.start();
    let n = 0;
    f.on = (s, sock) => { if (++n === 1) sock.destroy(); else f.answer(sock, { id: s.header.id, text: 'again', lang: 'en' }); };
    const c = make();
    expect(await c.transcribe(pcm(1), 'en', false)).toEqual({ text: 'again', lang: 'en' });
    expect(f.of('job').map((s) => s.conn)).toEqual([0, 1]); // the second try is on a new connection
  });

  it('twice is the job\'s failure: no third try', async () => {
    const f = await FakeHost.start();
    f.on = (_s, sock) => sock.destroy();
    const c = make();
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toThrow('stopped before it answered');
    expect(f.of('job')).toHaveLength(2);
  });

  it('a host that closed the connection under a job is one death; three within a minute send the window to its own model for five', async () => {
    let t = 1_000_000;
    const f = await FakeHost.start();
    f.on = (_s, sock) => sock.destroy();
    const c = make({ now: () => t });
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toThrow(); // deaths 1 and 2
    expect(reports).toEqual([]);
    // death 3 (the first try of the next job): the retry finds the window in fallback and answers null
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(told()).toHaveLength(1);
    expect(told()[0]).toMatch(new RegExp(`failed ${BACKOFF_FAILURES} times within a minute.*5 minutes`));
    const jobs = f.of('job').length;
    expect(jobs).toBe(3);
    // in fallback no connection is made at all
    t += FALLBACK_MS - 1;
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(f.of('job')).toHaveLength(jobs);
    expect(told()).toHaveLength(1); // told once
    // and after it the host is tried again
    t += 1;
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, text: 'back', lang: 'en' });
    expect(await c.transcribe(pcm(1), 'en', false)).toEqual({ text: 'back', lang: 'en' });
  });

  it('deaths further apart than a minute do not add up', async () => {
    let t = 1_000_000;
    const f = await FakeHost.start();
    f.on = (_s, sock) => sock.destroy();
    const c = make({ now: () => t });
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toThrow(); // two deaths
    t += BACKOFF_WINDOW_MS; // they are out of the window by now
    let n = 0;
    f.on = (s, sock) => { if (++n === 1) sock.destroy(); else f.answer(sock, { id: s.header.id, text: 'ok', lang: 'en' }); };
    expect(await c.transcribe(pcm(1), 'en', false)).toEqual({ text: 'ok', lang: 'en' }); // a third, but the only one of its minute
    expect(reports).toEqual([]);
  });

  it('a host that is asked to shut down and closes every connection is no death, however often', async () => {
    const f = await FakeHost.start();
    f.on = (s, sock) => {
      if (s.header.type === 'shutdown') for (const o of f.socks) o.destroy();
      else f.answer(sock, { id: s.header.id, text: 'x', lang: 'en' });
    };
    const c = make();
    for (let i = 0; i < BACKOFF_FAILURES; i++) {
      await c.transcribe(pcm(1), 'en', false); // our own connection is open
      expect(await c.shutdown('removed', 1000)).toEqual({ pid: 4242, gone: false }); // the scripted host keeps its socket name
      await until(() => !c.connected());
    }
    expect(f.of('shutdown')[0]!.header).toEqual({ type: 'shutdown', reason: 'removed' });
    expect(reports).toEqual([]);
  });
});

describe('a host that is not the one expected', () => {
  it('another protocol or pins: a failed start, this job runs in this process', async () => {
    const f = await FakeHost.start();
    f.hello = { ...f.hello, proto: HOST_PROTO + 1 };
    const c = make();
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(f.of('job')).toEqual([]);
  });
});

describe('cancelling', () => {
  it('a job that is aborted while the host has it sends `cancel {id}` and rejects with the reason', async () => {
    const f = await FakeHost.start();
    const c = make();
    const ac = new AbortController();
    const p = c.transcribe(pcm(1), 'en', false, ac.signal);
    const job = await f.next('job');
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect((await f.next('cancel')).header).toEqual({ type: 'cancel', id: job.header.id });
  });

  it('the late `cancelled` answer is ignored and the connection serves the next job', async () => {
    const f = await FakeHost.start();
    f.on = (s, sock) => {
      if (s.header.type === 'cancel') f.answer(sock, { id: s.header.id, error: 'cancelled' });
      else if (s.header.id === 1) f.answer(sock, { id: 1, text: 'next', lang: 'en' });
    };
    const c = make();
    const ac = new AbortController();
    const p = c.transcribe(pcm(1), 'en', false, ac.signal);
    await f.next('job');
    ac.abort();
    await p.catch(() => {});
    await f.next('cancel');
    expect(await c.transcribe(pcm(2), 'en', false)).toEqual({ text: 'next', lang: 'en' });
    expect(f.socks).toHaveLength(1);
  });

  it('a signal aborted before the call sends nothing and does not even connect', async () => {
    const f = await FakeHost.start();
    const c = make();
    const ac = new AbortController();
    ac.abort(new Error('gone'));
    await expect(c.transcribe(pcm(1), 'en', false, ac.signal)).rejects.toThrow('gone');
    expect(f.socks).toHaveLength(0);
    expect(f.seen).toEqual([]);
  });

  it('an abort while the connection is still being made rejects at once, and the job is never sent', async () => {
    const f = await FakeHost.start();
    let open!: () => void;
    f.gate = new Promise<void>((resolve) => { open = resolve; }); // the host accepts, but does not say hello yet
    const c = make();
    const ac = new AbortController();
    const p = c.transcribe(pcm(1), 'en', false, ac.signal);
    await until(() => f.socks.length === 1);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    open();
    await until(() => c.connected()); // the connection made meanwhile is the window's, and stays
    expect(f.of('job')).toEqual([]);
  });
});

describe('the connection', () => {
  it('is closed after a while without jobs and made again for the next', async () => {
    const f = await FakeHost.start();
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, text: 'x', lang: 'en' });
    const c = make({ idleMs: 20 });
    await c.transcribe(pcm(1), 'en', false);
    expect(c.connected()).toBe(true);
    await until(() => !c.connected());
    expect(reports).toEqual([]); // closing it is not a death
    await c.transcribe(pcm(1), 'en', false);
    expect(f.socks).toHaveLength(2);
  });

  it('stays open while a job is waiting, however long', async () => {
    const f = await FakeHost.start();
    const c = make({ idleMs: 20 });
    const p = c.transcribe(pcm(1), 'en', false);
    await f.next('job');
    await sleep(150); // many idle periods
    expect(c.connected()).toBe(true);
    expect(f.socks[0]!.destroyed).toBe(false);
    f.answer(f.socks[0]!, { id: 0, text: 'late', lang: 'en' });
    expect(await p).toEqual({ text: 'late', lang: 'en' });
  });

  it('stays open while another job waits after one was answered', async () => {
    const f = await FakeHost.start();
    const c = make({ idleMs: 20 });
    const a = c.transcribe(pcm(1), 'en', false);
    const b = c.transcribe(pcm(2), 'en', false);
    await f.next('job', 1);
    f.answer(f.socks[0]!, { id: 0, text: 'a', lang: 'en' });
    expect(await a).toEqual({ text: 'a', lang: 'en' });
    await sleep(150); // many idle periods, with the second job still out
    expect(c.connected()).toBe(true);
    f.answer(f.socks[0]!, { id: 1, text: 'b', lang: 'en' });
    expect(await b).toEqual({ text: 'b', lang: 'en' });
  });

  it('closes after a minute by default', () => {
    expect(IDLE_CLOSE_MS).toBe(60_000);
  });

  it('close() ends it and a job that waits fails without a retry', async () => {
    const f = await FakeHost.start();
    const c = make();
    const p = c.transcribe(pcm(1), 'en', false);
    await f.next('job');
    c.close();
    await expect(p).rejects.toThrow('closed');
    expect(f.of('job')).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  it('status() asks the running host', async () => {
    await FakeHost.start();
    const c = make();
    expect(await c.status()).toEqual({ pid: 4242, loaded: true, queued: 3, running: false, clients: 1 });
    expect(c.connected()).toBe(false); // a short connection of its own
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Real host processes

type Stub = { blockFirst?: boolean; fail?: boolean };
const calls = (): string => path.join(home, 'calls');
const marker = (): string => path.join(home, 'blocked');
const envFile = (): string => path.join(home, 'env.json');

/** An install whose package answers `samples|language|pid` in place of transformers.js; what it does is `o`. */
function fakeInstall(o: Stub = {}, base = home): void {
  const pkg = path.join(base, 'whisper', 'node_modules', ...WHISPER_PACKAGE.split('/'));
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: WHISPER_PACKAGE, version: '0.0.0', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), `import fs from 'node:fs';
export const env = {};
export const pipeline = async () => async (audio, opts) => {
  fs.appendFileSync(${JSON.stringify(calls())}, 'x');
  fs.writeFileSync(${JSON.stringify(envFile())}, JSON.stringify(Object.keys(process.env)));
  if (${o.blockFirst === true} && fs.readFileSync(${JSON.stringify(calls())}, 'utf8').length === 1) {
    fs.writeFileSync(${JSON.stringify(marker())}, '');
    await new Promise(() => {}); // the host is killed under this call
  }
  if (${o.fail === true}) throw new Error('the model failed');
  return { text: [audio.length, opts.language, process.pid].join('|') };
};`);
}
const callCount = (): number => { try { return fs.readFileSync(calls(), 'utf8').length; } catch { return 0; } };

/** A socket file nobody listens on: its owner was killed without cleaning up. */
async function staleSocket(file: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => console.log("up"))', file], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
  expect(fs.lstatSync(file).isSocket()).toBe(true);
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const text = (got: { text: string } | null): string[] => got!.text.split('|');

describe('starting the host', { timeout: 30_000 }, () => {
  beforeEach(() => fakeInstall());

  it('runs hostEntry.ts beside it in a checkout', () => {
    expect(path.basename(hostEntryFile())).toBe('hostEntry.ts');
    expect(fs.existsSync(hostEntryFile())).toBe(true);
  });

  it('starts it when nobody listens, in a private folder with a private log, and keeps using it', async () => {
    const c = make();
    expect(await c.status()).toBeNull(); // asking never starts one, nor makes its folder
    expect(c.spawned).toBe(0);
    expect(fs.existsSync(hostDir())).toBe(false);
    const got = await c.transcribe(pcm(4), 'ru', false);
    expect(text(got).slice(0, 2)).toEqual(['4', 'ru']);
    expect(got!.lang).toBe('ru');
    expect(c.spawned).toBe(1);
    const pid = Number(text(got)[2]);
    expect(pid).not.toBe(process.pid); // the host's own process
    expect(alive(pid)).toBe(true);
    expect(await c.status()).toMatchObject({ pid, loaded: true, running: false });
    expect(fs.statSync(hostDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(hostDir(), 'host.log')).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(hostDir(), 'spawn.lock'))).toBe(false); // released
    expect(Number(text(await c.transcribe(pcm(2), 'en', false))[2])).toBe(pid);
    expect(c.spawned).toBe(1);
  });

  it('the host gets only what it needs of the environment', async () => {
    vi.stubEnv('NB_TEST_SECRET', 'nope');
    const c = make();
    const got = await c.transcribe(pcm(1), 'en', false);
    const keys: string[] = JSON.parse(fs.readFileSync(envFile(), 'utf8'));
    expect(keys).toContain('NOTA_BENE_HOME');
    expect(keys).toContain('PATH');
    expect(keys).not.toContain('NB_TEST_SECRET');
    expect(keys).not.toContain('NOTA_BENE_AGENT'); // not even the window's own provider
    expect(Number(text(got)[2])).not.toBe(process.pid);
  });

  it('two windows that find nobody at once start one host between them', async () => {
    const a = make();
    const b = make();
    const [x, y] = await Promise.all([a.transcribe(pcm(1), 'en', false), b.transcribe(pcm(2), 'en', false)]);
    expect(a.spawned + b.spawned).toBe(1);
    expect(text(x)[2]).toBe(text(y)[2]);
    expect((await a.status())!.clients).toBe(2);
    expect(fs.existsSync(path.join(hostDir(), 'spawn.lock'))).toBe(false);
  });

  it('five windows at once start one host', async () => {
    const cs = [1, 2, 3, 4, 5].map(() => make());
    const got = await Promise.all(cs.map((c, i) => c.transcribe(pcm(i + 1), 'en', false)));
    expect(cs.reduce((n, c) => n + c.spawned, 0)).toBe(1);
    expect(new Set(got.map((g) => text(g)[2])).size).toBe(1);
  });

  it('one window with several jobs at once starts one host', async () => {
    const c = make();
    const got = await Promise.all([1, 2, 3].map((n) => c.transcribe(pcm(n), 'en', false)));
    expect(c.spawned).toBe(1);
    expect(got.map((g) => text(g)[0])).toEqual(['1', '2', '3']);
  });

  it('recovers a stale socket file: a host that was killed left its socket behind', async () => {
    privateDir(hostDir());
    await staleSocket(hostSocketPath());
    const c = make();
    expect(text(await c.transcribe(pcm(3), 'en', false))[0]).toBe('3');
    expect(c.spawned).toBe(1);
    expect(fs.lstatSync(hostSocketPath()).isSocket()).toBe(true);
  });

  it('recovers a file that is not a socket at the host\'s name', async () => {
    privateDir(hostDir());
    fs.writeFileSync(hostSocketPath(), 'not a socket');
    const c = make();
    expect(text(await c.transcribe(pcm(3), 'en', false))[0]).toBe('3');
  });

  it('sweeps the temp sockets a killed host left between bind and rename, and spares one that answers', async () => {
    privateDir(hostDir());
    const dead = path.join(hostDir(), '.deadbeef.sock');
    const live = path.join(hostDir(), '.cafe0123.sock');
    const other = path.join(hostDir(), '.not-a-temp-name.sock');
    await staleSocket(dead);
    fs.writeFileSync(other, '');
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(live, resolve)); // a host between bind and rename
    const c = make();
    await c.transcribe(pcm(1), 'en', false);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(other)).toBe(true); // only the host's own temp names
  });

  it('takes over the spawn lock of a process that is gone', async () => {
    privateDir(hostDir());
    // a lock of a process that is gone
    fs.writeFileSync(path.join(hostDir(), 'spawn.lock'), JSON.stringify({ version: 'x', pid: 2 ** 22 + 1 }));
    const c = make();
    expect(text(await c.transcribe(pcm(1), 'en', false))[0]).toBe('1');
    expect(c.spawned).toBe(1);
  });
});

describe('a host that dies', { timeout: 30_000 }, () => {
  it('killed while it has the job: the job is sent once more, to a fresh host, and succeeds', async () => {
    fakeInstall({ blockFirst: true });
    const c = make();
    const p = c.transcribe(pcm(4), 'en', false);
    await until(() => fs.existsSync(marker())); // the model call is under way
    const { pid } = (await c.status())!;
    process.kill(pid, 'SIGKILL');
    const got = await p;
    expect(text(got).slice(0, 2)).toEqual(['4', 'en']);
    expect(Number(text(got)[2])).not.toBe(pid);
    expect(c.spawned).toBe(2);
    expect(callCount()).toBe(2); // the first host's call, and the retry's
  });

  it('a model that fails the job is a failed job, not a dead host: no second host, no retry', async () => {
    fakeInstall({ fail: true });
    const c = make();
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toThrow('could not transcribe');
    expect(callCount()).toBe(1);
    expect(c.spawned).toBe(1);
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toThrow('could not transcribe');
    expect(c.spawned).toBe(1);
    expect(reports).toEqual([]);
  });

  it('a job that is cancelled while it waits behind another is dropped by the real host', async () => {
    fakeInstall({ blockFirst: true });
    const c = make();
    const first = c.transcribe(pcm(1), 'en', false);
    first.catch(() => {});
    await until(() => fs.existsSync(marker())); // the model is busy with the first
    const ac = new AbortController();
    const second = c.transcribe(pcm(2), 'en', false, ac.signal);
    await until(async () => (await c.status())!.queued === 1);
    ac.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await until(async () => (await c.status())!.queued === 0); // the host dropped it: it will not run
    expect(callCount()).toBe(1);
  });

  it('shutdown() stops the host and its socket name is gone; asking again finds none', async () => {
    fakeInstall();
    const c = make();
    const pid = Number(text(await c.transcribe(pcm(1), 'en', false))[2]);
    expect(await c.shutdown('removed')).toEqual({ pid, gone: true });
    expect(fs.existsSync(hostSocketPath())).toBe(false);
    await until(() => !alive(pid));
    expect(await c.shutdown()).toBeNull();
    expect(c.connected()).toBe(false);
    expect(reports).toEqual([]); // a shutdown is not a death
    // the next job starts a new host
    expect(Number(text(await c.transcribe(pcm(1), 'en', false))[2])).not.toBe(pid);
  });
});

describe('a machine where the host cannot be started', { timeout: 60_000 }, () => {
  it('failed starts count: three within a minute send the window to its own model, told once', async () => {
    let t = 5_000_000;
    const c = make({ entry: path.join(home, 'no-such-entry.ts'), now: () => t });
    for (let i = 0; i < BACKOFF_FAILURES; i++) expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(c.spawned).toBe(BACKOFF_FAILURES);
    expect(told()).toHaveLength(1);
    expect(told()[0]).toMatch(/exited at startup/);
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull(); // no fourth start
    expect(c.spawned).toBe(BACKOFF_FAILURES);
    expect(told()).toHaveLength(1);
    t += FALLBACK_MS; // and after the five minutes it tries again
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(c.spawned).toBe(BACKOFF_FAILURES + 1);
  });

  it('a start that fails once is no more than a job run here', async () => {
    const c = make({ entry: path.join(home, 'no-such-entry.ts') });
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(reports).toEqual([]);
  });

  it('windows that fail to start together count one failure, not one each', async () => {
    const c = make({ entry: path.join(home, 'no-such-entry.ts') });
    const got = await Promise.all([1, 2, 3, 4].map((n) => c.transcribe(pcm(n), 'en', false)));
    expect(got).toEqual([null, null, null, null]);
    expect(c.spawned).toBe(1);
    expect(reports).toEqual([]);
  });

  it('a socket path that does not fit: in process, told once, nothing created', async () => {
    const long = path.join('/tmp', `nbw-${'x'.repeat(100)}`);
    vi.stubEnv('NOTA_BENE_HOME', long);
    const c = make();
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(told()).toHaveLength(1);
    expect(told()[0]).toMatch(/too long/);
    expect(fs.existsSync(long)).toBe(false);
    expect(c.spawned).toBe(0);
  });

  it('a host folder that belongs to someone else is not used: in process, told once', async () => {
    privateDir(hostDir());
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    const c = make();
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(told()).toHaveLength(1);
    expect(told()[0]).toMatch(/belongs to another user/);
    expect(c.spawned).toBe(0);
  });
});
