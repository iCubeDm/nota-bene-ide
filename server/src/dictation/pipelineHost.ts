// The main-thread side of the Whisper pipeline: a worker thread owns the model (see pipelineWorker.mjs), this file talks to it.
//
// Where the worker file lives: the checkout runs the server as .ts from server/src/dictation/; the published package is one
// esbuild bundle at server/src/main.js (and the Whisper host another, server/src/host.js), so import.meta.url differs and
// scripts/build-package.mjs copies pipelineWorker.mjs (and npm-shrinkwrap.json) to server/src/dictation/ of the package.
// `dictationAssetDir()` resolves both, for either bundle: they sit in the same folder.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { WHISPER_DTYPE, WHISPER_MODEL, WHISPER_PACKAGE, WHISPER_REVISION } from './whisper.ts';

export type Pipe = {
  (audio: Float32Array, opts: object): Promise<{ text?: string }>;
  /** Language probabilities (code -> 0..1) of the first 30 s of `audio`; absent on a pipeline that cannot tell (a fake). */
  detect?: (audio: Float32Array) => Promise<Record<string, number>>;
  dispose?: () => Promise<void>;
  dead?: boolean;
};

/** What the host needs from a worker_threads Worker (tests pass a fake). */
export interface WorkerLike {
  postMessage(m: unknown): void;
  terminate(): Promise<number> | void;
  on(event: 'message' | 'error' | 'exit', fn: (...a: any[]) => void): unknown;
}
export type WorkerFactory = (data: WorkerData) => WorkerLike;
/** `download`: the load may fetch the model (the installer's, once); every other load reads the files in the install and nothing else. */
export type WorkerData = { dir: string; pkg: string; model: string; revision: string; dtype: string; download: boolean };

/** The folder holding pipelineWorker.mjs and npm-shrinkwrap.json: beside this file in the checkout, server/src/dictation/ beside the bundle (main.js or host.js). */
export function dictationAssetDir(): string {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith('.ts') ? path.dirname(here) : path.join(path.dirname(here), 'dictation');
}

/** How long a disposed worker gets to free its model and exit before it is terminated. */
const DISPOSE_GRACE_MS = 3000;

export const defaultFactory: WorkerFactory = (data) => new Worker(path.join(dictationAssetDir(), 'pipelineWorker.mjs'), { workerData: data });

/**
 * Starts the worker, which loads the pipeline from the prefix `dir`. `close` ends it at once (a rejected `ready` if still loading).
 * Only `download: true` (the installer) lets transformers.js fetch the model: a load of an install that is being removed must fail,
 * not download the model again into a folder that Remove is deleting.
 */
export function openPipeline(dir: string, o: { worker?: WorkerFactory; download?: boolean } = {}): { ready: Promise<Pipe>; close: (why?: Error) => void } {
  const w = (o.worker ?? defaultFactory)({ dir, pkg: WHISPER_PACKAGE, model: WHISPER_MODEL, revision: WHISPER_REVISION, dtype: WHISPER_DTYPE, download: o.download === true });
  const pending = new Map<number, { resolve: (v: { text?: string; probs?: Record<string, number> }) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let ended = false;
  let settle!: { resolve: (p: Pipe) => void; reject: (e: Error) => void };
  const ready = new Promise<Pipe>((resolve, reject) => { settle = { resolve, reject }; });
  ready.catch(() => {}); // `close` may reject it with nobody waiting

  let finished!: () => void;
  const gone = new Promise<void>((r) => { finished = r; });
  const end = (why: Error) => {
    if (ended) return;
    ended = true;
    finished();
    pipe.dead = true;
    settle.reject(why);
    for (const p of pending.values()) p.reject(why);
    pending.clear();
    void Promise.resolve(w.terminate()).catch(() => {});
  };
  const call = (msg: object) => new Promise<{ text?: string; probs?: Record<string, number> }>((resolve, reject) => {
    if (ended) return reject(new Error('the Whisper worker is gone'));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, ...msg });
  });
  const pipe: Pipe = Object.assign(
    (audio: Float32Array, opts: object) => call({ audio, opts }),
    {
      dead: false,
      detect: async (audio: Float32Array) => (await call({ audio, detect: true })).probs ?? {},
      // let the worker dispose the ONNX sessions and exit by itself; terminate it if it does not within a few seconds
      dispose: async () => {
        if (ended) return;
        w.postMessage({ type: 'dispose' });
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([gone, new Promise<void>((r) => { timer = setTimeout(r, DISPOSE_GRACE_MS); })]);
        clearTimeout(timer);
        end(new Error('the Whisper worker was stopped'));
      },
    },
  );

  w.on('message', (m: { type?: string; id?: number; text?: string; probs?: Record<string, number>; error?: string; message?: string }) => {
    if (m.type === 'ready') return settle.resolve(pipe);
    if (m.type === 'error') return end(new Error(m.message ?? 'Whisper worker failed'));
    const p = m.id === undefined ? undefined : pending.get(m.id);
    if (!p) return;
    pending.delete(m.id!);
    if (m.error !== undefined) p.reject(new Error(m.error)); else p.resolve({ text: m.text, probs: m.probs });
  });
  w.on('error', (e: Error) => end(e));
  w.on('exit', (code: number) => end(new Error(`the Whisper worker exited (${code})`)));
  return { ready, close: (why = new Error('closed')) => end(why) };
}
