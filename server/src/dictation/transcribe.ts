// Speech to text on the host: one cached Whisper pipeline (the installer's loader, in a worker thread), one language per call.
import { loadPipeline, type Pipe } from './install.ts';
import { speak, type Spoken } from './speak.ts';

export type { Spoken };

/** The transcriber the routes use, in the shape their injectable fakes have. */
export const transcribeWith = (pcm: Float32Array, lang: string, detect?: boolean): Promise<Spoken> => transcribe(pcm, lang, { detect });

/** What a transcriber may answer: the text alone is a fake's shorthand (no language known). */
export type SpokenOrText = string | Spoken;
export const spokenOf = (v: SpokenOrText): { text: string; lang?: string } => (typeof v === 'string' ? { text: v } : v);

let cached: Promise<Pipe> | undefined;

// one at a time across the routes that transcribe (dictation, voice messages and clips): the model is single-threaded
// and memory-heavy
let queue: Promise<unknown> = Promise.resolve();

/** Runs `job` after every job queued before it; its failure does not hold the next one. */
export function queued<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job);
  queue = run.catch(() => {});
  return run;
}

/** Forgets the loaded pipeline and ends its worker, which frees the native memory (tests; and after the install is removed). */
export function resetTranscriber(): void {
  const p = cached;
  cached = undefined;
  void p?.then((pipe) => pipe.dispose?.()).catch(() => {});
}

/**
 * `lang` is the language to transcribe in, or, with `detect`, the hint: the language detected from the first 30 s when the model
 * is sure enough (detect.ts), else `lang`. The answer names the language used.
 */
export async function transcribe(pcm: Float32Array, lang: string, o: { load?: () => Promise<Pipe>; detect?: boolean } = {}): Promise<Spoken> {
  for (let attempt = 0; ; attempt++) {
    const p = cached ??= (o.load ?? (() => loadPipeline()))();
    let pipe: Pipe;
    try { pipe = await p; } catch (e) { if (cached === p) cached = undefined; throw e; }
    // the worker died since the last call: load a fresh one (once)
    if (pipe.dead && attempt === 0) { if (cached === p) cached = undefined; continue; }
    return speak(pipe, pcm, lang, o.detect);
  }
}
