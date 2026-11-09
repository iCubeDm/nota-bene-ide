// A long recording cut into parts the window's Whisper takes one at a time: a part ends at the quietest moment between
// 30 and 60 s into it, so a word is not split between two parts. The phone did this before the host kept recordings.
const RATE = 16000;
const PART_MIN = 30 * RATE, PART_MAX = 60 * RATE;

// the loudness is summed per 50 ms; the quietest 250 ms is where the part ends, in its middle
const FRAME = RATE / 20;
const WINDOW = 5;

/** Views into `pcm` (16 kHz mono, floats or 16-bit samples), nothing copied; a recording up to a minute is returned as it is. */
export function splitPcm<T extends Float32Array | Int16Array>(pcm: T): T[] {
  const n = pcm.length;
  if (n <= PART_MAX) return [pcm];
  const parts: T[] = [];
  let start = 0;
  while (n - start > PART_MAX) {
    // the last part keeps at least 30 s too: Whisper makes words up for a short tail of silence
    const hi = n - start < PART_MAX + PART_MIN
      ? Math.min(Math.max(n - PART_MIN, start + PART_MIN), start + PART_MAX)
      : start + PART_MAX;
    const end = quietest(pcm, start + PART_MIN, hi);
    parts.push(pcm.subarray(start, end) as T);
    start = end;
  }
  parts.push(pcm.subarray(start) as T);
  return parts;
}

/** The middle of the quietest window in [lo, hi): the later one of equals, for fewer parts. */
function quietest(pcm: Float32Array | Int16Array, lo: number, hi: number): number {
  const frames = Array.from({ length: Math.floor((hi - lo) / FRAME) }, (_, f) => {
    let sum = 0;
    for (let i = lo + f * FRAME; i < lo + (f + 1) * FRAME; i++) sum += Math.abs(pcm[i]!);
    return sum;
  });
  let energy = frames.slice(0, WINDOW).reduce((a, b) => a + b, 0);
  let best = 0, least = energy;
  for (let i = 1; i + WINDOW <= frames.length; i++) {
    energy += frames[i + WINDOW - 1]! - frames[i - 1]!;
    if (energy <= least) { best = i; least = energy; }
  }
  return lo + best * FRAME + (WINDOW * FRAME) / 2;
}
