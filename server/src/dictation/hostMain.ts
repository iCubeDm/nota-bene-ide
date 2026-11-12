// The Whisper host: one process per host serves every window's transcription jobs from one shared queue, so the model is
// loaded once, not once per window. The model runs in the pipeline worker thread (pipelineHost.ts), which leaves this thread
// free for the socket; the process exits, which unloads the model, after WHISPER_IDLE_MS without work. Windows connect to
// the unix socket (hostWire.ts has the framing and the messages) and start the host when nobody listens. The host takes PCM
// only, never a path, and never reads preferences: a window checks whether Whisper is on before it sends a job.
// The process entry is hostEntry.ts: this module has no side effects, so it can be imported (bundled) anywhere.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { whisperDir } from './install.ts';
import { defaultFactory, openPipeline, type Pipe, type WorkerFactory } from './pipelineHost.ts';
import { speak } from './speak.ts';
import { WHISPER_RATE } from './whisper.ts';
import { FrameDecoder, encodeFrame, hostSocketPath, HOST_PINS, HOST_PROTO, parseRequest, pcmFromInt16, privateDir, WireError, type Frame, type HostReply, type HostRequest, type JobError, type JobOpts } from './hostWire.ts';

/** The host exits, and the model with it, after this long with nothing queued or running. */
export const WHISPER_IDLE_MS = 10 * 60_000;
/** Jobs one window may have waiting (the running one not counted) before the next is answered `busy`. */
export const MAX_QUEUED_PER_CLIENT = 16;
/** Jobs waiting across all windows. */
export const MAX_QUEUED_TOTAL = 64;
/** PCM waiting across all windows (the running job's not counted): a job that would exceed it is answered `busy`. */
export const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
/** Connected windows; one more is closed at once. Each may be buffering a partial frame of up to MAX_FRAME. */
export const MAX_CLIENTS = 32;
/** A window that does not read its answers is dropped once this much is waiting to be written to it. */
export const MAX_PENDING_WRITE = 1024 * 1024;
/** A model call gets the larger of this and JOB_DEADLINE_FACTOR times the audio's length. */
export const JOB_DEADLINE_MIN_MS = 2 * 60_000;
export const JOB_DEADLINE_FACTOR = 10;
/** The model load gets this long while jobs wait for it (the model is on disk by then: this only unwedges a hung load). */
export const LOAD_DEADLINE_MS = 5 * 60_000;
/** After a stop, a connection that has not taken its last answers is destroyed after this long. */
export const SOCKET_GRACE_MS = 1000;
/** After a stop, the model thread gets this long (on top of the dispose grace) to exit before the host reports itself wedged. */
export const THREAD_GRACE_MS = 1000;

/** How long a model call on `samples` of audio may take. */
export const jobDeadlineMs = (samples: number): number => Math.max(JOB_DEADLINE_MIN_MS, JOB_DEADLINE_FACTOR * samples * 1000 / WHISPER_RATE);

export type HostOptions = {
  socketPath: string;
  /** The Whisper install the model loads from (default: <stateBase>/whisper). */
  dir?: string;
  /** Makes the model thread (tests pass a fake). */
  worker?: WorkerFactory;
  idleMs?: number;
  log?: (message: string) => void;
};

export type HostStatus = { loaded: boolean; queued: number; running: boolean; clients: number };

export type Host = {
  /** Resolves once the host has stopped, socket gone and model thread ended: 0 after idle or a shutdown, 1 when the model cannot be loaded or kept alive. */
  done: Promise<number>;
  /** Stops now, as a `shutdown` message does: every job not finished fails `off`. Never rejects. */
  stop: (reason?: string) => Promise<number>;
  status: () => HostStatus;
  /** After `done`: a model thread has not exited (stuck in native code), so `process.exit()` would wait for it: the entry must kill the process. */
  wedged: () => boolean;
};

type Client = { sock: net.Socket; queue: Job[]; ids: Set<number>; closing: boolean };
type Job = { client: Client; id: number; opts: JobOpts; body: Buffer; cancelled: boolean };
type Why = 'idle' | 'shutdown' | 'failed' | 'stuck';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Is something answering on `socketPath`? */
const answering = (socketPath: string): Promise<boolean> => new Promise((resolve) => {
  const s = net.connect(socketPath);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

/**
 * Makes `server` listen on `socketPath`, or returns null when a live host answers there. It binds under a name of its own and
 * moves that into place only when nothing answers (rename replaces a stale socket file atomically), so a socket is never
 * reachable before it listens and a host never unlinks another's. Two hosts that race over a stale file both publish and the
 * last wins: the other is an orphan nobody can reach (it holds no model until a job comes, and idles out). `ino` names ours.
 */
async function publish(server: net.Server, socketPath: string): Promise<{ ino: number } | null> {
  const mine = path.join(path.dirname(socketPath), `.${randomBytes(4).toString('hex')}.sock`);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(mine, () => { server.off('error', reject); resolve(); });
  });
  try {
    fs.chmodSync(mine, 0o600);
    if (await answering(socketPath)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return null;
    }
    const { ino } = fs.lstatSync(mine); // before the rename, which keeps the inode: the public name may be another host's a moment after it
    fs.renameSync(mine, socketPath);
    return { ino };
  } catch (e) {
    server.close();
    fs.rmSync(mine, { force: true });
    throw e;
  }
}

/**
 * Starts serving on `socketPath` (mode 600; its folder is made 700 and must be ours). The model loads when the first job comes,
 * so a host that never gets one holds none. Resolves null, serving nothing, when a live host already holds the socket. Jobs
 * wait in one FIFO per window and the windows take turns, one job runs at a time.
 */
export async function startHost(o: HostOptions): Promise<Host | null> {
  const idleMs = o.idleMs ?? WHISPER_IDLE_MS;
  const log = o.log ?? (() => {});
  const dir = o.dir ?? whisperDir();
  /** The connected windows in turn order: the next job is the first queued one in this order, and its window goes to the back. */
  const clients: Client[] = [];
  /** The window served last: a window that connects later takes its turn before that one's next. */
  let lastServed: Client | undefined;
  let queued = 0;
  let queuedBytes = 0;
  let running: Job | undefined;
  let thread: { close: (why?: Error) => void } | undefined;
  let pipe: Pipe | undefined;
  /** Model-thread deaths since the last job that succeeded: the first is reloaded from, the second stops the host. */
  let deaths = 0;
  let idle: NodeJS.Timeout | undefined;
  let loadDeadline: NodeJS.Timeout | undefined;
  let ending = false;
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => { finish = resolve; });

  // model threads that have not exited yet (a real thread stuck in native code never does)
  let threads = 0;
  let noThreads: (() => void)[] = [];
  const makeWorker: WorkerFactory = (data) => {
    const w = (o.worker ?? defaultFactory)(data);
    threads++;
    let gone = false;
    w.on('exit', () => {
      if (gone) return;
      gone = true;
      if (--threads === 0) for (const f of noThreads.splice(0)) f();
    });
    return w;
  };
  const threadsGone = (): Promise<void> => new Promise((resolve) => { if (threads === 0) resolve(); else noThreads.push(resolve); });

  const status = (): HostStatus => ({ loaded: pipe !== undefined && !pipe.dead, queued, running: running !== undefined, clients: clients.length });
  /** Writes a reply; a window that lets answers pile up unread is dropped. */
  const send = (c: Client, reply: HostReply): void => {
    if (!c.sock.writable) return;
    c.sock.write(encodeFrame(reply));
    if (c.sock.writableLength > MAX_PENDING_WRITE) {
      log('dropping a window that does not read its answers');
      drop(c);
    }
  };
  /** Answers a job once; the window may reuse its id afterwards. A transcript too long for a frame header is a failure, not a crash. */
  const answer = (job: Job, r: { text: string; lang: string } | { error: JobError }): void => {
    job.client.ids.delete(job.id);
    try {
      send(job.client, { id: job.id, ...r });
    } catch (e) {
      log(`an answer did not fit a frame: ${message(e)}`);
      send(job.client, { id: job.id, error: 'failed' });
    }
  };

  const clearIdle = (): void => { clearTimeout(idle); idle = undefined; };
  /** With nothing queued or running the idle clock starts (or restarts): connections do not count, jobs do. */
  const rest = (): void => {
    if (ending || running || queued > 0) return;
    clearIdle();
    idle = setTimeout(() => void stop('idle', `idle for ${idleMs} ms`), idleMs);
  };

  /** Takes the next job in turn order. */
  function dequeue(): Job | undefined {
    const i = clients.findIndex((c) => c.queue.length > 0);
    if (i < 0) return undefined;
    const c = clients[i]!;
    clients.push(...clients.splice(0, i + 1));
    lastServed = c;
    const job = c.queue.shift()!;
    queued--;
    queuedBytes -= job.body.length;
    return job;
  }

  function pump(): void {
    if (ending || running) return;
    if (queued === 0) return rest();
    if (!pipe) {
      if (!thread) load(); // the first job loads the model; a loading one will pump when it is ready
      return;
    }
    if (pipe.dead) return reload();
    void run(dequeue()!, pipe);
  }

  async function run(job: Job, p: Pipe): Promise<void> {
    running = job;
    // a model call that never returns would hold the queue, the idle clock and every window behind it
    const deadline = setTimeout(() => expire(job), jobDeadlineMs(job.body.length >> 1));
    let spoken: { text: string; lang: string } | undefined;
    try {
      spoken = await speak(p, pcmFromInt16(job.body), job.opts.lang, job.opts.detect);
    } catch (e) {
      log(`a job failed: ${message(e)}`);
    }
    clearTimeout(deadline);
    running = undefined;
    if (ending) return; // stop() answered everything
    if (spoken) deaths = 0;
    // a cancelled job (or one whose window left) was answered, or has no one to answer: its result is dropped
    if (!job.cancelled) answer(job, spoken ?? { error: 'failed' });
    pump();
  }

  /** The model call ran past its deadline: that job fails, and the host goes, so the windows start a fresh one for the rest. */
  function expire(job: Job): void {
    if (running !== job || ending) return;
    log('a model call ran past its deadline');
    if (!job.cancelled) { job.cancelled = true; answer(job, { error: 'failed' }); }
    void stop('stuck', 'a model call ran past its deadline');
  }

  function load(): void {
    const h = openPipeline(dir, { worker: makeWorker });
    thread = h;
    clearTimeout(loadDeadline);
    loadDeadline = setTimeout(() => {
      if (thread !== h || pipe || ending) return;
      log('the model load ran past its deadline');
      void stop('failed', 'the model load ran past its deadline');
    }, LOAD_DEADLINE_MS);
    h.ready.then((p) => {
      if (thread !== h || ending) return;
      clearTimeout(loadDeadline);
      pipe = p;
      log('the model is loaded');
      pump();
    }, (e: unknown) => {
      if (thread !== h || ending) return;
      log(`the model failed to load: ${message(e)}`);
      void stop('failed', 'the model failed to load');
    });
  }

  /** The model thread died: one reload, then stop. Jobs wait for the new model. */
  function reload(): void {
    if (++deaths > 1) return void stop('failed', 'the model thread died again');
    log('the model thread died; loading the model again');
    pipe = undefined;
    load();
  }

  function enqueue(c: Client, id: number, opts: JobOpts, body: Buffer): void {
    if (body.length % 2) throw new WireError('a PCM body has an even number of bytes');
    if (c.ids.has(id)) throw new WireError('a job id in use');
    if (c.queue.length >= MAX_QUEUED_PER_CLIENT || queued >= MAX_QUEUED_TOTAL || queuedBytes + body.length > MAX_QUEUED_BYTES) return send(c, { id, error: 'busy' });
    c.ids.add(id);
    c.queue.push({ client: c, id, opts, body, cancelled: false });
    queued++;
    queuedBytes += body.length;
    clearIdle();
    pump();
  }

  function cancel(c: Client, id: number): void {
    const i = c.queue.findIndex((j) => j.id === id);
    if (i >= 0) {
      const job = c.queue.splice(i, 1)[0]!;
      queued--;
      queuedBytes -= job.body.length;
      answer(job, { error: 'cancelled' });
      rest();
    } else if (running?.client === c && running.id === id && !running.cancelled) {
      // a running call cannot be interrupted: it finishes, and run() drops its result
      running.cancelled = true;
      answer(running, { error: 'cancelled' });
    }
    // an id that is neither (it just finished) is nothing to cancel
  }

  /** A window left (or was cut off): its queued jobs are dropped, a running one is left to finish unanswered. */
  function drop(c: Client): void {
    c.closing = true;
    const i = clients.indexOf(c);
    if (i < 0) return;
    clients.splice(i, 1);
    if (lastServed === c) lastServed = undefined;
    queued -= c.queue.length;
    for (const j of c.queue) queuedBytes -= j.body.length;
    c.queue = [];
    if (running?.client === c) running.cancelled = true;
    c.sock.destroy();
    rest();
  }

  function handle(c: Client, f: Frame): void {
    if (ending || c.closing) return; // a window that is leaving is not served
    const m: HostRequest = parseRequest(f.header);
    if (f.body.length && m.type !== 'job') throw new WireError('a body without a job');
    switch (m.type) {
      case 'hello':
        send(c, { type: 'hello', proto: HOST_PROTO, pid: process.pid, pins: HOST_PINS, loaded: status().loaded, queued });
        if (m.proto !== HOST_PROTO) { // the answer says which protocol this host speaks; then the window goes
          c.closing = true;
          c.sock.end();
          c.sock.once('finish', () => drop(c));
        }
        return;
      case 'status':
        return send(c, { type: 'status', ...status() });
      case 'job':
        return enqueue(c, m.id, m.opts, f.body);
      case 'cancel':
        return cancel(c, m.id);
      case 'shutdown':
        return void stop('shutdown', m.reason);
    }
  }

  const server = net.createServer((sock) => {
    if (ending || clients.length >= MAX_CLIENTS) return void sock.destroy();
    const c: Client = { sock, queue: [], ids: new Set(), closing: false };
    // before the window served last, so that one's next job does not go first again
    const at = lastServed ? clients.indexOf(lastServed) : -1;
    if (at >= 0) clients.splice(at, 0, c); else clients.push(c);
    const decoder = new FrameDecoder();
    sock.on('error', () => {});
    sock.on('close', () => drop(c));
    sock.on('data', (d: Buffer) => {
      try {
        for (const f of decoder.push(d)) handle(c, f);
      } catch (e) {
        log(`dropping a window: ${message(e)}`);
        drop(c);
      }
    });
  });

  let stopped: Promise<number> | undefined;
  let published: { ino: number } | undefined;
  /** Runs one step of the stop whatever the others did: a stop that throws would leave `done` pending and the socket in place. */
  const step = async (what: string, fn: () => unknown): Promise<void> => {
    try { await fn(); } catch (e) { log(`${what} failed: ${message(e)}`); }
  };
  /**
   * Ends the host: unanswered jobs fail (`off` for an idle or shutdown stop, `failed` for a broken model; none are answered for a
   * stuck one, whose windows see the connection close and start again), the connections close, the model thread ends. Never rejects.
   */
  function stop(why: Why, reason: string): Promise<number> {
    if (stopped) return stopped;
    ending = true;
    log(`stopping (${why}): ${reason}`);
    clearIdle();
    clearTimeout(loadDeadline);
    return stopped = (async () => {
      const code = why === 'failed' || why === 'stuck' ? 1 : 0;
      let closed: Promise<void> = Promise.resolve();
      // first of all: the public name goes at once, so for the seconds the stop takes it does not lead to a host that refuses
      // connections, and a freed inode number cannot be mistaken for ours later (libuv unlinks only the temp name this server bound)
      await step('closing the socket', () => {
        closed = new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          if (published && fs.lstatSync(o.socketPath).ino === published.ino) fs.unlinkSync(o.socketPath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // already gone
        }
      });
      await step('answering the jobs', () => {
        const error: JobError = why === 'failed' ? 'failed' : 'off';
        for (const c of [...clients]) { // a window that does not read is dropped by its answer: not while iterating
          if (why !== 'stuck') for (const j of c.queue) answer(j, { error });
          c.queue = [];
        }
        if (running && !running.cancelled) { running.cancelled = true; answer(running, { error }); }
        queued = 0;
        queuedBytes = 0;
      });
      await step('closing the connections', () => {
        // each connection closes once its answers are written, or after a grace: a window that does not read must not hold the stop
        for (const c of clients.splice(0)) {
          const grace = setTimeout(() => c.sock.destroy(), SOCKET_GRACE_MS);
          grace.unref();
          c.sock.once('close', () => clearTimeout(grace));
          c.sock.once('finish', () => c.sock.destroy());
          c.sock.end();
        }
      });
      await step('disposing the model', () => pipe?.dispose?.());
      await step('ending the model thread', () => thread?.close(new Error('the host stopped')));
      await step('waiting for the model thread', async () => {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([threadsGone(), new Promise<void>((resolve) => { timer = setTimeout(resolve, THREAD_GRACE_MS); })]);
        clearTimeout(timer);
      });
      await step('waiting for the connections', () => closed);
      finish(code);
      return code;
    })();
  }

  privateDir(path.dirname(o.socketPath));
  published = await publish(server, o.socketPath) ?? undefined;
  if (!published) return null;
  server.on('error', (e) => log(`the socket failed: ${message(e)}`));
  log(`listening on ${o.socketPath}`);
  rest();
  return { done, stop: (reason = 'stopped') => stop('shutdown', reason), status, wedged: () => threads > 0 };
}

/**
 * What the process entry (hostEntry.ts) runs: serves on this host's socket until idle or shut down. `wedged` says a model thread
 * did not exit, so that `process.exit()` would hang on it and the entry must kill the process instead.
 * `NOTA_BENE_TEST_WHISPER_IDLE_MS` shortens the idle time (tests and smoke runs only).
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; wedged: boolean }> {
  const log = (m: string) => console.error(`${new Date().toISOString()} whisper-host ${process.pid}: ${m}`);
  const idleMs = Number(env.NOTA_BENE_TEST_WHISPER_IDLE_MS);
  const host = await startHost({ socketPath: hostSocketPath(), idleMs: idleMs > 0 ? idleMs : undefined, log });
  if (!host) {
    log('another host already serves this socket');
    return { code: 0, wedged: false };
  }
  const signals = ['SIGTERM', 'SIGINT'] as const;
  const onSignal = (sig: string) => void host.stop(sig);
  for (const sig of signals) process.on(sig, onSignal);
  const code = await host.done;
  for (const sig of signals) process.off(sig, onSignal);
  return { code, wedged: host.wedged() };
}
