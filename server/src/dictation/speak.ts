// One transcription on a loaded pipeline: this process's (transcribe.ts) and the Whisper host's (hostMain.ts) both run it, so
// they run it the same way. Kept apart from transcribe.ts so that the host does not import the window side (hostClient.ts).
import { resolveLang } from './detect.ts';
import type { Pipe } from './pipelineHost.ts';

/** A transcript and the language it was made in. */
export type Spoken = { text: string; lang: string };

/**
 * `lang` is the language to transcribe in, or, with `detect`, the hint: the language detected from the first 30 s when the model
 * is sure enough (detect.ts), else `lang`. The answer names the language used.
 */
export async function speak(pipe: Pipe, pcm: Float32Array, lang: string, detect?: boolean): Promise<Spoken> {
  // transformers.js slices the input to 30 s unless it chunks: 30 s windows with a 5 s stride, joined by the pipeline
  const language = detect ? await resolveLang(pipe, pcm, lang) : lang;
  const out = await pipe(pcm, { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
  return { text: (out.text ?? '').trim(), lang: language };
}
