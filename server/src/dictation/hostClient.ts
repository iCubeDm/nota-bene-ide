// The window's side of the Whisper host (hostMain.ts): one connection to the host's unix socket (a named pipe on Windows), jobs
// multiplexed by id, the host started on demand by whichever window needs it first. A window that cannot use a host (its socket
// path does not fit, its folder or secret is not ours, the host keeps dying) answers `null` and transcribe.ts runs the model in
// its own process instead.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIDDEN, killTree, renameRetry } from '../platform.ts';
import { takeLockFile } from '../runtime.ts';
import { whisperPhase } from './install.ts';
import {
  encodeFrame, FrameDecoder, helloProof, HOST_PINS, HOST_PROTO, hostDir, hostSecret, hostSocketPath, isPipePath, jobDeadlineMs, LOAD_DEADLINE_MS, newNonce,
  pcmToInt16, privateDir, proofMatches, WireError, type Header, type JobOpts,
} from './hostWire.ts';
import type { Spoken } from './speak.ts';

/** A connection that has no job for this long is closed: a host nobody talks to is not kept awake by an idle window. */
export const IDLE_CLOSE_MS = 60_000;
/** How long a window waits for a host it started (or another window is starting) to answer on its socket. */
export const SPAWN_WAIT_MS = 10_000;
/** What a window waits for the answer to a job beyond the host's own limits (a model load and a model call) before it takes the host for dead. */
export const JOB_MARGIN_MS = 30_000;
/** How long a host that accepted the connection gets to answer `hello`. */
export const HELLO_WAIT_MS = 5000;
/** How long `status()` waits for a host, hello and status together: a page that asks for it must not wait on a host that does not answer. */
export const STATUS_WAIT_MS = 2000;
/** This many deaths or failed starts within BACKOFF_WINDOW_MS send the window to its own model for FALLBACK_MS. */
export const BACKOFF_FAILURES = 3;
export const BACKOFF_WINDOW_MS = 60_000;
export const FALLBACK_MS = 5 * 60_000;
/**
 * A spawn lock older than this is nobody's, whatever its pid says (a pid that is somebody else's now): the longest a live holder
 * keeps it is a hello, the start-up wait and a hello (see `start`), and a margin for a clock that jumped (a machine that slept).
 */
export const LOCK_MARGIN_MS = 5000;
/** How often a window looks at the socket of a host that is starting. */
const POLL_MS = 25;

/** The host's queue is full: the caller says so (HTTP 503 `busy`, a voice message `failed`) and does not retry at once. */
export class WhisperBusy extends Error {}
/** Whisper was removed while the job waited. */
export class WhisperOff extends Error {}
/**
 * The host stopped under the job (and under its one retry, or nothing could take the retry). Such a job is never run in this
 * process: whatever took the host down may be the clip itself, and a native crash here would take the window with it.
 */
export class HostLost extends Error {
  constructor() { super('the Whisper host stopped before it answered'); }
}
/** The connection ended before the job was answered: the host died, stopped, or was cut off. The client retries once. */
class HostDropped extends Error {}
/** The host has all the windows it takes (`full`): this window uses its own model for the job, which is no failure of the host. */
class HostFull extends Error {}
/** There is nothing to start a host from (no `host.js` in this install): in-process, silently. */
class NoHost extends Error {}
/** The client was closed (the window is going away) while the call was under way: not retried, by the client or by the voice flow. */
export class ClientClosed extends Error {
  constructor() { super('the Whisper host client was closed'); }
}

/** How long a window waits for the answer to a job of `samples`. */
export const clientDeadlineMs = (samples: number): number => LOAD_DEADLINE_MS + jobDeadlineMs(samples) + JOB_MARGIN_MS;

/** What `stopHost` did to a host (see there); `next` is a second host that took the socket name. */
export type StopResult = { pid: number; gone: boolean; held: boolean; signalled: boolean; next?: StopResult };

/** What a host says about itself; `clients` is the windows connected to it, not the connection the question came in on. */
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
  // the last one shortens the host's idle time (tests and smoke runs only; hostMain.ts main()). Windows: the system folder (Node
  // and its crypto need it), the profile (os.homedir(), so the host finds the same state base and pipe name) and the temp folders.
  const keep = ['PATH', 'HOME', 'TMPDIR', 'NOTA_BENE_HOME', 'NOTA_BENE_TEST_WHISPER_IDLE_MS',
    ...(process.platform === 'win32' ? ['SystemRoot', 'windir', 'USERPROFILE', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA'] : [])];
  return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
}

/** The host's entry: hostEntry.ts beside this file in a checkout, host.js beside the bundle in the package. */
export function hostEntryFile(): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), here.endsWith('.ts') ? 'hostEntry.ts' : 'host.js');
}

/** Temp sockets (`.xxxxxxxx.sock`) that a host killed between bind and rename left behind; one that still answers is a host starting.
 * (A host on a Windows pipe binds its name directly and leaves none.) */
async function sweepTempSockets(dir: string): Promise<void> {
  for (const name of fs.readdirSync(dir)) {
    if (!/^\.[0-9a-f]{8}\.sock$/.test(name)) continue;
    const file = path.join(dir, name);
    if (!await answering(file)) fs.rmSync(file, { force: true });
  }
}

type Waiter<T> = { resolve: (v: T) => void; reject: (e: Error) => void };
type ConnOptions = { idleMs: number; /** How long the host gets to answer `hello` (default HELLO_WAIT_MS). */ helloMs?: number; onClose: (c: HostConn, unexpected: boolean) => void };
const WENT = 'the Whisper host closed the connection';

/** One connection to the host, after `hello`. */
class HostConn {
  /** The host's pid, from `hello`. */
  pid = 0;
  /** True from the moment this side closes it, or the host's end is seen closed. */
  closed = false;
  /** Why the connection ended, for the one that counts it as a death. */
  lost = WENT;
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
  /** On a pipe: the home's host secret, and this side's nonce for the handshake (see hostWire.ts `helloProof`). */
  private readonly secret: string | undefined;
  private readonly nonce = newNonce();
  private challenge: string | undefined;

  private constructor(sock: net.Socket, o: ConnOptions, secret: string | undefined) {
    this.sock = sock;
    this.o = o;
    this.secret = secret;
    const decoder = new FrameDecoder();
    this.ended = new Promise((resolve) => sock.once('close', () => resolve()));
    sock.on('data', (d: Buffer) => {
      try { for (const f of decoder.push(d)) this.reply(f.header); } catch { sock.destroy(); }
    });
    sock.on('close', () => this.gone());
  }

  /** Connects to the host on `socketPath` and says hello. Throws the connect error (ENOENT, ECONNREFUSED: nobody there) or a wrong answer. */
  static async open(socketPath: string, o: ConnOptions): Promise<HostConn> {
    const sock = await dial(socketPath);
    let secret: string | undefined;
    try {
      secret = isPipePath(socketPath) ? hostSecret() : undefined;
    } catch (e) {
      sock.destroy();
      throw e;
    }
    const c = new HostConn(sock, o, secret);
    try {
      const h = await c.greet();
      if (h.proto !== HOST_PROTO || h.pins !== HOST_PINS || !Number.isSafeInteger(h.pid) || (h.pid as number) <= 0) throw new Error('the Whisper host speaks another protocol');
      // a pipe any local user may have taken: a host that cannot prove the secret gets no audio
      if (secret !== undefined && !proofMatches(h.proof, helloProof(secret, 'host', c.challenge!, c.nonce))) throw new Error('what answers on the Whisper host pipe is not this user\'s host');
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
      const timer = setTimeout(() => reject(new Error('the Whisper host did not answer hello')), this.o.helloMs ?? HELLO_WAIT_MS);
      this.hello = { resolve: (h) => { clearTimeout(timer); resolve(h); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      if (this.secret === undefined) this.send({ type: 'hello', proto: HOST_PROTO }); // on a pipe: when the challenge comes (reply)
    });
  }

  /** Sends one job. The answer, or why there is none: WhisperBusy, WhisperOff, HostDropped, an Error for `failed`, the signal's reason. */
  job(body: Uint8Array, opts: JobOpts, deadlineMs: number, signal?: AbortSignal): Promise<Spoken> {
    if (this.closed) return Promise.reject(new HostDropped());
    const id = this.nextId++;
    const frame = encodeFrame({ type: 'job', id, opts }, body); // a WireError (too large) before anything is registered or sent
    return new Promise((resolve, reject) => {
      // a host that never answers (stopped, wedged) is a dead one: the connection ends and every job on it is dropped
      const late = setTimeout(() => { this.lost = 'the Whisper host did not answer in time'; this.sock.destroy(); }, deadlineMs);
      late.unref();
      const onAbort = () => {
        if (!this.jobs.delete(id)) return;
        clearTimeout(late);
        this.send({ type: 'cancel', id }); // the host answers `cancelled` to a job nobody waits for now: ignored
        reject(signal!.reason);
        this.rest();
      };
      const unlisten = <T>(f: (v: T) => void) => (v: T) => { clearTimeout(late); signal?.removeEventListener('abort', onAbort); f(v); };
      this.jobs.set(id, { resolve: unlisten(resolve), reject: unlisten(reject) });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.clearIdle();
      this.sock.write(frame);
    });
  }

  /** The host's `status` answer; a host that does not give it within `waitMs` is an error. */
  status(waitMs: number): Promise<Header> {
    return new Promise((resolve, reject) => {
      this.clearIdle();
      const w: Waiter<Header> = {
        resolve: (h) => { clearTimeout(timer); resolve(h); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      const timer = setTimeout(() => {
        this.statuses.splice(this.statuses.indexOf(w), 1);
        reject(new Error('the Whisper host did not answer status'));
      }, waitMs);
      this.statuses.push(w);
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
    this.closed = true; // at once, not when the socket says so: a connection that is closing is not handed to the next job
    this.clearIdle();
    this.fail(new ClientClosed());
    this.sock.destroy();
  }

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
    if (h.type === 'challenge') {
      // the host's nonce, once, before hello: answered with ours and the proof; anything else ends the connection
      if (this.secret === undefined || this.challenge !== undefined || !this.hello || typeof h.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(h.nonce)) return void this.sock.destroy();
      this.challenge = h.nonce;
      return this.send({ type: 'hello', proto: HOST_PROTO, nonce: this.nonce, proof: helloProof(this.secret, 'window', h.nonce, this.nonce) });
    }
    if (h.type === 'hello') {
      if (this.secret !== undefined && this.challenge === undefined) return void this.sock.destroy(); // a hello we did not send for
      const w = this.hello;
      this.hello = undefined;
      return w?.resolve(h);
    }
    if (h.type === 'full') {
      const w = this.hello;
      this.hello = undefined;
      return w?.reject(new HostFull('the Whisper host has all the windows it takes'));
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
    else job.reject(new Error(`the Whisper host could not transcribe it${typeof h.message === 'string' && h.message ? `: ${h.message}` : ` (${typeof h.error === 'string' ? h.error : 'bad answer'})`}`));
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
    this.fail(new HostDropped(this.lost));
    if (this.ready) this.o.onClose(this, !this.expected);
  }
}

export type HostClientOptions = {
  /** Idle time before a connection with no job is closed (default IDLE_CLOSE_MS). */
  idleMs?: number;
  now?: () => number;
  /** The script a host is started from (default hostEntryFile(); a test starts one that fails). */
  entry?: string;
  /** How long to wait for a host that is starting (default SPAWN_WAIT_MS). */
  spawnWaitMs?: number;
  /** How long `status()` waits for a host (default STATUS_WAIT_MS). */
  statusWaitMs?: number;
  /** Signals a process (default process.kill; killTree on Windows): `stopHost` ends a host that will not stop by itself with it; a test passes a fake. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** How long to wait for the answer to a job of this many samples (default clientDeadlineMs). */
  deadlineMs?: (samples: number) => number;
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
  /** The host processes it started that have not exited (tests end them). */
  readonly children = new Set<ChildProcess>();
  private conn: HostConn | undefined;
  private connecting: { epoch: number; p?: Promise<HostConn> } | undefined;
  /** Bumped by close(): a call that began before it does not go on (no connect, no retry, no spawn wait). */
  private epoch = 0;
  private failures: number[] = [];
  private fallbackUntil = 0;
  private told: string | undefined;
  private readonly o: HostClientOptions & { idleMs: number; now: () => number; spawnWaitMs: number; statusWaitMs: number; deadlineMs: (samples: number) => number };

  constructor(o: HostClientOptions = {}) {
    this.o = { ...o, idleMs: o.idleMs ?? IDLE_CLOSE_MS, now: o.now ?? Date.now, spawnWaitMs: o.spawnWaitMs ?? SPAWN_WAIT_MS, statusWaitMs: o.statusWaitMs ?? STATUS_WAIT_MS, deadlineMs: o.deadlineMs ?? clientDeadlineMs };
  }

  /** Where problems are told from now on. */
  reportTo(report: (where: string, e: unknown) => void): void { this.o.report = report; }

  /** Is a connection to a host open? */
  connected(): boolean { return this.conn !== undefined && !this.conn.closed; }

  /** Deaths and failed starts counted so far toward the fallback (those within the last BACKOFF_WINDOW_MS; the count restarts when the fallback begins). */
  recentFailures(): number {
    const t = this.o.now();
    return this.failures.filter((at) => t - at < BACKOFF_WINDOW_MS).length;
  }

  /**
   * `pcm` as text through the host. Answers null when this window should transcribe in its own process: the host cannot be used
   * (see the class), could not be started, is full, or the job is too large for a frame. Rejects with WhisperBusy (the host's
   * queue is full), WhisperOff, an Error when the host failed the job, HostLost when it stopped under the job and its retry (a
   * job that has lost a host is never run here), or the signal's reason once `signal` aborts: a job still waiting then is
   * cancelled at the host. A call that `close()` interrupts rejects.
   */
  async transcribe(pcm: Float32Array, lang: string, detect: boolean, signal?: AbortSignal): Promise<Spoken | null> {
    signal?.throwIfAborted();
    const epoch = this.epoch;
    const body = pcmToInt16(pcm);
    const deadline = this.o.deadlineMs(pcm.length);
    for (let attempt = 0; ; attempt++) {
      if (epoch !== this.epoch) throw new ClientClosed();
      /** No host for this job: this process runs it, unless a host has already been lost under it. */
      const here = (): null => { if (attempt > 0) throw new HostLost(); return null; };
      const socketPath = this.inFallback() ? undefined : this.place();
      if (!socketPath) return here();
      let conn: HostConn;
      try {
        conn = await abortable(this.connect(socketPath), signal);
      } catch (e) {
        if (signal?.aborted || e instanceof ClientClosed || e instanceof WhisperOff) throw e; // Whisper removed: no host is started for the job, here or there
        return here(); // counted by connect() when it is a failure
      }
      try {
        return await conn.job(body, { lang, detect }, deadline, signal);
      } catch (e) {
        if (e instanceof WireError) return null;
        if (!(e instanceof HostDropped)) throw e;
        signal?.throwIfAborted();
        // the host went while it had the job: once more on a fresh one (three of those within a minute stop the retries: fallback)
        if (attempt > 0) throw new HostLost();
      }
    }
  }

  /**
   * The running host's state, or null when there is none to ask: none running, one that has all the windows it takes, one that does
   * not answer in time (STATUS_WAIT_MS), one of another protocol. Never starts a host and never throws. It asks on a short connection
   * of its own, never on the window's: that one must be left to close after IDLE_CLOSE_MS (a page that polls this would keep it
   * open for the host's own idle exit to end, and that would count as the host's death), and a failure here is no death.
   */
  async status(): Promise<HostInfo | null> {
    const socketPath = this.place(false);
    if (!socketPath) return null;
    const until = Date.now() + this.o.statusWaitMs;
    let c: HostConn | undefined;
    try {
      c = await HostConn.open(socketPath, { idleMs: this.o.idleMs, helloMs: this.o.statusWaitMs, onClose: () => {} });
      const h = await c.status(Math.max(until - Date.now(), 1));
      if (typeof h.loaded !== 'boolean' || typeof h.running !== 'boolean' || typeof h.queued !== 'number' || typeof h.clients !== 'number') return null;
      return { pid: c.pid, loaded: h.loaded, queued: h.queued, running: h.running, clients: Math.max(h.clients - 1, 0) }; // the host counts this connection too
    } catch {
      return null;
    } finally {
      c?.close();
    }
  }

  /**
   * Tells the running host to stop (Remove does this before it deletes the install) and waits up to `waitMs` for it to end the
   * connection. Null when no host was running (or one that was stopping already); else its pid, whether its socket name is gone,
   * and `held`: the connection was still open after `waitMs`, so the host did not do what it was told (and is a live process whose
   * pid it said itself). Throws when a host is there and cannot be talked to (it does not answer `hello`, it speaks another
   * protocol, it has all the windows it takes and this window has no connection to it).
   */
  async shutdown(reason = 'shutdown', waitMs = 5000): Promise<{ pid: number; gone: boolean; held: boolean } | null> {
    const socketPath = this.place(false);
    if (!socketPath) return null;
    // this window's own connection when it has one (a host that is full takes no other), else a short one of its own
    let c = this.connected() ? this.conn : undefined;
    if (!c) {
      try {
        c = await HostConn.open(socketPath, { idleMs: this.o.idleMs, onClose: () => {} });
      } catch (e) {
        if (absent(e) || e instanceof HostDropped) return null; // nobody there, or it went while we greeted it: it is stopping
        throw e;
      }
    }
    c.shutdown(reason); // the close that follows is expected, not a death: said only now that a host is known to be there
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([c.ended, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
    const held = !c.closed;
    c.close();
    // a pipe leaves no name behind: it is gone when nothing answers on it
    return { pid: c.pid, gone: isPipePath(socketPath) ? !await answering(socketPath) : !fs.existsSync(socketPath), held };
  }

  /**
   * `shutdown`, and a host that kept our connection open after `waitMs` gets SIGTERM: Remove must not leave a host that serves a
   * model nobody can ask for. Only such a host is signalled, and the pid is the one it answered `hello` with on that very
   * connection, so it is the live peer and no process that has the pid by now (never this process, either, or a group). When the
   * connection ended but the socket name still answers, it is another host's (this one's was a host of the same install that went
   * and a new one took the name): that one is asked once, on a connection of its own, by the same rule. Null when no host was running.
   * `signalled` says SIGTERM went out; `next` is that second host.
   */
  async stopHost(reason = 'removed', waitMs = 5000): Promise<StopResult | null> {
    const first = await this.stopOne(reason, waitMs);
    if (!first) return null;
    if (first.held || first.gone) return first;
    const next = await this.stopOne(reason, waitMs);
    return next ? { ...first, next } : first;
  }

  private async stopOne(reason: string, waitMs: number): Promise<StopResult | null> {
    const r = await this.shutdown(reason, waitMs);
    if (!r) return null;
    let signalled = false;
    if (r.held && r.pid > 1 && r.pid !== process.pid) {
      try {
        // Windows has no SIGTERM: the host and its children end hard (killTree)
        (this.o.kill ?? ((pid, signal) => { if (process.platform === 'win32') killTree(pid); else process.kill(pid, signal); }))(r.pid, 'SIGTERM');
        signalled = true;
      } catch { /* it went by itself, or it is not ours to signal */ }
    }
    return { pid: r.pid, gone: r.gone, held: r.held, signalled };
  }

  /**
   * Closes the connection (the window is closing): the host drops this window's jobs, and a call still under way (a connect, a
   * start, a retry) ends instead of going on. The client works again for calls made afterwards. The counters stay.
   */
  close(): void {
    this.epoch++;
    this.conn?.close();
    this.conn = undefined;
  }

  private inFallback(): boolean { return this.o.now() < this.fallbackUntil; }

  /**
   * The host's socket, in a folder that is ours before a connection is made (made if need be, unless `create` is false: only
   * looking for a host); undefined on a machine where that cannot be (said once).
   */
  private place(create = true): string | undefined {
    try {
      const socketPath = hostSocketPath();
      if (!this.connected() && (create || fs.existsSync(hostDir()))) {
        privateDir(hostDir());
        if (isPipePath(socketPath)) hostSecret(); // made, or found bad (said once here, not counted as a host's failure)
      }
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

  /** The connection, made when there is none; one attempt at a time (per epoch). A failure is counted once, whoever waited. */
  private connect(socketPath: string): Promise<HostConn> {
    if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
    const epoch = this.epoch;
    if (this.connecting?.epoch === epoch) return this.connecting.p!;
    const attempt: { epoch: number; p?: Promise<HostConn> } = { epoch };
    this.connecting = attempt;
    attempt.p = (async () => {
      try {
        const c = await this.open(socketPath, epoch);
        if (epoch !== this.epoch) { c.close(); throw new ClientClosed(); } // closed meanwhile: not ours to keep
        return this.conn = c;
      } catch (e) {
        // a host that is full, a window that closed, an install with no host to start, Whisper gone are not the host failing
        if (!(e instanceof HostFull || e instanceof NoHost || e instanceof ClientClosed || e instanceof WhisperOff)) this.fail(e);
        throw e;
      } finally {
        if (this.connecting === attempt) this.connecting = undefined;
      }
    })();
    return attempt.p;
  }

  private async open(socketPath: string, epoch: number): Promise<HostConn> {
    return await this.dialHost(socketPath) ?? await this.start(socketPath, epoch);
  }

  /** A connection to the host on the socket, or undefined when nobody answers there. */
  private async dialHost(socketPath: string): Promise<HostConn | undefined> {
    try {
      return await HostConn.open(socketPath, {
        idleMs: this.o.idleMs,
        onClose: (c, unexpected) => {
          if (this.conn === c) this.conn = undefined;
          if (unexpected) this.fail(new Error(c.lost));
        },
      });
    } catch (e) {
      if (absent(e)) return undefined;
      throw e;
    }
  }

  /** A spawn lock older than LOCK_MARGIN_MS beyond the longest a live holder keeps it is of a holder that died, or of a pid that is somebody else's now: it goes. */
  private reapOldLock(lock: string): void {
    const max = this.o.spawnWaitMs + 2 * HELLO_WAIT_MS + LOCK_MARGIN_MS;
    const age = (file: string): number => this.o.now() - fs.statSync(file).mtimeMs;
    const aside = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}.old`;
    try {
      if (age(lock) <= max) return;
      fs.renameSync(lock, aside); // one window wins this
      if (age(aside) <= max) { // what moved was a fresh lock after all (the old one went first): put it back
        try { fs.linkSync(aside, lock); } catch { /* a newer one is there already */ }
      }
    } catch { /* no lock, or someone else took it */ } finally {
      fs.rmSync(aside, { force: true });
    }
  }

  /**
   * Nobody answers: start a host, under the spawn lock so that windows that find the socket dead together start one. The one
   * that holds the lock starts it; the others wait for its socket.
   */
  private async start(socketPath: string, epoch: number): Promise<HostConn> {
    const entry = this.o.entry ?? hostEntryFile();
    if (!fs.existsSync(entry)) throw new NoHost(`there is no Whisper host to start (${entry})`); // an install without host.js
    const dir = hostDir();
    const lock = path.join(dir, 'spawn.lock');
    const token = `whisper-host.${process.pid}.${randomBytes(6).toString('hex')}`; // which lock is ours
    const until = Date.now() + this.o.spawnWaitMs;
    for (;;) {
      if (epoch !== this.epoch) throw new ClientClosed();
      this.reapOldLock(lock);
      if (takeLockFile(lock, token)) break;
      const c = await this.dialHost(socketPath);
      if (c) return c;
      if (Date.now() >= until) throw new Error('another window is starting the Whisper host and it did not come up');
      await sleep(POLL_MS);
    }
    try {
      const c = await this.dialHost(socketPath); // the holder before us may have started it
      if (c) return c;
      if (epoch !== this.epoch) throw new ClientClosed(); // a window that closed in the meantime starts nothing
      await sweepTempSockets(dir);
      return await this.spawnHost(socketPath, dir, entry, epoch);
    } finally {
      this.releaseLock(lock, token);
    }
  }

  /** Removes the spawn lock if it is still ours: it may have been taken over (found old) and be another window's by now. */
  private releaseLock(lock: string, token: string): void {
    const aside = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.mine`;
    try {
      fs.renameSync(lock, aside); // takes whichever lock is there, at once
      let ours = false;
      try { ours = (JSON.parse(fs.readFileSync(aside, 'utf8')) as { version?: unknown }).version === token; } catch { /* unreadable: not ours */ }
      if (!ours) { // another window's: put it back
        try { fs.linkSync(aside, lock); } catch { /* a newer one is there already */ }
      }
    } catch { /* no lock */ } finally {
      fs.rmSync(aside, { force: true });
    }
  }

  /** Starts a host (detached, its output in <dir>/host.log, the last one's in host.log.1) and waits for its socket to answer. */
  private async spawnHost(socketPath: string, dir: string, entry: string, epoch: number): Promise<HostConn> {
    if (epoch !== this.epoch) throw new ClientClosed(); // right before the spawn: a window that closed (a test ended) starts no host
    // and one for an install that is not ready (never installed, or Remove has begun) starts none either: the host would load from
    // files that are going, and could download the model again into the folder Remove is deleting. Nothing awaits between this and the spawn.
    if (whisperPhase() !== 'ready') throw new WhisperOff('Whisper is not installed');
    const logFile = path.join(dir, 'host.log');
    try { renameRetry(logFile, `${logFile}.1`); } catch { /* the first start */ } // a live host keeps writing to its own file
    const log = fs.openSync(logFile, 'w', 0o600);
    let child: ChildProcess;
    let over = '';
    try {
      fs.fchmodSync(log, 0o600);
      child = spawn(process.execPath, [entry], { detached: true, stdio: ['ignore', log, log], env: hostEnv(), cwd: dir, ...HIDDEN });
    } finally {
      fs.closeSync(log);
    }
    this.spawned++;
    this.children.add(child);
    child.on('error', (e) => { over = `could not be started: ${e.message}`; this.children.delete(child); });
    child.on('exit', (code, signal) => { over = `exited at startup (${signal ?? code}), see ${logFile}`; this.children.delete(child); });
    child.unref();
    const until = Date.now() + this.o.spawnWaitMs;
    for (;;) {
      const dead = over; // read before the dial: a host that exited by then (it found another one serving) leaves that one to dial
      const c = await this.dialHost(socketPath);
      if (c) return c;
      if (dead) throw new Error(`the Whisper host ${dead}`);
      if (epoch !== this.epoch) throw new ClientClosed(); // the host goes on: it is for whoever needs it next
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
