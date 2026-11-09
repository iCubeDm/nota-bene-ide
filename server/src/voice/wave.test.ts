import { describe, expect, it } from 'vitest';
import { VOICE_BARS } from '@nota-bene/shared';
import { msOf, waveOf } from './wave.ts';

describe('waveOf', () => {
  it('48 bars, the loudest is 31', () => {
    const pcm = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 3) * (i < 8000 ? 0.1 : 0.5));
    const w = waveOf(pcm);
    expect(w).toHaveLength(VOICE_BARS);
    expect(Math.max(...w)).toBe(31);
    expect(w[0]).toBeLessThan(w[47]!);
    expect(w.every((b) => Number.isInteger(b) && b >= 0 && b <= 31)).toBe(true);
  });
  it('silence is all zeros', () => {
    expect(waveOf(new Float32Array(16000))).toEqual(Array(VOICE_BARS).fill(0));
  });
  it('a ramp gives bars that never fall', () => {
    const w = waveOf(Float32Array.from({ length: 48_000 }, (_, i) => i / 48_000));
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeGreaterThanOrEqual(w[i - 1]!);
  });
  it('a recording shorter than the bars still gives 48 of them', () => {
    expect(waveOf(Float32Array.from({ length: 10 }, () => 0.5))).toHaveLength(VOICE_BARS);
    expect(waveOf(new Float32Array(0))).toEqual(Array(VOICE_BARS).fill(0));
  });
});

describe('msOf', () => {
  it('16 samples are a millisecond', () => {
    expect(msOf(new Float32Array(16000 * 3 + 8))).toBe(3001);
    expect(msOf(new Float32Array(16000))).toBe(1000);
  });
});
