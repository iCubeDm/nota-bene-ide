// The window's side of the Whisper host (hostMain.ts): one connection to the host's unix socket, jobs multiplexed by id, the host
// started on demand by whichever window needs it first. A window that cannot use a host (its socket path does not fit, its
// folder is not ours, the host keeps dying) answers `null` and transcribe.ts runs the model in its own process instead.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeLockFile } from '../runtime.ts';
import { encodeFrame, FrameDecoder, HOST_PINS, HOST_PROTO, hostDir, hostSocketPath, pcmToInt16, privateDir, WireError, type Header, type JobOpts } from './hostWire.ts';
import type { Spoken } from './speak.ts';

/** A connection that has no job for this long is closed: a host nobody talks to is not kept awake by an idle window. */
export const IDLE_CLOSE_MS = 60_000;
/** How long a window waits for a host it started (or another window is starting) to answer on its socket. */
export const SPAWN_WAIT_MS = 10_000;
/** How long a host that accepted the connection gets to answer `hello`. */
export const HELLO_WAIT_MS = 5000;
/** This many deaths or failed starts within BACKOFF_WINDOW_MS send the window to its own model for FALLBACK_MS. */
export const BACKOFF_FAILURES = 3;
export const BACKOFF_WINDOW_MS = 60_000;
export const FALLBACK_MS = 5 * 60_000;
/** How often a window looks at the socket of a host that is starting. */
const POLL_MS = 25;

/** The host's queue is full: the caller says so (HTTP 503 `busy`, a voice message `failed`) and does not retry at once. */
export class WhisperBusy extends Error {}
/** Whisper was removed while the job waited. */
export class WhisperOff extends Error {}
/** The connection ended before the job was answered: the host died, stopped, or was cut off. The client retries once. */
class HostDropped extends Error {}

export type HostInfo = { pid: number; loaded: boolean; queued: number; running: boolean; clients: number };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Nobody answers there: no socket, a socket file nobody listens on, a file that is not a socket (the host replaces those). */
const absent = (e: unknown): boolean => ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes((e as NodeJS.ErrnoException).code ?? '');

const dial = (socketPath: string): Promise<net.Socket> => new Promise((resolve, reject) => {
  const s = net.connect(socketPath);
  s.once('connect', () => { s.off('error', reject); s.on('error', () => {}); resolve(s); });
  s.once('error', reject);
});

/** Is something listening on `socketPath`? */
const answering = (socketPath: string): Promise<boolean> => dial(socketPath).then((s) => { s.destroy(); return true; }, () => false);

/** Rejects with the signal's reason as soon as it aborts; `p`'s own late failure is handled here, not left unhandled. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { p.catch(() => {}); return reject(signal.reason); }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** The environment of a host: what it needs and nothing else (it is long-lived and detached; it never sees a window's secrets). */
function hostEnv(): NodeJS.ProcessEnv {
  // the last one shortens the host's idle time (tests and smoke runs only; hostMain.ts main())
  const keep = ['PATH', 'HOME', 'TMPDIR', 'NOTA_BENE_HOME', 'NOTA_BENE_TEST_WHISPER_IDLE_MS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
}

/** The host's entry: hostEntry.ts beside this file in a checkout, host.js beside the bundle in the package. */
export function hostEntryFile(): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), here.endsWith('.ts') ? 'hostEntry.ts' : 'host.js');
}

/** Temp sockets (`.xxxxxxxx.sock`) that a host killed between bind and rename left behind; one that still answers is a host starting. */
async function sweepTempSockets(dir: string): Promise<void> {
  for (const name of fs.readdirSync(dir)) {
    if (!/^\.[0-9a-f]{8}\.sock$/.test(name)) continue;
    const file = path.join(dir, name);
    if (!await answering(file)) fs.rmSync(file, { force: true });
  }
}

type Waiter<T> = { resolve: (v: T) => void; reject: (e: Error) => void };
type ConnOptions = { idleMs: number; onClose: (c: HostConn, unexpected: boolean) => void };

/** One connection to the host, after `hello`. */
class HostConn {
  /** The host's pid, from `hello`. */
  pid = 0;
  closed = false;
  /** Resolves when the connection has ended. */
  readonly ended: Promise<void>;
  private readonly sock: net.Socket;
  private readonly o: ConnOptions;
  private ready = false;
  private expected = false;
  private nextId = 0;
  private readonly jobs = new Map<number, Waiter<Spoken>>();
  private hello: Waiter<Header> | undefined;
  private readonly statuses: Waiter<Header>[] = [];
  private idle: NodeJS.Timeout | undefined;

  private constructor(sock: net.Socket, o: ConnOptions) {
    this.sock = sock;
    this.o = o;
    const decoder = new FrameDecoder();
    this.ended = new Promise((resolve) => sock.once('close', () => resolve()));
    sock.on('data', (d: Buffer) => {
      try { for (const f of decoder.push(d)) this.reply(f.header); } catch { sock.destroy(); }
    });
    sock.on('close', () => this.gone());
  }

  /** Connects to the host on `socketPath` and says hello. Throws the connect error (ENOENT, ECONNREFUSED: nobody there) or a wrong answer. */
  static async open(socketPath: string, o: ConnOptions): Promise<HostConn> {
    const c = new HostConn(await dial(socketPath), o);
    try {
      const h = await c.greet();
      if (h.proto !== HOST_PROTO || h.pins !== HOST_PINS || !Number.isSafeInteger(h.pid)) throw new Error('the Whisper host speaks another protocol');
      c.pid = h.pid as number;
    } catch (e) {
      c.close();
      throw e;
    }
    c.ready = true;
    c.rest();
    return c;
  }

  private greet(): Promise<Header> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the Whisper host did not answer hello')), HELLO_WAIT_MS);
      this.hello = { resolve: (h) => { clearTimeout(timer); resolve(h); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      this.send({ type: 'hello', proto: HOST_PROTO });
    });
  }

  /** Sends one job. The answer, or why there is none: WhisperBusy, WhisperOff, HostDropped, an Error for `failed`, the signal's reason. */
  job(body: Uint8Array, opts: JobOpts, signal?: AbortSignal): Promise<Spoken> {
    if (this.closed) return Promise.reject(new HostDropped());
    const id = this.nextId++;
    const frame = encodeFrame({ type: 'job', id, opts }, body); // a WireError (too large) before anything is registered or sent
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.jobs.delete(id)) return;
        this.send({ type: 'cancel', id }); // the host answers `cancelled` to a job nobody waits for now: ignored
        reject(signal!.reason);
        this.rest();
      };
      const unlisten = <T>(f: (v: T) => void) => (v: T) => { signal?.removeEventListener('abort', onAbort); f(v); };
      this.jobs.set(id, { resolve: unlisten(resolve), reject: unlisten(reject) });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.clearIdle();
      this.sock.write(frame);
    });
  }

  /** The host's `status` answer. */
  status(): Promise<Header> {
    return new Promise((resolve, reject) => {
      this.clearIdle();
      this.statuses.push({ resolve, reject });
      this.send({ type: 'status' });
    });
  }

  /** Asks the host to stop (the close that follows is expected, not a death). */
  shutdown(reason: string): void {
    this.expected = true;
    this.send({ type: 'shutdown', reason });
  }

  /** Ends the connection from this side: jobs still waiting fail (not retried). */
  close(): void {
    this.expected = true;
    this.clearIdle();
    this.fail(new Error('the Whisper host connection was closed'));
    this.sock.destroy();
  }

  /** The close that is not ours to expect counts as a death. */
  expectClose(): void { this.expected = true; }

  private send(h: Header): void {
    if (!this.sock.destroyed) this.sock.write(encodeFrame(h));
  }

  private clearIdle(): void {
    clearTimeout(this.idle);
    this.idle = undefined;
  }

  /** With nothing waiting for the host the connection is closed after IDLE_CLOSE_MS. */
  private rest(): void {
    this.clearIdle();
    if (this.closed || this.jobs.size > 0 || this.statuses.length > 0) return;
    this.idle = setTimeout(() => this.close(), this.o.idleMs);
    this.idle.unref();
  }

  private reply(h: Header): void {
    if (h.type === 'hello') {
      const w = this.hello;
      this.hello = undefined;
      return w?.resolve(h);
    }
    if (h.type === 'status') {
      const w = this.statuses.shift();
      w?.resolve(h);
      return this.rest();
    }
    if (typeof h.id !== 'number') return;
    const job = this.jobs.get(h.id);
    if (!job) return; // cancelled here, or never ours
    this.jobs.delete(h.id);
    if (typeof h.text === 'string' && typeof h.lang === 'string') job.resolve({ text: h.text, lang: h.lang });
    else if (h.error === 'busy') job.reject(new WhisperBusy('Whisper is busy'));
    else if (h.error === 'off') job.reject(new WhisperOff('Whisper is off'));
    else job.reject(new Error(`the Whisper host could not transcribe it (${typeof h.error === 'string' ? h.error : 'bad answer'})`));
    this.rest();
  }

  /** Fails everything waiting. */
  private fail(e: Error): void {
    this.hello?.reject(e);
    this.hello = undefined;
    for (const w of this.statuses.splice(0)) w.reject(e);
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    for (const w of jobs) w.reject(e);
  }

  private gone(): void {
    this.closed = true;
    this.clearIdle();
    this.fail(new HostDropped('the Whisper host closed the connection'));
    if (this.ready) this.o.onClose(this, !this.expected);
  }
}

export type HostClientOptions = {
  /** Idle time before a connection with no job is closed (default IDLE_CLOSE_MS). */
  idleMs?: number;
  now?: () => number;
  /** The script a host is started from (default hostEntryFile(); a test starts one that fails). */
  entry?: string;
  /** Where problems are told: `reportError` of the window's hub (the server sets it); default the console. */
  report?: (where: string, e: unknown) => void;
};

/**
 * What a window uses to transcribe through the host: connects (starting the host when nobody listens), sends jobs, retries a job
 * whose connection dropped once on a fresh host, and counts the host's deaths and failed starts: three within a minute send the
 * window to its own model for five minutes.
 */
export class HostClient {
  /** Host processes this client has started. */
  spawned = 0;
  private conn: HostConn | undefined;
  private connecting: Promise<HostConn> | undefined;
  private failures: number[] = [];
  private fallbackUntil = 0;
  private told: string | undefined;
  private readonly o: Required<Pick<HostClientOptions, 'idleMs' | 'now'>> & HostClientOptions;

  constructor(o: HostClientOptions = {}) {
    this.o = { idleMs: IDLE_CLOSE_MS, now: Date.now, ...o };
  }

  /** Where problems are told from now on. */
  reportTo(report: (where: string, e: unknown) => void): void { this.o.report = report; }

  /** Is a connection to a host open? */
  connected(): boolean { return this.conn !== undefined && !this.conn.closed; }

  /**
   * `pcm` as text through the host. Answers null when this window should transcribe in its own process: the host cannot be used
   * (see the class), could not be started, or the job is too large for a frame. Rejects with WhisperBusy (the host's queue is
   * full), WhisperOff, an Error when the host failed the job or died twice under it, or the signal's reason once `signal` aborts:
   * a job still waiting then is cancelled at the host.
   */
  async transcribe(pcm: Float32Array, lang: string, detect: boolean, signal?: AbortSignal): Promise<Spoken | null> {
    signal?.throwIfAborted();
    const body = pcmToInt16(pcm);
    for (let attempt = 0; ; attempt++) {
      const socketPath = this.inFallback() ? undefined : this.place();
      if (!socketPath) return null;
      let conn: HostConn;
      try {
        conn = await abortable(this.connect(socketPath), signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        return null; // counted by connect(): this job runs here
      }
      try {
        return await conn.job(body, { lang, detect }, signal);
      } catch (e) {
        if (e instanceof WireError) return null;
        if (!(e instanceof HostDropped)) throw e;
        signal?.throwIfAborted();
        // the host went while it had the job: once more on a fresh one (three of those within a minute stop the retries: fallback)
        if (attempt > 0) throw new Error('the Whisper host stopped before it answered');
      }
    }
  }

  /** The running host's state, or null when there is none (never starts one). */
  async status(): Promise<HostInfo | null> {
    const socketPath = this.place(false);
    if (!socketPath) return null;
    const own = this.connected() ? this.conn : undefined;
    let c: HostConn | undefined = own;
    try {
      c ??= await HostConn.open(socketPath, { idleMs: this.o.idleMs, onClose: () => {} });
    } catch (e) {
      if (absent(e)) return null;
      throw e;
    }
    try {
      const h = await c.status();
      if (typeof h.loaded !== 'boolean' || typeof h.running !== 'boolean' || typeof h.queued !== 'number' || typeof h.clients !== 'number') throw new Error('the Whisper host sent a bad status');
      return { pid: c.pid, loaded: h.loaded, queued: h.queued, running: h.running, clients: h.clients };
    } catch (e) {
      if (e instanceof HostDropped) return null; // it went while we asked
      throw e;
    } finally {
      if (c !== own) c.close();
    }
  }

  /**
   * Tells the running host to stop (Remove does this before it deletes the install) and waits up to `waitMs` for it to end.
   * Null when no host was running; else its pid and whether its socket name is gone, so that the caller can end a host that
   * is not (SIGTERM to the pid) before it goes on.
   */
  async shutdown(reason = 'shutdown', waitMs = 5000): Promise<{ pid: number; gone: boolean } | null> {
    const socketPath = this.place(false);
    if (!socketPath) return null;
    this.conn?.expectClose(); // the host closes every connection: ours is no death
    let c: HostConn;
    try {
      c = await HostConn.open(socketPath, { idleMs: this.o.idleMs, onClose: () => {} });
    } catch (e) {
      if (absent(e)) return null;
      throw e;
    }
    c.shutdown(reason);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([c.ended, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
    c.close();
    return { pid: c.pid, gone: !fs.existsSync(socketPath) };
  }

  /** Closes the connection (the window is closing): the host drops this window's jobs. The counters stay. */
  close(): void {
    this.conn?.close();
    this.conn = undefined;
  }

  private inFallback(): boolean { return this.o.now() < this.fallbackUntil; }

  /**
   * The host's socket, in a folder that is ours before a connection is made (made if need be, unless `create` is false: only
   * looking for a host); undefined (and said once) on a machine where that cannot be.
   */
  private place(create = true): string | undefined {
    try {
      const socketPath = hostSocketPath();
      if (!this.connected() && (create || fs.existsSync(hostDir()))) privateDir(hostDir());
      return socketPath;
    } catch (e) {
      const text = message(e);
      if (this.told !== text) {
        this.told = text;
        this.report('whisper-host', new Error(`${text}; this window transcribes on its own`));
      }
      return undefined;
    }
  }

  private report(where: string, e: unknown): void {
    (this.o.report ?? ((w, x) => console.error(`[${w}]`, x)))(where, e);
  }

  /** The connection, made when there is none; one attempt at a time. A failure is counted once, whoever waited. */
  private connect(socketPath: string): Promise<HostConn> {
    if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
    this.connecting ??= (async () => {
      try {
        return this.conn = await this.open(socketPath);
      } catch (e) {
        this.fail(e);
        throw e;
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  private async open(socketPath: string): Promise<HostConn> {
    return await this.dialHost(socketPath) ?? await this.start(socketPath);
  }

  /** A connection to the host on the socket, or undefined when nobody answers there. */
  private async dialHost(socketPath: string): Promise<HostConn | undefined> {
    try {
      return await HostConn.open(socketPath, {
        idleMs: this.o.idleMs,
        onClose: (c, unexpected) => {
          if (this.conn === c) this.conn = undefined;
          if (unexpected) this.fail(new Error('the Whisper host went away'));
        },
      });
    } catch (e) {
      if (absent(e)) return undefined;
      throw e;
    }
  }

  /**
   * Nobody answers: start a host, under the spawn lock so that windows that find the socket dead together start one. The one
   * that holds the lock starts it; the others wait for its socket.
   */
  private async start(socketPath: string): Promise<HostConn> {
    const dir = hostDir();
    const lock = path.join(dir, 'spawn.lock');
    const until = Date.now() + SPAWN_WAIT_MS;
    while (!takeLockFile(lock, 'whisper-host')) {
      const c = await this.dialHost(socketPath);
      if (c) return c;
      if (Date.now() >= until) throw new Error('another window is starting the Whisper host and it did not come up');
      await sleep(POLL_MS);
    }
    try {
      const c = await this.dialHost(socketPath); // the holder before us may have started it
      if (c) return c;
      await sweepTempSockets(dir);
      return await this.spawnHost(socketPath, dir);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  /** Starts a host (detached, its output in <dir>/host.log, truncated) and waits for its socket to answer. */
  private async spawnHost(socketPath: string, dir: string): Promise<HostConn> {
    const log = fs.openSync(path.join(dir, 'host.log'), 'w', 0o600);
    let child: ChildProcess;
    let over = '';
    try {
      fs.fchmodSync(log, 0o600);
      child = spawn(process.execPath, [this.o.entry ?? hostEntryFile()], { detached: true, stdio: ['ignore', log, log], env: hostEnv(), cwd: dir });
    } finally {
      fs.closeSync(log);
    }
    this.spawned++;
    child.on('error', (e) => { over = `could not be started: ${e.message}`; });
    child.on('exit', (code, signal) => { over = `exited at startup (${signal ?? code}), see ${path.join(dir, 'host.log')}`; });
    child.unref();
    const until = Date.now() + SPAWN_WAIT_MS;
    for (;;) {
      const dead = over; // read before the dial: a host that exited by then (it found another one serving) leaves that one to dial
      const c = await this.dialHost(socketPath);
      if (c) return c;
      if (dead) throw new Error(`the Whisper host ${dead}`);
      if (Date.now() >= until) {
        child.kill();
        throw new Error('the Whisper host did not come up in time');
      }
      await sleep(POLL_MS);
    }
  }

  /** A death or a failed start. Enough of them in a short time and this window stops trying a host for a while. */
  private fail(e: unknown): void {
    const t = this.o.now();
    this.failures = this.failures.filter((at) => t - at < BACKOFF_WINDOW_MS);
    this.failures.push(t);
    if (this.failures.length < BACKOFF_FAILURES) return;
    this.failures = [];
    this.fallbackUntil = t + FALLBACK_MS;
    this.report('whisper-host', new Error(`the Whisper host failed ${BACKOFF_FAILURES} times within a minute (last: ${message(e)}); this window transcribes on its own for ${FALLBACK_MS / 60_000} minutes`));
  }
}

/** The window's client: transcribe.ts goes through it. */
export const hostClient = new HostClient();
