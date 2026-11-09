// Speech to text on the host: one cached Whisper pipeline (the installer's loader, in a worker thread), one language per call.
import { loadPipeline, type Pipe } from './install.ts';

let cached: Promise<Pipe> | undefined;

/** Forgets the loaded pipeline and ends its worker, which frees the native memory (tests; and after the install is removed). */
export function resetTranscriber(): void {
  const p = cached;
  cached = undefined;
  void p?.then((pipe) => pipe.dispose?.()).catch(() => {});
}

export async function transcribe(pcm: Float32Array, lang: string, o: { load?: () => Promise<Pipe> } = {}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const p = cached ??= (o.load ?? (() => loadPipeline()))();
    let pipe: Pipe;
    try { pipe = await p; } catch (e) { if (cached === p) cached = undefined; throw e; }
    // the worker died since the last call: load a fresh one (once)
    if (pipe.dead && attempt === 0) { if (cached === p) cached = undefined; continue; }
    // transformers.js slices the input to 30 s unless it chunks: 30 s windows with a 5 s stride, joined by the pipeline
    const out = await pipe(pcm, { language: lang, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    return (out.text ?? '').trim();
  }
}
