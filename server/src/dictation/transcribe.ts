// Speech to text on the host: one cached Whisper pipeline (the installer's loader), one language per call.
import { loadPipeline, type Pipe } from './install.ts';

let cached: Promise<Pipe> | undefined;

/** Forgets the loaded pipeline (tests; and after the install is removed). */
export function resetTranscriber(): void { cached = undefined; }

export async function transcribe(pcm: Float32Array, lang: string, o: { load?: () => Promise<Pipe> } = {}): Promise<string> {
  const p = cached ??= (o.load ?? (() => loadPipeline()))();
  let pipe: Pipe;
  try { pipe = await p; } catch (e) { if (cached === p) cached = undefined; throw e; }
  const out = await pipe(pcm, { language: lang, task: 'transcribe' });
  return (out.text ?? '').trim();
}
