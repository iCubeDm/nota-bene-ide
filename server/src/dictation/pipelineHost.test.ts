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
  it('detect() asks the worker for the language probabilities of the audio', async () => {
    class Prober extends FakeWorker {
      postMessage(m: { id: number }): void { this.sent.push(m); queueMicrotask(() => this.emit('message', { id: m.id, probs: { fr: 0.9, en: 0.1 } })); }
    }
    const w = new Prober({});
    const pipe = await openPipeline('/p', { worker: () => w }).ready;
    expect(await pipe.detect!(new Float32Array(4))).toEqual({ fr: 0.9, en: 0.1 });
    expect(w.sent).toEqual([{ id: 1, audio: new Float32Array(4), detect: true }]);
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
  it('the detect op softmaxes the language tokens after the start token (a Tensor decoder input, no past cache)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-pipe-'));
    const pkg = path.join(dir, 'node_modules', '@huggingface', 'transformers');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: WHISPER_PACKAGE, version: '0.0.0', type: 'module', main: 'index.js' }));
    // vocabulary of 6 tokens: 0 = start, 1..3 = <|en|> <|ru|> <|fr|>, the model likes <|ru|>
    fs.writeFileSync(path.join(pkg, 'index.js'), `export const env = {};
export class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
export const pipeline = async () => Object.assign(async () => ({ text: '' }), {
  processor: async (audio) => ({ input_features: { n: audio.length } }),
  model: {
    config: {},
    generation_config: { decoder_start_token_id: 0, lang_to_id: { '<|en|>': 1, '<|ru|>': 2, '<|fr|>': 3 } },
    forward: async ({ input_features, decoder_input_ids }) => {
      if (!(decoder_input_ids instanceof Tensor) || decoder_input_ids.data[0] !== 0n || input_features.n !== 7) throw new Error('bad inputs');
      return { logits: { dims: [1, 1, 6], data: Float32Array.from([9, 0, 3, 0, 9, 9]) } };
    },
  },
});`);
    const h = openPipeline(dir);
    const pipe = await h.ready;
    const probs = await pipe.detect!(new Float32Array(7));
    expect(Object.keys(probs).sort()).toEqual(['en', 'fr', 'ru']); // the language tokens only: 9s elsewhere do not count
    expect(probs.ru).toBeGreaterThan(0.9);
    expect(probs.en + probs.ru + probs.fr).toBeCloseTo(1, 6);
    await pipe.dispose?.();
  });
});
