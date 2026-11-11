import { describe, expect, it } from 'vitest';
import { resetTranscriber, transcribe } from './transcribe.ts';

describe('transcribe', () => {
  it('without detect the language is the one asked for, whatever the pipeline could detect', async () => {
    resetTranscriber();
    const calls: unknown[] = [];
    let detects = 0;
    const load = async () => Object.assign(async (_a: Float32Array, opts: unknown) => { calls.push(opts); return { text: 'x' }; }, { detect: async () => { detects++; return { fr: 0.99 }; } });
    expect(await transcribe(new Float32Array(32000), 'ru', { load })).toEqual({ text: 'x', lang: 'ru' });
    expect(detects).toBe(0);
    expect(calls).toEqual([{ language: 'ru', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 }]);
  });
  it('with detect it transcribes in the detected language and says which', async () => {
    resetTranscriber();
    const calls: unknown[] = [];
    const load = async () => Object.assign(async (_a: Float32Array, opts: unknown) => { calls.push(opts); return { text: 'bonjour' }; }, { detect: async () => ({ fr: 0.8, en: 0.2 }) });
    expect(await transcribe(new Float32Array(32000), 'en', { load, detect: true })).toEqual({ text: 'bonjour', lang: 'fr' });
    expect(calls).toEqual([{ language: 'fr', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 }]);
  });
  it('with detect and a doubtful or too short clip it keeps the hint', async () => {
    resetTranscriber();
    const load = async () => Object.assign(async () => ({ text: 'x' }), { detect: async () => ({ fr: 0.4, en: 0.3 }) });
    expect((await transcribe(new Float32Array(32000), 'de', { load, detect: true })).lang).toBe('de');
    expect((await transcribe(new Float32Array(100), 'de', { load: async () => Object.assign(async () => ({ text: 'x' }), { detect: async () => ({ fr: 1 }) }), detect: true })).lang).toBe('de');
  });
  it('loads the pipeline once for concurrent calls and passes the language', async () => {
    resetTranscriber();
    let loads = 0;
    const calls: { opts: unknown }[] = [];
    const load = async () => { loads++; return async (_a: Float32Array, opts: unknown) => { calls.push({ opts }); return { text: '  hello  ' }; }; };
    const pcm = new Float32Array(1600);
    const [a, b] = await Promise.all([transcribe(pcm, 'ru', { load }), transcribe(pcm, 'en', { load })]);
    expect(a).toEqual({ text: 'hello', lang: 'ru' });
    expect(b).toEqual({ text: 'hello', lang: 'en' });
    expect(loads).toBe(1);
    // transformers.js slices the input to 30 s unless it is told to chunk
    expect(calls.map((c) => c.opts)).toEqual([
      { language: 'ru', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 },
      { language: 'en', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 },
    ]);
  });
  it('retries the load after a failure', async () => {
    resetTranscriber();
    let n = 0;
    const load = async () => { if (n++ === 0) throw new Error('boom'); return async () => ({ text: 'ok' }); };
    await expect(transcribe(new Float32Array(1), 'en', { load })).rejects.toThrow('boom');
    expect((await transcribe(new Float32Array(1), 'en', { load })).text).toBe('ok');
  });
  it('reset disposes the loaded pipeline, so its worker and native memory go', async () => {
    resetTranscriber();
    let disposed = 0;
    const load = async () => Object.assign(async () => ({ text: 'x' }), { dispose: async () => { disposed++; } });
    await transcribe(new Float32Array(1), 'en', { load });
    resetTranscriber();
    await new Promise((r) => setTimeout(r, 0));
    expect(disposed).toBe(1);
  });
  it('loads a new pipeline when the worker of the old one died', async () => {
    resetTranscriber();
    let loads = 0;
    const load = async () => { loads++; const n = loads; return Object.assign(async () => ({ text: `p${n}` }), { dead: n === 1 }); };
    expect((await transcribe(new Float32Array(1), 'en', { load })).text).toBe('p2');
    expect(loads).toBe(2);
  });
  it('the default load goes through the worker factory, never the main thread', async () => {
    resetTranscriber();
    const { loadPipeline } = await import('./install.ts');
    const made: unknown[] = [];
    const w = Object.assign(new (await import('node:events')).EventEmitter(), { postMessage() {}, terminate: async () => 0 });
    const p = loadPipeline('/nowhere', { worker: (d) => { made.push(d); queueMicrotask(() => w.emit('message', { type: 'ready' })); return w; } });
    await p;
    expect(made).toHaveLength(1);
  });
});
