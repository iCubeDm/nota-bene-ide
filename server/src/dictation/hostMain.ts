// The Whisper host: one process per host serves every window's transcription jobs from one shared queue, so the model is
// loaded once, not once per window. The model runs in the pipeline worker thread (pipelineHost.ts), which leaves this thread
// free for the socket; the process exits, which unloads the model, after WHISPER_IDLE_MS without work. Windows connect to
// the unix socket (hostWire.ts has the framing and the messages) and start the host when nobody listens. The host takes PCM
// only, never a path, and never reads preferences: a window checks whether Whisper is on before it sends a job.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whisperDir } from './install.ts';
import { openPipeline, type Pipe, type WorkerFactory } from './pipelineHost.ts';
import { speak } from './transcribe.ts';
import { FrameDecoder, encodeFrame, hostSocketPath, HOST_PINS, HOST_PROTO, parseRequest, pcmFromInt16, WireError, type Frame, type HostReply, type HostRequest, type JobError, type JobOpts } from './hostWire.ts';

/** The host exits, and the model with it, after this long with nothing queued or running. */
export const WHISPER_IDLE_MS = 10 * 60_000;
/** Jobs one window may have waiting (the running one not counted) before the next is answered `busy`. */
export const MAX_QUEUED_PER_CLIENT = 16;
/** Jobs waiting across all windows. */
export const MAX_QUEUED_TOTAL = 64;

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
  /** Stops now, as a `shutdown` message does: every job not finished fails `off`. */
  stop: (reason?: string) => Promise<number>;
  status: () => HostStatus;
};

type Client = { sock: net.Socket; queue: Job[]; ids: Set<number> };
type Job = { client: Client; id: number; opts: JobOpts; body: Buffer; cancelled: boolean };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Is something answering on `socketPath`? */
const answering = (socketPath: string): Promise<boolean> => new Promise((resolve) => {
  const s = net.connect(socketPath);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

/** Binds the socket; false when a live host already holds it. A stale socket file (nobody answering) is removed first. */
async function listen(server: net.Server, socketPath: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => { server.off('error', reject); resolve(); });
      });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt > 0) throw e;
      if (await answering(socketPath)) return false;
      fs.rmSync(socketPath, { force: true });
    }
  }
}

/**
 * Starts serving on `socketPath` (mode 600; its folder is created 700) and loads the model. Resolves null, serving nothing, when
 * a live host already holds the socket. Jobs wait in one FIFO per window and the windows take turns, one job runs at a time.
 */
export async function startHost(o: HostOptions): Promise<Host | null> {
  const idleMs = o.idleMs ?? WHISPER_IDLE_MS;
  const log = o.log ?? (() => {});
  const dir = o.dir ?? whisperDir();
  /** The connected windows in turn order: the next job is the first queued one in this order, and its window goes to the back. */
  const clients: Client[] = [];
  let queued = 0;
  let running: Job | undefined;
  let loading: { close: (why?: Error) => void } | undefined;
  let pipe: Pipe | undefined;
  /** Model-thread deaths since the last job that succeeded: the first is reloaded from, the second stops the host. */
  let deaths = 0;
  let idle: NodeJS.Timeout | undefined;
  let ending = false;
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => { finish = resolve; });

  const status = (): HostStatus => ({ loaded: pipe !== undefined && !pipe.dead, queued, running: running !== undefined, clients: clients.length });
  const send = (c: Client, reply: HostReply): void => { if (c.sock.writable) c.sock.write(encodeFrame(reply)); };
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
    queued--;
    return c.queue.shift();
  }

  function pump(): void {
    if (ending || running || !pipe) return;
    if (queued === 0) return rest();
    if (pipe.dead) return reload();
    void run(dequeue()!, pipe);
  }

  async function run(job: Job, p: Pipe): Promise<void> {
    running = job;
    let spoken: { text: string; lang: string } | undefined;
    try {
      spoken = await speak(p, pcmFromInt16(job.body), job.opts.lang, job.opts.detect);
    } catch (e) {
      log(`a job failed: ${message(e)}`);
    }
    running = undefined;
    if (ending) return; // stop() answered everything
    if (spoken) deaths = 0;
    // a cancelled job (or one whose window left) was answered, or has no one to answer: its result is dropped
    if (!job.cancelled) answer(job, spoken ?? { error: 'failed' });
    pump();
  }

  function load(): void {
    const h = openPipeline(dir, { worker: o.worker });
    loading = h;
    h.ready.then((p) => {
      if (loading !== h || ending) return;
      pipe = p;
      log('the model is loaded');
      pump();
    }, (e: unknown) => {
      if (loading !== h || ending) return;
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
    if (c.queue.length >= MAX_QUEUED_PER_CLIENT || queued >= MAX_QUEUED_TOTAL) return send(c, { id, error: 'busy' });
    c.ids.add(id);
    c.queue.push({ client: c, id, opts, body, cancelled: false });
    queued++;
    clearIdle();
    pump();
  }

  function cancel(c: Client, id: number): void {
    const i = c.queue.findIndex((j) => j.id === id);
    if (i >= 0) {
      answer(c.queue.splice(i, 1)[0]!, { error: 'cancelled' });
      queued--;
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
    const i = clients.indexOf(c);
    if (i < 0) return;
    clients.splice(i, 1);
    queued -= c.queue.length;
    c.queue = [];
    if (running?.client === c) running.cancelled = true;
    c.sock.destroy();
    rest();
  }

  function handle(c: Client, f: Frame): void {
    if (ending) return;
    const m: HostRequest = parseRequest(f.header);
    if (f.body.length && m.type !== 'job') throw new WireError('a body without a job');
    switch (m.type) {
      case 'hello':
        send(c, { type: 'hello', proto: HOST_PROTO, pid: process.pid, pins: HOST_PINS, loaded: status().loaded, queued });
        if (m.proto !== HOST_PROTO) { // the answer says which protocol this host speaks; then the window goes
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
    if (ending) return void sock.destroy();
    const c: Client = { sock, queue: [], ids: new Set() };
    clients.push(c);
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
  /** Ends the host: unanswered jobs fail (`off` for an idle or shutdown stop, `failed` for a broken model), the connections close, the model thread ends. */
  function stop(why: 'idle' | 'shutdown' | 'failed', reason: string): Promise<number> {
    if (stopped) return stopped;
    ending = true;
    log(`stopping (${why}): ${reason}`);
    clearIdle();
    return stopped = (async () => {
      const error: JobError = why === 'failed' ? 'failed' : 'off';
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const c of clients) {
        for (const j of c.queue) answer(j, { error });
        c.queue = [];
      }
      if (running && !running.cancelled) { running.cancelled = true; answer(running, { error }); }
      queued = 0;
      // each connection closes once its answers are written
      for (const c of clients.splice(0)) { c.sock.end(); c.sock.once('finish', () => c.sock.destroy()); }
      try {
        await pipe?.dispose?.();
        loading?.close(new Error('the host stopped'));
        await closed;
      } finally {
        finish(why === 'failed' ? 1 : 0);
      }
      return done;
    })();
  }

  fs.mkdirSync(path.dirname(o.socketPath), { recursive: true, mode: 0o700 });
  if (!await listen(server, o.socketPath)) return null;
  try {
    fs.chmodSync(o.socketPath, 0o600);
  } catch (e) {
    server.close();
    throw e;
  }
  log(`listening on ${o.socketPath}`);
  load();
  rest();
  return { done, stop: (reason = 'stopped') => stop('shutdown', reason), status };
}

/**
 * The process entry the window side spawns (detached, its output in the host log): serves on this host's socket until idle or
 * shut down, and returns the exit code. `NOTA_BENE_TEST_WHISPER_IDLE_MS` shortens the idle time (tests and smoke runs only).
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const log = (m: string) => console.error(`${new Date().toISOString()} whisper-host ${process.pid}: ${m}`);
  const idleMs = Number(env.NOTA_BENE_TEST_WHISPER_IDLE_MS);
  const host = await startHost({ socketPath: hostSocketPath(), idleMs: idleMs > 0 ? idleMs : undefined, log });
  if (!host) {
    log('another host already serves this socket');
    return 0;
  }
  const signals = ['SIGTERM', 'SIGINT'] as const;
  const onSignal = (sig: string) => void host.stop(sig);
  for (const sig of signals) process.on(sig, onSignal);
  const code = await host.done;
  for (const sig of signals) process.off(sig, onSignal);
  return code;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(self)) {
  main().then((code) => process.exit(code), (e) => {
    console.error(e);
    process.exit(1);
  });
}
