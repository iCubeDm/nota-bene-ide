import { describe, expect, it } from 'vitest';
import { resetTranscriber, transcribe } from './transcribe.ts';

describe('transcribe', () => {
  it('loads the pipeline once for concurrent calls and passes the language', async () => {
    resetTranscriber();
    let loads = 0;
    const calls: { opts: unknown }[] = [];
    const load = async () => { loads++; return async (_a: Float32Array, opts: unknown) => { calls.push({ opts }); return { text: '  hello  ' }; }; };
    const pcm = new Float32Array(1600);
    const [a, b] = await Promise.all([transcribe(pcm, 'ru', { load }), transcribe(pcm, 'en', { load })]);
    expect(a).toBe('hello');
    expect(b).toBe('hello');
    expect(loads).toBe(1);
    expect(calls.map((c) => c.opts)).toEqual([{ language: 'ru', task: 'transcribe' }, { language: 'en', task: 'transcribe' }]);
  });
  it('retries the load after a failure', async () => {
    resetTranscriber();
    let n = 0;
    const load = async () => { if (n++ === 0) throw new Error('boom'); return async () => ({ text: 'ok' }); };
    await expect(transcribe(new Float32Array(1), 'en', { load })).rejects.toThrow('boom');
    expect(await transcribe(new Float32Array(1), 'en', { load })).toBe('ok');
  });
});
