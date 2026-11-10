import { describe, expect, it } from 'vitest';
import { splitPcm } from './parts.ts';

const RATE = 16000;

/** [seconds] of loud sound (a square wave), silent over each of [quiet] (start, end in seconds) */
function recording(seconds: number, quiet: [number, number][] = []): Float32Array {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i / RATE;
    out[i] = quiet.some(([a, b]) => s >= a && s < b) ? 0 : Math.floor(i / 20) % 2 === 0 ? 0.27 : -0.27;
  }
  return out;
}
const secs = (p: Float32Array) => p.length / RATE;

describe('splitPcm', () => {
  it('a recording up to a minute is one part, as it is', () => {
    const pcm = recording(60);
    // identity, not toEqual: a deep compare of 960 000 samples outlasts the timeout on a slow runner
    const parts = splitPcm(pcm);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(pcm);
  });
  it('a long recording is cut at its quiet moments, 30 to 60 s apart', () => {
    const parts = splitPcm(recording(150, [[44.9, 45.1], [94.9, 95.1]]));
    expect(parts.map(secs).map((s) => Math.round(s * 10) / 10)).toEqual([45, 50, 55]);
  });
  it('no sample is lost or repeated between the parts', () => {
    const pcm = recording(130, [[40, 40.3], [100, 100.3]]);
    const parts = splitPcm(pcm);
    const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { joined.set(p, at); at += p.length; }
    // bytes, not toEqual: two million elements compared one by one are slow on a CI runner
    expect(Buffer.from(joined.buffer).equals(Buffer.from(pcm.buffer))).toBe(true);
  });
  it('without a pause the parts still stay within 30 to 60 s', () => {
    const parts = splitPcm(recording(200));
    for (const p of parts.slice(0, -1)) { expect(secs(p)).toBeGreaterThanOrEqual(30); expect(secs(p)).toBeLessThanOrEqual(60); }
    expect(secs(parts.at(-1)!)).toBeLessThanOrEqual(60);
  });
  it('the last part is never a short tail: 61 s goes as two halves', () => {
    const parts = splitPcm(recording(61, [[60.5, 61]]));
    expect(parts.length).toBe(2);
    for (const p of parts) expect(secs(p)).toBeGreaterThanOrEqual(30);
  });
});
