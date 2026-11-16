import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CUT_PEAKS_RATE } from '@nota-bene/shared/cut';
import { findFfmpeg } from './ffmpeg.ts';
import { CutPeaks, PeaksError, peakSink } from './peaks.ts';

let root: string;
const made: CutPeaks[] = [];
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-cut-peaks-'))); });
afterEach(() => {
  while (made.length) made.pop()!.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
const make = (o: Partial<ConstructorParameters<typeof CutPeaks>[0]> = {}) => {
  const p = new CutPeaks({ root: () => root, ffmpeg: () => findFfmpeg(), ...o });
  made.push(p);
  return p;
};
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PeaksError) return [e.status, e.code];
    throw e;
  }
  throw new Error('not refused');
};

describe('peakSink', () => {
  it('the loudest sample of each `per` samples (16-bit little-endian) as 0..255, across chunk borders', () => {
    const s = peakSink(4);
    const pcm = Buffer.alloc(2 * 10);
    [0, 100, -32768, 5, 16384, 0, 0, 0, 1, -2].forEach((v, i) => pcm.writeInt16LE(v, 2 * i));
    s.push(pcm.subarray(0, 5)); // half a sample
    s.push(pcm.subarray(5));
    // the last, short group counts too
    expect([...s.end()]).toEqual([255, 128, 0]);
  });
});

describe('CutPeaks', () => {
  it('refuses a path outside the project, a file that is not video or sound, a missing one, and runs nothing without ffmpeg', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(root, 'a.wav'), 'x');
    const p = make();
    expect(await refused(p.get('../x.wav'))).toEqual([403, 'outside-project']);
    expect(await refused(p.get('a.txt'))).toEqual([400, 'not-media']);
    expect(await refused(p.get('gone.wav'))).toEqual([404, 'not-found']);
    expect(await refused(make({ ffmpeg: () => null }).get('a.wav'))).toEqual([501, 'no-ffmpeg']);
  });

  const real = findFfmpeg();
  it.skipIf(!real)('reads a sound through ffmpeg: CUT_PEAKS_RATE peaks a second, once per file version; no sound is 422', async () => {
    const ff = (...args: string[]) => execFileSync(real!, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    // 1 s quiet, 1 s loud
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-filter_complex', '[0]volume=0.1[a];[1]volume=7[b];[a][b]concat=n=2:v=0:a=1', path.join(root, 'tone.wav'));
    ff('-f', 'lavfi', '-i', 'color=c=blue:size=32x32:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, 'mute.mp4'));
    let spawned = 0;
    const p = make({ spawned: () => void spawned++ });
    const [a, b] = await Promise.all([p.get('tone.wav'), p.get('tone.wav')]);
    expect(a).toBe(b);
    expect(spawned).toBe(1);
    expect(Math.abs(a.length - 2 * CUT_PEAKS_RATE)).toBeLessThanOrEqual(2);
    const quiet = Math.max(...a.subarray(10, 90));
    const loud = Math.max(...a.subarray(110, 190));
    expect(quiet).toBeLessThan(40);
    expect(loud).toBeGreaterThan(200);
    await p.get('tone.wav');
    expect(spawned).toBe(1);
    // a new version of the file is read again
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'tone.wav'), t, t);
    await p.get('tone.wav');
    expect(spawned).toBe(2);
    expect(await refused(p.get('mute.mp4'))).toEqual([422, 'no-audio']);
  }, 30_000);
});
