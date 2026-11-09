import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openPipeline, type WorkerLike } from './pipelineHost.ts';
import { WHISPER_DTYPE, WHISPER_MODEL, WHISPER_PACKAGE, WHISPER_REVISION } from './whisper.ts';

/** A worker that answers like pipelineWorker.mjs, without a thread. */
class FakeWorker extends EventEmitter implements WorkerLike {
  sent: unknown[] = [];
  terminated = 0;
  readonly data: unknown;
  constructor(data: unknown, auto: 'ready' | 'error' | 'silent' = 'ready') {
    super();
    this.data = data;
    queueMicrotask(() => {
      if (auto === 'ready') this.emit('message', { type: 'ready' });
      if (auto === 'error') this.emit('message', { type: 'error', message: 'no model' });
    });
  }
  postMessage(m: { id: number }): void {
    this.sent.push(m);
    queueMicrotask(() => this.emit('message', { id: m.id, text: ' spoken ' }));
  }
  terminate(): Promise<number> { this.terminated++; return Promise.resolve(0); }
}

describe('openPipeline', () => {
  it('runs the load and every call in the worker, handing it the pins', async () => {
    const made: FakeWorker[] = [];
    const h = openPipeline('/prefix', { worker: (d) => { const w = new FakeWorker(d); made.push(w); return w; } });
    const pipe = await h.ready;
    expect(made).toHaveLength(1);
    expect(made[0]!.data).toEqual({ dir: '/prefix', pkg: WHISPER_PACKAGE, model: WHISPER_MODEL, revision: WHISPER_REVISION, dtype: WHISPER_DTYPE });
    expect(await pipe(new Float32Array(3), { language: 'en' })).toEqual({ text: ' spoken ' });
    expect(made[0]!.sent).toEqual([{ id: 1, audio: new Float32Array(3), opts: { language: 'en' } }]);
  });
  it('rejects the load with the worker message and ends the worker', async () => {
    let w!: FakeWorker;
    const h = openPipeline('/p', { worker: (d) => (w = new FakeWorker(d, 'error')) });
    await expect(h.ready).rejects.toThrow('no model');
    expect(w.terminated).toBe(1);
  });
  it('close() rejects a pending load and terminates the worker', async () => {
    let w!: FakeWorker;
    const h = openPipeline('/p', { worker: (d) => (w = new FakeWorker(d, 'silent')) });
    h.close(new Error('timed out'));
    await expect(h.ready).rejects.toThrow('timed out');
    expect(w.terminated).toBe(1);
  });
  it('a worker that dies fails the pending call and marks the pipe dead; dispose terminates it', async () => {
    let w!: FakeWorker;
    const h = openPipeline('/p', { worker: (d) => (w = new FakeWorker(d)) });
    const pipe = await h.ready;
    w.postMessage = () => { /* never answers */ };
    const call = pipe(new Float32Array(1), {});
    w.emit('exit', 1);
    await expect(call).rejects.toThrow(/worker/);
    expect(pipe.dead).toBe(true);
    await pipe.dispose?.();
    expect(w.terminated).toBeGreaterThan(0);
  });
});

describe('pipelineWorker.mjs, for real', () => {
  let dir: string;
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  it('loads the package from the prefix in a thread and answers calls', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-pipe-'));
    const pkg = path.join(dir, 'node_modules', '@huggingface', 'transformers');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: WHISPER_PACKAGE, version: '0.0.0', type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(pkg, 'index.js'), `import { threadId, isMainThread } from 'node:worker_threads';
export const env = {};
export const pipeline = async (task, model, o) => async (audio, opts) => ({ text: [task, model, o.revision, o.dtype, audio.length, opts.language, isMainThread, env.cacheDir].join('|') });`);
    const h = openPipeline(dir);
    const pipe = await h.ready;
    const out = await pipe(new Float32Array(5), { language: 'ru' });
    expect(out.text).toBe(`automatic-speech-recognition|${WHISPER_MODEL}|${WHISPER_REVISION}|${WHISPER_DTYPE}|5|ru|false|${path.join(dir, 'models')}`);
    await pipe.dispose?.();
  });
});
