// The window's side of the Whisper host: protocol behaviour against a scripted host on the real socket path, and the connect-or-
// spawn path against real host processes (hostEntry.ts, with a stub in place of transformers.js). Unix sockets only, in a short
// /tmp folder (sun_path is ~104 bytes); every host a test starts is killed in afterEach, clients closed first.
//
// No test here may reach the real ~/.nota-bene (a host once ran there with the real model, started by a call that a test had
// left running past its cleanup): NOTA_BENE_HOME is a folder of this file's own from the first line to the last, never unset
// between tests, calls that outlive a test are ended by closing their client (and every wait here has a bound).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http, { type RequestListener } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { EventHub } from '../hub.ts';
import { BACKOFF_FAILURES, BACKOFF_WINDOW_MS, ClientClosed, clientDeadlineMs, FALLBACK_MS, HELLO_WAIT_MS, HostClient, hostClient, hostEntryFile, HostLost, IDLE_CLOSE_MS, JOB_MARGIN_MS, LOCK_MARGIN_MS, WhisperBusy, WhisperOff, type HostClientOptions } from './hostClient.ts';
import { encodeFrame, FrameDecoder, HOST_PINS, HOST_PROTO, hostDir, hostSocketPath, jobDeadlineMs, LOAD_DEADLINE_MS, pcmFromInt16, privateDir, type Header } from './hostWire.ts';
import { readPrefs, setWhisperPref } from '../prefs.ts';
import { dictationRoutes } from './routes.ts';
import { resetTranscriber, transcribe } from './transcribe.ts';
import { WHISPER_MODEL, WHISPER_PACKAGE, WHISPER_REVISION, WHISPER_VERSION } from './whisper.ts';
import { makeWav } from './wavFixture.ts';

/** `n` samples of a quarter of full scale. */
const pcm = (n: number): Float32Array => new Float32Array(n).fill(0.25);
/** Waits until something that happens on its own has happened; gives up after `ms`, so that a test that cannot finish ends. */
const until = async (cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!await cond()) {
    if (Date.now() > stop) throw new Error('timed out waiting for a condition');
    await new Promise<void>((r) => setImmediate(r));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The folder of this file: the home of any call that runs between two tests or after one. */
const sandbox = fs.mkdtempSync('/tmp/nbw-');
vi.stubEnv('NOTA_BENE_HOME', sandbox);
vi.stubEnv('NOTA_BENE_TEST_WHISPER_IDLE_MS', '60000'); // a host a failed test leaves behind goes by itself
afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
/** Throws unless the state home is one of ours: a test that would reach the real home fails instead. */
const sandboxed = (): void => {
  const base = process.env.NOTA_BENE_HOME ?? '';
  if (!base.startsWith('/tmp/nbw-')) throw new Error(`NOTA_BENE_HOME is ${base || 'unset'}: this file must never touch the real home`);
};

let home: string;
let clients: HostClient[];
let fakes: FakeHost[];
let servers: net.Server[];
let reports: [string, unknown][];
/** Child processes a test made that no client knows of (the leftovers of a killed host). */
let strays: ChildProcess[];

/** The install under `base` reads as ready (`ready.json` with the pins), as the client wants before it starts a host: nothing of the model itself. */
function markReady(base: string): void {
  fs.mkdirSync(path.join(base, 'whisper'), { recursive: true });
  fs.writeFileSync(path.join(base, 'whisper', 'ready.json'), JSON.stringify({ version: WHISPER_VERSION, model: WHISPER_MODEL, revision: WHISPER_REVISION }));
}

beforeEach(() => {
  sandboxed();
  home = fs.mkdtempSync('/tmp/nbw-');
  reports = [];
  clients = [];
  fakes = [];
  servers = [];
  strays = [];
  vi.stubEnv('NOTA_BENE_HOME', home);
  markReady(home);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  // first: nothing may go on after the test (a connect, a start, a retry, a wait), and nothing it started may live on
  const all = [...clients, hostClient];
  for (const c of all) c.close();
  for (const child of [...all.flatMap((c) => [...c.children]), ...strays]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const f of fakes) await f.stop();
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  // only then the folder; the env goes back to this file's own folder, never to unset (that is the real home)
  vi.stubEnv('NOTA_BENE_HOME', sandbox);
  vi.stubEnv('NOTA_BENE_TEST_WHISPER_IDLE_MS', '60000'); // a test that shortened the idle time (one that timed out too) leaves no short one behind
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
  sandboxed();
});

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
  /** While set, a connection that says hello is closed instead of answered. */
  dropHello = false;
  /** What it does with `status`: answers it (counting the live connections as windows, the asking one too), says nothing, or closes the connection. */
  onStatus: 'answer' | 'silent' | 'drop' = 'answer';

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
          if (fr.header.type === 'hello') {
            if (f.dropHello) sock.destroy();
            else void (f.gate ?? Promise.resolve()).then(() => { if (!sock.destroyed) sock.write(encodeFrame(f.hello)); });
          } else if (fr.header.type === 'status') {
            if (f.onStatus === 'drop') sock.destroy();
            else if (f.onStatus === 'answer') sock.write(encodeFrame({ type: 'status', loaded: true, queued: 3, running: false, clients: f.socks.filter((o) => !o.destroyed).length }));
          } else {
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

  it('the host\'s message for a failed job is the job\'s error message', async () => {
    const f = await FakeHost.start();
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, error: 'failed', message: 'the model said no' });
    const c = make();
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toThrow('could not transcribe it: the model said no');
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
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(HostLost);
    expect(f.of('job')).toHaveLength(2);
  });

  it('a host that closed the connection under a job is one death; three within a minute send the window to its own model for five', async () => {
    let t = 1_000_000;
    const f = await FakeHost.start();
    f.on = (_s, sock) => sock.destroy();
    const c = make({ now: () => t });
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toThrow(); // deaths 1 and 2
    expect(reports).toEqual([]);
    // death 3 (the first try of the next job): the window is in fallback now, but this job has lost a host and is not run here
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(HostLost);
    expect(told()).toHaveLength(1);
    expect(told()[0]).toMatch(new RegExp(`failed ${BACKOFF_FAILURES} times within a minute.*5 minutes`));
    const jobs = f.of('job').length;
    expect(jobs).toBe(3);
    // later jobs, with no host lost under them, are run here: no connection is made at all
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
      expect(await c.shutdown('removed', 1000)).toEqual({ pid: 4242, gone: false, held: false }); // the scripted host keeps its socket name
      await until(() => !c.connected());
    }
    expect(f.of('shutdown')[0]!.header).toEqual({ type: 'shutdown', reason: 'removed' });
    expect(reports).toEqual([]);
  });
});

describe('shutdown() and stopHost() against a scripted host', () => {
  /** A client that signals nobody for real: the pids a scripted host has are not processes of ours. */
  const makeKiller = (o: HostClientOptions = {}): { c: HostClient; sent: [number, NodeJS.Signals | 0][] } => {
    const sent: [number, NodeJS.Signals | 0][] = [];
    const c = make({ kill: (pid, signal) => { sent.push([pid, signal]); }, ...o });
    return { c, sent };
  };

  it('with no host there is nothing to stop: null, nobody is signalled, and a connection that is still good keeps counting its deaths', async () => {
    const { c, sent } = makeKiller();
    expect(await c.stopHost()).toBeNull();
    expect(sent).toEqual([]);
    expect(fs.existsSync(hostDir())).toBe(false); // asking made nothing
  });

  it('a host that went while it was greeted is one that is stopping: null', async () => {
    const f = await FakeHost.start();
    f.dropHello = true;
    const { c, sent } = makeKiller();
    expect(await c.shutdown('removed')).toBeNull();
    expect(await c.stopHost('removed')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('goes over the window\'s own connection when it has one: a host that is full takes no other, and its close is no death', async () => {
    const f = await FakeHost.start();
    f.on = (s, sock) => { if (s.header.type === 'shutdown') sock.destroy(); else f.answer(sock, { id: s.header.id, text: 'x', lang: 'en' }); };
    const { c } = makeKiller();
    await c.transcribe(pcm(1), 'en', false);
    f.hello = { type: 'full' }; // every connection after the window's own
    expect(await c.shutdown('removed', 1000)).toEqual({ pid: 4242, gone: false, held: false }); // the scripted host keeps its socket name
    expect(f.of('shutdown').map((x) => x.conn)).toEqual([0]);
    expect(f.socks).toHaveLength(1);
    expect(c.connected()).toBe(false);
    expect(c.recentFailures()).toBe(0);
    expect(reports).toEqual([]);
  });

  /** What a scripted host does with `shutdown` when it does as it is told: its name goes and every connection with it. */
  const stops = (f: FakeHost): void => {
    f.on = (s) => { if (s.header.type === 'shutdown') { fs.unlinkSync(hostSocketPath()); for (const o of f.socks) o.destroy(); } };
  };
  /** The next host takes the name from `f` when it stops, and only then does `f` close its connections: a host that is replaced. */
  const handsOver = (f: FakeHost, next: (n: FakeHost) => void, pid: number): void => {
    f.on = (s, sock) => {
      if (s.header.type === 'job') return f.answer(sock, { id: s.header.id, text: 'x', lang: 'en' });
      if (s.header.type !== 'shutdown') return;
      fs.unlinkSync(hostSocketPath());
      void FakeHost.start().then((n) => { n.hello = { ...n.hello, pid }; next(n); for (const o of f.socks) o.destroy(); });
    };
  };

  it('a host that stops as told (its name and our connection go) is not signalled', async () => {
    const f = await FakeHost.start();
    stops(f);
    const { c, sent } = makeKiller();
    expect(await c.stopHost('removed', 100)).toEqual({ pid: 4242, gone: true, held: false, signalled: false });
    expect(sent).toEqual([]);
  });

  it('a host that keeps our connection open after the wait is a live peer that ignored the shutdown: it gets SIGTERM, once', async () => {
    const f = await FakeHost.start();
    const { c, sent } = makeKiller();
    expect(await c.stopHost('removed', 100)).toEqual({ pid: 4242, gone: false, held: true, signalled: true });
    expect(f.of('shutdown')).toHaveLength(1);
    expect(f.of('shutdown')[0]!.header).toEqual({ type: 'shutdown', reason: 'removed' });
    expect(sent).toEqual([[4242, 'SIGTERM']]); // no probe: the open connection is the proof
  });

  it('a host that unlinked its name but keeps our connection open is still signalled (the name says nothing of the connection)', async () => {
    const f = await FakeHost.start();
    f.on = (s) => { if (s.header.type === 'shutdown') fs.unlinkSync(hostSocketPath()); };
    const { c, sent } = makeKiller();
    expect(await c.stopHost('removed', 100)).toEqual({ pid: 4242, gone: true, held: true, signalled: true });
    expect(sent).toEqual([[4242, 'SIGTERM']]);
  });

  it('a host that closed our connection is not signalled though its name is still there: the name is asked once more, and answers the same host', async () => {
    const f = await FakeHost.start();
    f.on = (s) => { if (s.header.type === 'shutdown') for (const o of f.socks) o.destroy(); }; // keeps its name
    const { c, sent } = makeKiller();
    expect(await c.stopHost('removed', 100)).toEqual({ pid: 4242, gone: false, held: false, signalled: false, next: { pid: 4242, gone: false, held: false, signalled: false } });
    expect(f.of('shutdown')).toHaveLength(2); // once, and once more on a connection of its own
    expect(sent).toEqual([]);
  });

  it('when the host our connection was to is gone and another one has its name, that one is asked, on a connection of its own, and by the rule: its own pid, and only for a connection it keeps open', async () => {
    const a = await FakeHost.start();
    let b!: FakeHost;
    handsOver(a, (n) => { b = n; }, 5151);
    const { c, sent } = makeKiller();
    await c.transcribe(pcm(1), 'en', false); // the window's own connection is to a, whose pid is 4242
    expect(await c.stopHost('removed', 100)).toEqual({ pid: 4242, gone: false, held: false, signalled: false, next: { pid: 5151, gone: false, held: true, signalled: true } });
    expect(b.of('shutdown')).toHaveLength(1);
    expect(b.of('shutdown')[0]!.conn).toBe(0); // its first connection: a fresh one, not the window's
    expect(sent).toEqual([[5151, 'SIGTERM']]); // not 4242: a's connection had closed
  });

  it('asks one more host at most: a third that takes the name is left alone', async () => {
    const a = await FakeHost.start();
    let b!: FakeHost;
    let c3!: FakeHost;
    handsOver(a, (n) => {
      b = n;
      handsOver(n, (m) => { c3 = m; }, 6262); // b stops as told too, and a third takes the name
    }, 5151);
    const { c, sent } = makeKiller();
    await c.transcribe(pcm(1), 'en', false); // the window's own connection is to a
    const r = await c.stopHost('removed', 100);
    expect(r).toEqual({ pid: 4242, gone: false, held: false, signalled: false, next: { pid: 5151, gone: false, held: false, signalled: false } });
    expect(b.of('shutdown')).toHaveLength(1);
    expect(c3.of('shutdown')).toEqual([]); // never asked
    expect(sent).toEqual([]);
  });

  it('a host that is gone by the time of the signal (no such process) is left alone', async () => {
    await FakeHost.start();
    const sent: [number, NodeJS.Signals | 0][] = [];
    const c = make({ kill: (pid, signal) => { sent.push([pid, signal]); throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); } });
    expect(await c.stopHost('removed', 100)).toEqual({ pid: 4242, gone: false, held: true, signalled: false });
    expect(sent).toEqual([[4242, 'SIGTERM']]); // tried, and it was gone
  });

  it('never signals this process, nor a pid that would be a process group or every process', async () => {
    const f = await FakeHost.start();
    const { c, sent } = makeKiller();
    for (const pid of [process.pid, 1]) {
      f.hello = { ...f.hello, pid };
      expect(await c.stopHost('removed', 50)).toEqual({ pid, gone: false, held: true, signalled: false });
    }
    for (const pid of [0, -1, -4242, 1.5]) { // not a host's pid at all: it is not a host of ours
      f.hello = { ...f.hello, pid };
      await expect(c.stopHost('removed', 50)).rejects.toThrow('another protocol');
    }
    expect(sent).toEqual([]);
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

  it('has no idle clock running while a job waits, and starts it when the answer comes', async () => {
    const f = await FakeHost.start();
    const c = make({ idleMs: 20 });
    const p = c.transcribe(pcm(1), 'en', false);
    await f.next('job');
    const conn = c['conn'] as unknown as { idle: unknown };
    expect(conn.idle).toBeUndefined(); // armed when the connection was made, cleared by the job
    f.answer(f.socks[0]!, { id: 0, text: 'late', lang: 'en' });
    expect(await p).toEqual({ text: 'late', lang: 'en' });
    expect(conn.idle).toBeDefined();
    await until(() => !c.connected());
  });

  it('has no idle clock running while another job waits after one was answered', async () => {
    const f = await FakeHost.start();
    const c = make({ idleMs: 20 });
    const a = c.transcribe(pcm(1), 'en', false);
    const b = c.transcribe(pcm(2), 'en', false);
    await f.next('job', 1);
    f.answer(f.socks[0]!, { id: 0, text: 'a', lang: 'en' });
    expect(await a).toEqual({ text: 'a', lang: 'en' });
    expect((c['conn'] as unknown as { idle: unknown }).idle).toBeUndefined(); // the second is still out
    f.answer(f.socks[0]!, { id: 1, text: 'b', lang: 'en' });
    expect(await b).toEqual({ text: 'b', lang: 'en' });
    await until(() => !c.connected());
  });

  it('a connection that is closing is not given to the next job, which keeps its retry', async () => {
    const f = await FakeHost.start();
    let drop = false;
    f.on = (s, sock) => { if (drop) { drop = false; sock.destroy(); } else f.answer(sock, { id: s.header.id, text: 'answered', lang: 'en' }); };
    const c = make();
    await c.transcribe(pcm(1), 'en', false); // the window's connection is open
    // the idle clock fires: the connection is closing, its socket not yet seen closed
    (c['conn'] as unknown as { close(): void }).close();
    // the next job opens a connection of its own; the host drops that job once, and its retry is still there
    drop = true;
    expect(await c.transcribe(pcm(1), 'en', false)).toEqual({ text: 'answered', lang: 'en' });
  });

  it('a host that never answers is dropped after the deadline (a death), and the job goes once more', async () => {
    const f = await FakeHost.start();
    let n = 0;
    f.on = (s, sock) => { if (++n > 1) f.answer(sock, { id: s.header.id, text: 'second host', lang: 'en' }); }; // the first job is never answered
    const c = make({ deadlineMs: () => 30 });
    expect(await c.transcribe(pcm(1), 'en', false)).toEqual({ text: 'second host', lang: 'en' });
    expect(f.socks[0]!.destroyed).toBe(true);
    expect(f.socks).toHaveLength(2);
  });

  it('a host that never answers twice is a lost host, and each silence counts: three send the window to its own model', async () => {
    const f = await FakeHost.start();
    const c = make({ deadlineMs: () => 20 });
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(HostLost); // deaths 1 and 2
    expect(reports).toEqual([]);
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(HostLost); // death 3: fallback
    expect(told()).toHaveLength(1);
    expect(told()[0]).toMatch(/did not answer in time/);
    expect(f.of('job')).toHaveLength(3);
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
  });

  it('the window waits as long as the host itself would: a model load, a model call, and a margin', () => {
    expect(clientDeadlineMs(16_000)).toBe(LOAD_DEADLINE_MS + jobDeadlineMs(16_000) + JOB_MARGIN_MS);
    expect(clientDeadlineMs(16_000 * 60)).toBeGreaterThan(jobDeadlineMs(16_000 * 60) + LOAD_DEADLINE_MS);
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
    await expect(p).rejects.toBeInstanceOf(ClientClosed); // our own close: the voice flow does not retry it either
    expect(f.of('job')).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  it('status() asks the running host', async () => {
    const f = await FakeHost.start();
    const c = make();
    expect(await c.status()).toEqual({ pid: 4242, loaded: true, queued: 3, running: false, clients: 0 }); // the connection it asks on is no window
    expect(c.connected()).toBe(false); // a short connection of its own
    await until(() => f.socks[0]!.destroyed); // and closed again at once
  });
});

describe('status()', () => {
  it('is a short connection of its own beside the window\'s: the window\'s idle close still comes on time, however often the host is asked', async () => {
    const f = await FakeHost.start();
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, text: 'x', lang: 'en' });
    const c = make({ idleMs: 150 });
    await c.transcribe(pcm(1), 'en', false);
    expect(c.connected()).toBe(true);
    const asked: Promise<unknown>[] = [];
    const poll = setInterval(() => asked.push(c.status()), 30);
    onTestFinished(() => clearInterval(poll)); // also when the test times out: no question goes on after it
    await until(() => !c.connected(), 3000); // asked on the window's own connection, it would have no idle close at all
    clearInterval(poll);
    expect((await Promise.all(asked)).every((h) => (h as { loaded: boolean }).loaded)).toBe(true);
    expect(f.socks.length).toBeGreaterThan(2);
    expect(reports).toEqual([]);
    expect(c.recentFailures()).toBe(0); // the idle close was ours
  });

  const nobody: [string, (f: FakeHost) => void][] = [
    ['a host that has all the windows it takes', (f) => { f.hello = { type: 'full' }; }],
    ['a host that does not answer hello', (f) => { f.gate = new Promise<void>(() => {}); }],
    ['a host that does not answer status', (f) => { f.onStatus = 'silent'; }],
    ['a host that closes the connection at hello', (f) => { f.dropHello = true; }],
    ['a host that closes the connection at the question', (f) => { f.onStatus = 'drop'; }],
    ['a host of another protocol', (f) => { f.hello = { ...f.hello, proto: HOST_PROTO + 1 }; }],
  ];
  for (const [name, set] of nobody) {
    it(`is null, not an error, for ${name}: no failure of the host is counted, nothing is told`, async () => {
      const f = await FakeHost.start();
      set(f);
      const c = make({ statusWaitMs: 150 });
      const t0 = Date.now();
      expect(await c.status()).toBeNull();
      expect(Date.now() - t0).toBeLessThan(2000); // a page that asks does not wait on it for long
      expect(c.recentFailures()).toBe(0);
      expect(reports).toEqual([]);
    });
  }

  it('a host that drops its connections to the questions is no death, however often: the window goes on using it', async () => {
    const f = await FakeHost.start();
    f.onStatus = 'drop';
    const c = make();
    for (let i = 0; i < BACKOFF_FAILURES + 1; i++) expect(await c.status()).toBeNull();
    f.onStatus = 'answer';
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, text: 'still here', lang: 'en' });
    expect(await c.transcribe(pcm(1), 'en', false)).toEqual({ text: 'still here', lang: 'en' }); // not sent to its own model
    expect(c.recentFailures()).toBe(0);
    expect(reports).toEqual([]);
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
  markReady(base);
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
/** A host script that dies at once, saying which process it was: a start that fails (the host.log of each start tells them apart). */
function badEntry(): string {
  const file = path.join(home, 'bad-entry.mjs');
  fs.writeFileSync(file, "console.error(`the cause ${process.pid}`); process.exit(1);\n");
  return file;
}
/** A host script that runs but never serves: a start that does not come up. */
function sleepyEntry(): string {
  const file = path.join(home, 'sleepy-entry.mjs');
  fs.writeFileSync(file, 'setInterval(() => {}, 1000);\n');
  return file;
}
const callCount = (): number => { try { return fs.readFileSync(calls(), 'utf8').length; } catch { return 0; } };

/** A socket file nobody listens on: its owner was killed without cleaning up. */
async function staleSocket(file: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => console.log("up"))', file], { stdio: ['ignore', 'pipe', 'inherit'] });
  strays.push(child);
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
    process.env.NB_TEST_SECRET = 'nope';
    const c = make();
    let got;
    try { got = await c.transcribe(pcm(1), 'en', false); } finally { delete process.env.NB_TEST_SECRET; }
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

describe('the spawn lock', { timeout: 30_000 }, () => {
  beforeEach(() => fakeInstall());
  const lockFile = (): string => path.join(hostDir(), 'spawn.lock');
  /** A lock held by this very process (alive, as a reused pid would be), with the modification time `at` (ms since the epoch). */
  const lock = (at: number, version = 'x'): void => {
    privateDir(hostDir());
    fs.writeFileSync(lockFile(), JSON.stringify({ version, pid: process.pid }));
    fs.utimesSync(lockFile(), new Date(at), new Date(at));
  };
  /** The longest age a live holder's lock may have for this client (see hostClient.ts). */
  const limit = (spawnWaitMs: number): number => spawnWaitMs + 2 * HELLO_WAIT_MS + LOCK_MARGIN_MS;

  it('a lock of a live pid that is older than a holder keeps it is nobody\'s: it is taken over', async () => {
    lock(0); // 1970: the clock of the client says how old it is, no wall-clock margin in this test
    const c = make({ spawnWaitMs: 500 });
    expect(text(await c.transcribe(pcm(1), 'en', false))[0]).toBe('1');
    expect(c.spawned).toBe(1);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('a lock that is not that old is a window starting the host: this one waits, and fails when it does not come up', async () => {
    const at = 1_000_000;
    lock(at);
    const c = make({ spawnWaitMs: 300, now: () => at + limit(300) - 1 }); // one millisecond short of the limit, by the client's clock
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(c.spawned).toBe(0);
    expect(fs.existsSync(lockFile())).toBe(true); // not ours: left as it was
  });

  it('the same lock, one millisecond older, is taken over', async () => {
    const at = 1_000_000;
    lock(at);
    const c = make({ spawnWaitMs: 300, now: () => at + limit(300) + 1 });
    expect(text(await c.transcribe(pcm(1), 'en', false))[0]).toBe('1');
    expect(c.spawned).toBe(1);
  });

  it('a lock that was taken over by another window while this one started its host is left to that window', async () => {
    const c = make();
    const real = fs.readdirSync;
    let taken = false;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((...a: Parameters<typeof real>) => {
      if (a[0] === hostDir() && !taken) { // the sweep: this window holds the lock; another one found it old and made its own
        taken = true;
        const mine = `${lockFile()}.other.tmp`;
        fs.writeFileSync(mine, JSON.stringify({ version: 'another window', pid: process.pid }));
        fs.renameSync(mine, lockFile());
      }
      return (real as (...x: unknown[]) => unknown)(...a);
    }) as typeof fs.readdirSync);
    expect(text(await c.transcribe(pcm(1), 'en', false))[0]).toBe('1');
    expect(taken).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ version: 'another window' }); // not deleted by us
  });
});

describe('closing the client', { timeout: 30_000 }, () => {
  it('ends a connect that is still under way: nothing is sent, nothing is kept', async () => {
    const f = await FakeHost.start();
    let open!: () => void;
    f.gate = new Promise<void>((resolve) => { open = resolve; }); // the host accepts, but does not say hello yet
    const c = make();
    const p = c.transcribe(pcm(1), 'en', false);
    p.catch(() => {});
    await until(() => f.socks.length === 1);
    c.close();
    open();
    await expect(p).rejects.toThrow('closed');
    await until(() => f.socks[0]!.destroyed);
    expect(c.connected()).toBe(false);
    expect(f.of('job')).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('ends the wait for a host that is starting (the host itself goes on)', async () => {
    fakeInstall();
    const c = make({ entry: sleepyEntry() });
    const p = c.transcribe(pcm(1), 'en', false);
    p.catch(() => {});
    await until(() => c.children.size === 1);
    c.close();
    await expect(p).rejects.toThrow('closed');
    expect(reports).toEqual([]); // a window closing is no failed start
    expect(c.spawned).toBe(1);
  });

  it('a retry that is under way does not go on', async () => {
    const f = await FakeHost.start();
    f.on = (_s, sock) => sock.destroy(); // drops every job
    const c = make();
    const closing = new Promise<void>((resolve) => {
      const was = f.on;
      f.on = (s, sock) => { was(s, sock); if (f.of('job').length === 1) { c.close(); resolve(); } }; // the window closes as the first job drops
    });
    const p = c.transcribe(pcm(1), 'en', false);
    p.catch(() => {});
    await closing;
    await expect(p).rejects.toThrow(/closed/);
    expect(f.of('job')).toHaveLength(1); // never sent a second time
  });

  it('a call whose host dropped it does not go on to the retry when the window closed in between', async () => {
    const f = await FakeHost.start();
    f.on = (_s, sock) => sock.destroy();
    const c = make({ now: () => 1_000_000 });
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(HostLost); // two deaths
    c.reportTo(() => c.close()); // the third is told to the window as the connection closes, and the window closes then
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toThrow('closed'); // not a lost host (the fallback it brought), not a retry
    expect(f.of('job')).toHaveLength(3);
  });

  it('a window that closes while it starts a host starts none (checked right before the spawn)', async () => {
    const c = make();
    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((...a: Parameters<typeof real>) => {
      if (a[0] === hostDir()) c.close(); // the sweep: the lock is held, nothing spawned yet
      return (real as (...x: unknown[]) => unknown)(...a);
    }) as typeof fs.readdirSync);
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(ClientClosed);
    expect(c.spawned).toBe(0);
    expect(c.children.size).toBe(0);
    expect(fs.existsSync(path.join(hostDir(), 'spawn.lock'))).toBe(false); // released
    expect(reports).toEqual([]);
  });

  it('a window that closes while it looks again for a host does not even sweep, let alone start one', async () => {
    const c = make();
    const real = net.connect;
    let dials = 0;
    vi.spyOn(net, 'connect').mockImplementation(((...a: Parameters<typeof real>) => {
      if (a[0] === hostSocketPath() && ++dials === 2) c.close(); // the second dial of the socket: the look under the lock
      return (real as (...x: unknown[]) => net.Socket)(...a);
    }) as typeof net.connect);
    const sweeps = vi.spyOn(fs, 'readdirSync');
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(ClientClosed);
    expect(dials).toBe(2);
    expect(sweeps.mock.calls.filter((a) => a[0] === hostDir())).toEqual([]);
    expect(c.spawned).toBe(0);
  });

  it('works again for calls made afterwards', async () => {
    const f = await FakeHost.start();
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, text: 'again', lang: 'en' });
    const c = make();
    await c.transcribe(pcm(1), 'en', false);
    c.close();
    expect(await c.transcribe(pcm(1), 'en', false)).toEqual({ text: 'again', lang: 'en' });
  });
});

describe('a host that cannot be had for a job that lost one', () => {
  it('is a lost host, not a job run in this process: the retry finds no host and cannot start one', async () => {
    const f = await FakeHost.start();
    f.on = (_s, sock) => { sock.destroy(); void f.stop(); }; // the host goes, socket and all
    const c = make({ entry: badEntry() });
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(HostLost);
    expect(c.spawned).toBe(1); // it tried
  });

  it('the same without a start to try (no host script): lost, not run here', async () => {
    const f = await FakeHost.start();
    f.on = (_s, sock) => { sock.destroy(); void f.stop(); };
    const c = make({ entry: path.join(home, 'no-such-host.js') });
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(HostLost);
    expect(c.spawned).toBe(0);
  });
});

describe('a host that idles out', { timeout: 30_000 }, () => {
  it('while this window asks it for its state all the time: its idle exit is no death, for the window\'s own connection closed long before', async () => {
    fakeInstall();
    vi.stubEnv('NOTA_BENE_TEST_WHISPER_IDLE_MS', '1200'); // put back to 60000 by the file's afterEach
    const c = make({ idleMs: 150 });
    const pid = Number(text(await c.transcribe(pcm(2), 'en', false))[2]);
    expect(c.connected()).toBe(true);
    const asked: Promise<unknown>[] = [];
    const poll = setInterval(() => asked.push(c.status()), 40);
    onTestFinished(() => clearInterval(poll));
    await until(() => !c.connected(), 3000); // the idle close came on time
    expect(alive(pid)).toBe(true);
    await until(() => !alive(pid), 15_000); // and the questions did not keep the host up: its idle clock counts jobs
    clearInterval(poll);
    await Promise.all(asked);
    expect(c.recentFailures()).toBe(0);
    expect(reports).toEqual([]);
    expect(await c.status()).toBeNull();
    expect(Number(text(await c.transcribe(pcm(1), 'en', false))[2])).not.toBe(pid); // the next job starts another
  });

  it('the short idle time of the test before is not left in the environment (the file\'s own is back, hosts started now idle out in a minute)', () => {
    expect(process.env.NOTA_BENE_TEST_WHISPER_IDLE_MS).toBe('60000');
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
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toThrow('could not transcribe it: the model failed'); // the model's own words
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
    expect(await c.shutdown('removed')).toEqual({ pid, gone: true, held: false });
    expect(fs.existsSync(hostSocketPath())).toBe(false);
    await until(() => !alive(pid));
    expect(await c.shutdown()).toBeNull();
    expect(c.connected()).toBe(false);
    expect(reports).toEqual([]); // a shutdown is not a death
    // the next job starts a new host
    expect(Number(text(await c.transcribe(pcm(1), 'en', false))[2])).not.toBe(pid);
  });
});

describe('stopHost() against real processes', { timeout: 30_000 }, () => {
  it('stops a running host: its socket name goes, the process ends, the jobs it had fail as `off`, and none of it is a death', async () => {
    fakeInstall({ blockFirst: true });
    const c = make();
    const first = c.transcribe(pcm(1), 'en', false);
    first.catch(() => {});
    await until(() => fs.existsSync(marker())); // the model is busy with the first
    const second = c.transcribe(pcm(2), 'en', false);
    second.catch(() => {});
    await until(async () => (await c.status())?.queued === 1);
    const { pid } = (await c.status())!;
    expect(await c.stopHost('removed')).toEqual({ pid, gone: true, held: false, signalled: false }); // it answered, so there was nothing to signal
    await expect(first).rejects.toBeInstanceOf(WhisperOff);
    await expect(second).rejects.toBeInstanceOf(WhisperOff);
    expect(fs.existsSync(hostSocketPath())).toBe(false);
    await until(() => !alive(pid), 15_000);
    expect(c.connected()).toBe(false);
    expect(c.recentFailures()).toBe(0);
    expect(reports).toEqual([]);
    expect(callCount()).toBe(1); // the second job never ran
  });

  it('a host that was asked from a window with no connection to it is stopped the same', async () => {
    fakeInstall();
    const a = make();
    const pid = Number(text(await a.transcribe(pcm(1), 'en', false))[2]);
    const b = make(); // another window: asks on a connection of its own
    expect(await b.stopHost('removed')).toEqual({ pid, gone: true, held: false, signalled: false });
    await until(() => !alive(pid), 15_000);
    await until(() => !a.connected()); // the host closed the first window's connection: to that window one death (three in a minute are needed)
    expect(a.recentFailures()).toBeLessThan(BACKOFF_FAILURES);
    expect(await a.stopHost()).toBeNull();
  });

  it('a host that keeps its socket name after the wait is ended by SIGTERM; its pid is the one it answered hello with', async () => {
    fakeInstall();
    privateDir(hostDir());
    const script = path.join(home, 'stubborn.mjs');
    // a host that greets and never stops: the shutdown message is ignored and the connection stays
    fs.writeFileSync(script, `import net from 'node:net';
const [, , wire, sock] = process.argv;
const { encodeFrame, FrameDecoder, HOST_PINS, HOST_PROTO } = await import(wire);
net.createServer((s) => {
  const d = new FrameDecoder();
  s.on('error', () => {});
  s.on('data', (b) => { for (const f of d.push(b)) if (f.header.type === 'hello') s.write(encodeFrame({ type: 'hello', proto: HOST_PROTO, pid: process.pid, pins: HOST_PINS, loaded: false, queued: 0 })); });
}).listen(sock, () => console.log('up'));
`);
    const child = spawn(process.execPath, [script, pathToFileURL(fileURLToPath(new URL('./hostWire.ts', import.meta.url))).href, hostSocketPath()], { stdio: ['ignore', 'pipe', 'inherit'] });
    strays.push(child);
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    const exited = new Promise<string | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    const c = make();
    expect(await c.stopHost('removed', 200)).toEqual({ pid: child.pid, gone: false, held: true, signalled: true });
    expect(await exited).toBe('SIGTERM');
    expect(reports).toEqual([]);
  });
});

describe('a host is started only for an install that is ready', { timeout: 30_000 }, () => {
  const unready = (): void => { fs.rmSync(path.join(home, 'whisper', 'ready.json')); };

  it('an install that is not ready (never installed, or Remove has begun) gets no host: Whisper off, nothing counted, no process, no log', async () => {
    fakeInstall();
    unready();
    const c = make();
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(WhisperOff);
    await expect(c.transcribe(pcm(1), 'en', false)).rejects.toBeInstanceOf(WhisperOff); // however often
    expect(c.spawned).toBe(0);
    expect(c.recentFailures()).toBe(0);
    expect(reports).toEqual([]);
    expect(fs.existsSync(path.join(hostDir(), 'host.log'))).toBe(false);
  });

  it('a job whose host died after Remove began is not retried on a new host: Whisper off, not a host lost, and no process is started', async () => {
    fakeInstall({ blockFirst: true });
    const c = make();
    const job = c.transcribe(pcm(1), 'en', false);
    job.catch(() => {});
    await until(() => fs.existsSync(marker())); // the model is on it
    const { pid } = (await c.status())!;
    unready(); // Remove has begun
    process.kill(pid, 'SIGKILL');
    await expect(job).rejects.toBeInstanceOf(WhisperOff); // the retry finds Whisper off
    expect(c.spawned).toBe(1);
    expect(callCount()).toBe(1);
    expect(c.recentFailures()).toBe(1); // the death itself is one; the refusal adds none
    await until(() => !alive(pid), 15_000);
  });
});

describe('a machine where the host cannot be started', { timeout: 60_000 }, () => {
  it('failed starts count: three within a minute send the window to its own model, told once', async () => {
    let t = 5_000_000;
    const c = make({ entry: badEntry(), now: () => t });
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
    const c = make({ entry: badEntry() });
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(reports).toEqual([]);
  });

  it('windows that fail to start together count one failure, not one each', async () => {
    const c = make({ entry: badEntry() });
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

describe('hosts that are not to be had', { timeout: 60_000 }, () => {
  it('an install with no host script has no host to start: in process, silently, and nothing is counted', async () => {
    const c = make({ entry: path.join(home, 'no-such-host.js') });
    for (let i = 0; i < BACKOFF_FAILURES + 2; i++) expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(c.spawned).toBe(0);
    expect(reports).toEqual([]);
    // no fallback episode either: a host that is there is used at once
    const f = await FakeHost.start();
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, text: 'there', lang: 'en' });
    expect(await c.transcribe(pcm(1), 'en', false)).toEqual({ text: 'there', lang: 'en' });
  });

  it('on a platform without unix sockets (win32) the window uses its own model, silently, and makes nothing', async () => {
    const was = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const c = make();
      expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
      expect(await c.status()).toBeNull();
      expect(await c.shutdown()).toBeNull();
      expect(c.spawned).toBe(0);
      expect(reports).toEqual([]);
      expect(fs.existsSync(hostDir())).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', was);
    }
  });

  it('a host that has all the windows it takes is no failed host: the job runs here, nothing is counted or told', async () => {
    const f = await FakeHost.start();
    const open = f.hello;
    f.hello = { type: 'full' };
    const c = make();
    for (let i = 0; i < BACKOFF_FAILURES + 2; i++) expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(reports).toEqual([]);
    expect(c.spawned).toBe(0);
    f.hello = open; // a window left: there is room, and the host is used
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, text: 'room', lang: 'en' });
    expect(await c.transcribe(pcm(1), 'en', false)).toEqual({ text: 'room', lang: 'en' });
  });

  it('a host that does not come up in time is a failed start, and the process that did not is ended', async () => {
    const c = make({ entry: sleepyEntry(), spawnWaitMs: 300 });
    const p = c.transcribe(pcm(1), 'en', false);
    await until(() => c.children.size === 1);
    const child = [...c.children][0]!;
    expect(await p).toBeNull();
    await until(() => child.signalCode !== null || child.exitCode !== null);
    expect(child.signalCode).toBe('SIGTERM');
    expect(c.spawned).toBe(1);
    expect(fs.existsSync(path.join(hostDir(), 'spawn.lock'))).toBe(false);
  });

  it('each start keeps the log of the one before, so that the cause of a failed start survives the next', async () => {
    const c = make({ entry: badEntry() });
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    const log = path.join(hostDir(), 'host.log');
    const first = fs.readFileSync(log, 'utf8');
    expect(first).toMatch(/the cause \d+/);
    expect(await c.transcribe(pcm(1), 'en', false)).toBeNull();
    expect(fs.readFileSync(`${log}.1`, 'utf8')).toBe(first);
    expect(fs.readFileSync(log, 'utf8')).toMatch(/the cause \d+/);
    expect(fs.readFileSync(log, 'utf8')).not.toBe(first); // another process, another pid
    expect(fs.statSync(`${log}.1`).mode & 0o777).toBe(0o600);
  });
});

describe('the home', () => {
  it('is this file\'s own for the default client too: nothing here can reach the real one', () => {
    sandboxed();
    expect(hostSocketPath().startsWith(home)).toBe(true);
    expect(hostDir().startsWith('/tmp/nbw-')).toBe(true);
  });
});

describe('the HTTP route', { timeout: 30_000 }, () => {
  let web: http.Server | undefined;
  // a request a failed test left waiting must not hold the server open: this hook ends, and the outer one then ends the hosts
  afterEach(async () => { await new Promise<void>((done) => { if (web) { web.close(() => done()); web.closeAllConnections(); } else done(); }); web = undefined; });

  /** The dictation route over a client of this test (the scripted host answers on the socket path); `host` is what Remove and GET ask. */
  async function serve(c: HostClient, host: Pick<HostClient, 'status' | 'stopHost'> = c): Promise<string> {
    const routes = dictationRoutes({ hub: new EventHub(), host, transcribe: async (p, lang, detect, signal) => (await c.transcribe(p, lang, detect === true, signal)) ?? { text: 'in process', lang } });
    web = http.createServer(((req, res) => routes[req.url!.split('?')[0]!]!(req, res)) as RequestListener);
    await new Promise<void>((done) => web!.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  }
  /** Whisper is on and installed, as the route checks. */
  const on = (): void => {
    markReady(home);
    setWhisperPref(true);
  };

  it('a client that hangs up while the host has its job: the host is told to cancel it', async () => {
    on();
    const f = await FakeHost.start();
    const base = await serve(make());
    const ac = new AbortController();
    const sent = fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(makeWav()), signal: ac.signal });
    sent.catch(() => {});
    const job = await f.next('job');
    ac.abort();
    expect((await f.next('cancel')).header).toEqual({ type: 'cancel', id: job.header.id });
  });

  it('a full host queue is a 503 {error: busy}', async () => {
    on();
    const f = await FakeHost.start();
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, error: 'busy' });
    const base = await serve(make());
    const r = await fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(makeWav()) });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'busy' });
  });

  it('a host that answers answers the route', async () => {
    on();
    const f = await FakeHost.start();
    f.on = (s, sock) => f.answer(sock, { id: s.header.id, text: 'from the host', lang: 'en' });
    const base = await serve(make());
    const r = await fetch(`${base}/dictation/transcribe?lang=en`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(makeWav()) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: 'from the host', lang: 'en' });
  });

  it('GET /dictation says `host: null` with no host running, and what the host says of itself with one', async () => {
    const c = make();
    const base = await serve(c);
    expect((await (await fetch(`${base}/dictation`)).json() as { host: unknown }).host).toBeNull();
    expect(fs.existsSync(hostDir())).toBe(false); // asking starts nothing and makes nothing
    await FakeHost.start();
    expect((await (await fetch(`${base}/dictation`)).json() as { host: unknown }).host).toEqual({ loaded: true, queued: 3, running: false });
  });

  it('GET /dictation is still a 200 with `host: null` for a host that does not answer, and does not wait on it for long', async () => {
    const f = await FakeHost.start();
    f.gate = new Promise<void>(() => {}); // never says hello
    const base = await serve(make({ statusWaitMs: 150 }));
    const t0 = Date.now();
    const r = await fetch(`${base}/dictation`);
    expect(r.status).toBe(200);
    expect((await r.json() as { host: unknown }).host).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('Remove with no host running is what it was: the install is deleted, Whisper is off, and nothing of the host is made', async () => {
    fakeInstall();
    on();
    const base = await serve(make());
    const r = await fetch(`${base}/dictation/remove`, { method: 'POST' });
    expect([r.status, await r.json()]).toEqual([200, { ok: true }]);
    expect(fs.existsSync(path.join(home, 'whisper'))).toBe(false);
    expect(readPrefs().whisper).toBe(false);
    expect(fs.existsSync(hostDir())).toBe(false);
    expect(reports).toEqual([]);
  });

  it('Remove makes Whisper off and not ready first, then stops a running host (gone, with its socket name) before it deletes the install', async () => {
    fakeInstall();
    on();
    const c = make();
    let seen: { stopped: boolean; readyThere: boolean; modelThere: boolean; on: boolean | undefined } | undefined;
    const base = await serve(c, {
      status: () => c.status(),
      stopHost: async (reason, waitMs) => {
        const r = await c.stopHost(reason, waitMs);
        seen = { stopped: !fs.existsSync(hostSocketPath()), readyThere: fs.existsSync(path.join(home, 'whisper', 'ready.json')), modelThere: fs.existsSync(path.join(home, 'whisper', 'node_modules')), on: readPrefs().whisper };
        return r;
      },
    });
    const pid = Number(text(await c.transcribe(pcm(1), 'en', false))[2]);
    expect(alive(pid)).toBe(true);
    const r = await fetch(`${base}/dictation/remove`, { method: 'POST' });
    expect([r.status, await r.json()]).toEqual([200, { ok: true }]);
    expect(seen).toEqual({ stopped: true, readyThere: false, modelThere: true, on: false }); // the files are still there; the install no longer says ready
    expect(fs.existsSync(path.join(home, 'whisper'))).toBe(false);
    expect(readPrefs().whisper).toBe(false);
    await until(() => !alive(pid), 15_000);
    expect(c.connected()).toBe(false);
    expect(reports).toEqual([]); // told nothing: the host's close was asked for
    expect(c.spawned).toBe(1);
  });

  it('a dictation that reaches the client after Remove has stopped the host is refused: no new host is started from the install being removed', async () => {
    fakeInstall();
    on();
    const c = make();
    let late: unknown;
    let lateStatus = 0;
    let base = '';
    base = await serve(c, {
      status: () => c.status(),
      stopHost: async (reason, waitMs) => {
        const r = await c.stopHost(reason, waitMs); // the host is gone, the install is still on disk
        late = await c.transcribe(pcm(1), 'en', false).then(() => 'served', (e: unknown) => e); // a job that was past its gate
        lateStatus = (await fetch(`${base}/dictation/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(makeWav()) })).status; // and one that is not
        return r;
      },
    });
    await c.transcribe(pcm(1), 'en', false);
    expect(c.spawned).toBe(1);
    expect((await fetch(`${base}/dictation/remove`, { method: 'POST' })).status).toBe(200);
    expect(late).toBeInstanceOf(WhisperOff);
    expect(lateStatus).toBe(503);
    expect(c.spawned).toBe(1);
    expect(c.recentFailures()).toBe(0);
    expect(reports).toEqual([]);
    expect(fs.existsSync(path.join(home, 'whisper'))).toBe(false);
  });

  it('a dictation that waits at the host when Remove comes is answered 503 `dictation is off`', async () => {
    fakeInstall({ blockFirst: true });
    on();
    const c = make();
    const base = await serve(c);
    const waiting = fetch(`${base}/dictation/transcribe?lang=en`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(makeWav()) });
    await until(() => fs.existsSync(marker())); // the model is on it
    const { pid } = (await c.status())!;
    expect((await fetch(`${base}/dictation/remove`, { method: 'POST' })).status).toBe(200);
    const r = await waiting;
    expect([r.status, await r.json()]).toEqual([503, { error: 'dictation is off' }]);
    await until(() => !alive(pid), 15_000);
  });
});

describe('transcribe(), the way the routes call it', { timeout: 30_000 }, () => {
  beforeEach(() => {
    resetTranscriber();
    hostClient.reportTo((where, e) => { reports.push([where, e]); });
  });
  afterEach(() => {
    hostClient.close();
    resetTranscriber();
  });

  it('goes through the host: the model is in the host\'s process, not in this one', async () => {
    fakeInstall();
    const got = await transcribe(pcm(6), 'ru');
    expect(text(got).slice(0, 2)).toEqual(['6', 'ru']);
    expect(Number(text(got)[2])).not.toBe(process.pid);
    expect(hostClient.connected()).toBe(true);
  });

  it('runs the model in this process when the host cannot be used, with the same answer', async () => {
    const long = path.join('/tmp', `nbw-${'x'.repeat(100)}`);
    fakeInstall({}, long);
    try {
      vi.stubEnv('NOTA_BENE_HOME', long);
      const got = await transcribe(pcm(6), 'ru');
      expect(text(got).slice(0, 2)).toEqual(['6', 'ru']);
      expect(Number(text(got)[2])).toBe(process.pid);
      expect(told()).toHaveLength(1);
      expect(told()[0]).toMatch(/too long/);
    } finally {
      resetTranscriber();
      fs.rmSync(long, { recursive: true, force: true });
    }
  });

  it('a model this window loaded for itself (a failed start) is disposed once the host answers again', async () => {
    fakeInstall();
    let disposed = 0;
    await transcribe(pcm(1), 'en', { load: async () => Object.assign(async () => ({ text: 'mine' }), { dispose: async () => { disposed++; } }) });
    expect(disposed).toBe(0);
    expect(text(await transcribe(pcm(6), 'ru'))[0]).toBe('6'); // the host
    await until(() => disposed === 1);
  });

  it('a test\'s own loader never goes near the host', async () => {
    const before = hostClient.spawned;
    expect(await transcribe(pcm(2), 'en', { load: async () => async () => ({ text: 'mine' }) })).toEqual({ text: 'mine', lang: 'en' });
    expect(hostClient.spawned).toBe(before);
    expect(hostClient.connected()).toBe(false);
  });
});
