// Spoken-language detection on top of the loaded pipeline: the model thread gives language probabilities (pipelineWorker.mjs),
// this decides what to do with them. Pure apart from the pipeline call, so the thresholds are unit-tested.
import type { Pipe } from './install.ts';
import { DETECT_MIN_MS, DETECT_MIN_P, DETECT_WINDOW_MS, WHISPER_RATE } from './whisper.ts';

/** The most probable language when it is at least DETECT_MIN_P, else `hint`. */
export function pickLang(probs: Record<string, number>, hint: string): string {
  let best: string | undefined;
  let p = 0;
  for (const [lang, v] of Object.entries(probs)) if (v > p) { best = lang; p = v; }
  return best !== undefined && p >= DETECT_MIN_P ? best : hint;
}

let reported = false;

/**
 * The language to transcribe `pcm` in: detected from its first 30 s, `hint` when the clip is too short, the pipeline
 * cannot detect, or detection fails (reported once; a failed detection must not lose the transcript).
 */
export async function resolveLang(pipe: Pipe, pcm: Float32Array, hint: string): Promise<string> {
  if (!pipe.detect || pcm.length < WHISPER_RATE * DETECT_MIN_MS / 1000) return hint;
  try {
    return pickLang(await pipe.detect(pcm.subarray(0, WHISPER_RATE * DETECT_WINDOW_MS / 1000)), hint);
  } catch (e) {
    if (!reported) {
      reported = true;
      console.error('[dictation] language detection failed, using the hint:', e);
    }
    return hint;
  }
}
