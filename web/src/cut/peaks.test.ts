import { expect, it, vi } from 'vitest';
import { BROWSER_MAX, peaksFromChannels, peaksLoader } from './peaks.ts';

const bytes = (a: number[]) => new Response(new Uint8Array(a), { status: 200 });
const status = (n: number) => new Response(JSON.stringify({ error: 'x' }), { status: n });
const sized = (n: number) => new Response(new Uint8Array(4), { status: 200, headers: { 'content-length': String(n) } });

it('peaksFromChannels: the loudest sample of either channel in each 1/100 s as 0..255', () => {
  const left = new Float32Array(250).fill(0.1);
  const right = new Float32Array(250);
  right[5] = -1;
  left[120] = 0.5;
  // 1000 samples a second: 10 per peak, 25 peaks
  const p = peaksFromChannels([left, right], 1000);
  expect(p.length).toBe(25);
  expect(p[0]).toBe(255);
  expect(p[1]).toBe(Math.round(0.1 * 255));
  expect(p[12]).toBe(Math.round(0.5 * 255));
});

it('asks the server first, once per source; no sound there is no waveform', async () => {
  const fetchPeaks = vi.fn(async (src: string) => (src === 'a.wav' ? bytes([1, 2, 3]) : status(422)));
  const fetchFile = vi.fn(async () => sized(10));
  const load = peaksLoader({ fetchPeaks, fetchFile, decode: async () => { throw new Error('no'); } });
  const [a, b] = await Promise.all([load('a.wav', 'here'), load('a.wav', 'here')]);
  expect([...a!]).toEqual([1, 2, 3]);
  expect(b).toBe(a);
  expect(fetchPeaks).toHaveBeenCalledTimes(1);
  expect(await load('silent.mp4', 'here')).toBeNull();
  expect(fetchFile).not.toHaveBeenCalled();
});

it('without the server\'s peaks (an older server, no ffmpeg, another branch) a file up to BROWSER_MAX is decoded in the page', async () => {
  const decode = vi.fn(async () => ({ sampleRate: 1000, numberOfChannels: 1, getChannelData: () => new Float32Array(20).fill(1) }));
  const fetchFile = vi.fn(async (url: string) => (url.includes('big') ? sized(BROWSER_MAX + 1) : sized(100)));
  const fetchPeaks = vi.fn(async () => status(501));
  const load = peaksLoader({ fetchPeaks, fetchFile, decode });
  expect([...(await load('a.wav', 'here'))!]).toEqual([255, 255]);
  expect(fetchFile).toHaveBeenCalledWith('/file?path=a.wav');
  expect(await load('big.wav', 'here')).toBeNull();
  expect(decode).toHaveBeenCalledTimes(1);
  // another branch: the server reads only this checkout's files
  await load('b.wav', 'branch:x');
  expect(fetchPeaks).toHaveBeenCalledTimes(2);
  expect(fetchFile).toHaveBeenLastCalledWith('/file?path=b.wav&src=branch%3Ax');
});

it('a failure is not remembered: the next ask tries again', async () => {
  let fail = true;
  const fetchPeaks = vi.fn(async () => { if (fail) throw new Error('offline'); return bytes([9]); });
  const load = peaksLoader({ fetchPeaks, fetchFile: async () => { throw new Error('offline'); }, decode: async () => { throw new Error('no'); } });
  expect(await load('a.wav', 'here')).toBeNull();
  fail = false;
  expect([...(await load('a.wav', 'here'))!]).toEqual([9]);
});
