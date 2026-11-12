import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPipeline } from './install.ts';
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
    expect(made[0]!.data).toEqual({ dir: '/prefix', pkg: WHISPER_PACKAGE, model: WHISPER_MODEL, revision: WHISPER_REVISION, dtype: WHISPER_DTYPE, download: false });
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
  it('only a load that asks for it may download: `download` is true for the installer\'s load and false otherwise', async () => {
    const seen: unknown[] = [];
    const factory = (d: { download: boolean }) => { seen.push(d.download); return new FakeWorker(d); };
    await openPipeline('/p', { worker: factory }).ready;
    await openPipeline('/p', { worker: factory, download: false }).ready;
    await openPipeline('/p', { worker: factory, download: true }).ready;
    expect(seen).toEqual([false, false, true]);
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
    // the model is the pinned revision's folder (no revision option: it is in the path)
    expect(out.text).toBe(`automatic-speech-recognition|${path.join(dir, 'models', WHISPER_MODEL, WHISPER_REVISION)}||${WHISPER_DTYPE}|5|ru|false|${path.join(dir, 'models')}`);
    await pipe.dispose?.();
  });
  /** A package in place of transformers.js that writes down what it was asked to load and whether the load may fetch the model. */
  const recording = (): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-pipe-'));
    const pkg = path.join(dir, 'node_modules', '@huggingface', 'transformers');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: WHISPER_PACKAGE, version: '0.0.0', type: 'module', main: 'index.js' }));
    const record = path.join(dir, 'load.json');
    fs.writeFileSync(path.join(pkg, 'index.js'), `import fs from 'node:fs';
export const env = { allowRemoteModels: true }; // transformers.js's own default
export const pipeline = async (task, model, options) => { fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ task, model, options, remote: env.allowRemoteModels })); return async () => ({ text: '' }); };`);
    return record;
  };
  const loaded = (record: string): { task: string; model: string; options: Record<string, unknown>; remote: boolean } => JSON.parse(fs.readFileSync(record, 'utf8'));
  it('a load reads the files in the install and nothing else: transformers.js is told not to fetch the model (its default is to)', async () => {
    const record = recording();
    const pipe = await openPipeline(dir).ready;
    await pipe.dispose?.();
    expect(loaded(record).remote).toBe(false);
  });
  it('a load goes by the path of the pinned revision\'s folder, not by the model id: the library\'s file probe ignores the revision, finds no processor offline, and every job would fail', async () => {
    const record = recording();
    const pipe = await openPipeline(dir).ready;
    await pipe.dispose?.();
    expect(loaded(record)).toEqual({ task: 'automatic-speech-recognition', model: path.join(dir, 'models', WHISPER_MODEL, WHISPER_REVISION), options: { dtype: WHISPER_DTYPE }, remote: false });
  });
  it('the transcription load (loadPipeline) is such a load', async () => {
    const record = recording();
    const pipe = await loadPipeline(dir);
    await pipe.dispose?.();
    expect(loaded(record)).toMatchObject({ model: path.join(dir, 'models', WHISPER_MODEL, WHISPER_REVISION), remote: false });
  });
  it('the installer\'s load (download) goes by the model id and the pinned revision, and may fetch the model', async () => {
    const record = recording();
    const pipe = await openPipeline(dir, { download: true }).ready;
    await pipe.dispose?.();
    expect(loaded(record)).toEqual({ task: 'automatic-speech-recognition', model: WHISPER_MODEL, options: { revision: WHISPER_REVISION, dtype: WHISPER_DTYPE }, remote: true });
  });
  it('the detect op softmaxes the language tokens after the start token (a Tensor decoder input, no past cache)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-pipe-'));
    const pkg = path.join(dir, 'node_modules', '@huggingface', 'transformers');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: WHISPER_PACKAGE, version: '0.0.0', type: 'module', main: 'index.js' }));
    // vocabulary of 6 tokens: 0 = start, 1..3 = <|en|> <|ru|> <|fr|>, the model likes <|ru|>
    fs.writeFileSync(path.join(pkg, 'index.js'), `import fs from 'node:fs';
export const env = {};
export class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
export const pipeline = async () => Object.assign(async () => ({ text: '' }), {
  processor: async (audio) => ({ input_features: { n: audio.length } }),
  model: {
    config: {},
    generation_config: { decoder_start_token_id: 0, lang_to_id: { '<|en|>': 1, '<|ru|>': 2, '<|fr|>': 3 } },
    forward: async ({ input_features, decoder_input_ids }) => {
      if (!(decoder_input_ids instanceof Tensor) || decoder_input_ids.data[0] !== 0n || input_features.n !== 7) throw new Error('bad inputs');
      const t = (name) => ({ dispose() { fs.appendFileSync(${JSON.stringify(path.join(dir,'disposed.log'))}, name + '\\n'); } });
      return { logits: { dims: [1, 1, 6], data: Float32Array.from([9, 0, 3, 0, 9, 9]), ...t('logits') },
        past_key_values: { 'past.0.key': t('past.0.key'), 'past.0.value': t('past.0.value') }, encoder_last_hidden_state: t('hidden') };
    },
  },
});`);
    const h = openPipeline(dir);
    const pipe = await h.ready;
    const probs = await pipe.detect!(new Float32Array(7));
    // everything but the logits is released at once: past_key_values holds the cross-attention cache (~110 MB for whisper-small)
    const disposed = fs.readFileSync(path.join(dir, 'disposed.log'), 'utf8').split('\n').filter(Boolean).sort();
    expect(disposed).toEqual(['hidden', 'logits', 'past.0.key', 'past.0.value']);
    expect(Object.keys(probs).sort()).toEqual(['en', 'fr', 'ru']); // the language tokens only: 9s elsewhere do not count
    expect(probs.ru).toBeGreaterThan(0.9);
    expect(probs.en + probs.ru + probs.fr).toBeCloseTo(1, 6);
    await pipe.dispose?.();
  });
});
