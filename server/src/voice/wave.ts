// What a voice bubble draws before its audio is fetched: the recording's loudness in VOICE_BARS bars.
import { VOICE_BARS } from '@nota-bene/shared';

/** The peak of each of VOICE_BARS equal slices of `pcm`, scaled so the loudest is 31; silence is all zeros. */
export function waveOf(pcm: Float32Array | Int16Array): number[] {
  const peaks = Array.from({ length: VOICE_BARS }, (_, b) => {
    let peak = 0;
    const end = Math.floor(((b + 1) * pcm.length) / VOICE_BARS);
    for (let i = Math.floor((b * pcm.length) / VOICE_BARS); i < end; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
    return peak;
  });
  const top = Math.max(...peaks);
  return top === 0 ? peaks.map(() => 0) : peaks.map((p) => Math.round((p / top) * 31));
}

/** 16 kHz: 16 samples a millisecond. */
export const msOf = (pcm: { length: number }): number => Math.round(pcm.length / 16);
