import { expect, it, vi } from 'vitest';
import { PAGE_MAX_BYTES, PAGE_MAX_SEC, peaksFromChannels, peaksLoader } from './peaks.ts';

const bytes = (a: number[]) => new Response(new Uint8Array(a), { status: 200 });
const status = (n: number) => new Response(JSON.stringify({ error: 'x' }), { status: n });
const sized = (n: number) => new Response(new Uint8Array(4), { status: 200, headers: { 'content-length': String(n) } });
const decoded = (n = 20) => ({ sampleRate: 1000, numberOfChannels: 1, getChannelData: () => new Float32Array(n).fill(1) });
const deps = (o: Partial<Parameters<typeof peaksLoader>[0]> = {}): Parameters<typeof peaksLoader>[0] => ({
  version: vi.fn(async () => 'v1'),
  fetchPeaks: vi.fn(async () => status(501)),
  fetchFile: vi.fn(async () => sized(100)),
  duration: vi.fn(async () => 60),
  decode: vi.fn(async () => decoded()),
  ...o,
});
const peaks = (r: unknown) => [...(r as { peaks: Uint8Array }).peaks];

it('peaksFromChannels: the loudest sample of either channel in each 1/100 s as 0..255', () => {
  const left = new Float32Array(250).fill(0.1);
  const right = new Float32Array(250);
  right[5] = -1;
  left[120] = 0.5;
  const p = peaksFromChannels([left, right], 1000);
  expect(p.length).toBe(25);
  expect(p[0]).toBe(255);
  expect(p[1]).toBe(Math.round(0.1 * 255));
  expect(p[12]).toBe(Math.round(0.5 * 255));
});

it('asks the server first, once per file version; no sound and a timeout are answers, kept for that version', async () => {
  let v = 'v1';
  const d = deps({
    version: vi.fn(async () => v),
    fetchPeaks: vi.fn(async (src: string) => (src === 'a.wav' ? bytes([1, 2, 3]) : status(src === 'slow.wav' ? 504 : 422))),
  });
  const load = peaksLoader(d);
  const [a, b] = await Promise.all([load('a.wav', 'here'), load('a.wav', 'here')]);
  expect(peaks(a)).toEqual([1, 2, 3]);
  expect(b).toBe(a);
  expect(await load('silent.mp4', 'here')).toEqual({ none: 'no-audio' });
  expect(await load('silent.mp4', 'here')).toEqual({ none: 'no-audio' });
  expect(await load('slow.wav', 'here')).toEqual({ none: 'timeout' });
  await load('slow.wav', 'here');
  expect(d.fetchPeaks).toHaveBeenCalledTimes(3);
  expect(d.fetchFile).not.toHaveBeenCalled();
  // the file changed (written again, or cut off before): read again
  v = 'v2';
  await load('a.wav', 'here');
  expect(d.fetchPeaks).toHaveBeenCalledTimes(4);
});

it('in the page (no server peaks): only a short, small file, one decode at a time', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let running = 0;
  let most = 0;
  const d = deps({
    fetchFile: vi.fn(async (url: string) => (url.includes('big') ? sized(PAGE_MAX_BYTES + 1) : sized(100))),
    duration: vi.fn(async (url: string) => (url.includes('long') ? PAGE_MAX_SEC + 1 : 60)),
    decode: vi.fn(async () => {
      most = Math.max(most, ++running);
      await gate;
      running--;
      return decoded();
    }),
  });
  const load = peaksLoader(d);
  const two = [load('a.wav', 'here'), load('b.wav', 'here')];
  await new Promise((r) => setTimeout(r, 20));
  release();
  expect((await Promise.all(two)).map(peaks)).toEqual([[255, 255], [255, 255]]);
  expect(most).toBe(1);
  expect(d.fetchFile).toHaveBeenCalledWith('/file?path=a.wav');
  expect(await load('long.wav', 'here')).toEqual({ none: 'too-long' });
  expect(await load('big.wav', 'here')).toEqual({ none: 'too-long' });
  expect(d.decode).toHaveBeenCalledTimes(2);
  // another branch: the server reads only this checkout's files
  await load('c.wav', 'branch:x');
  expect(d.fetchPeaks).toHaveBeenCalledTimes(4);
  expect(d.fetchFile).toHaveBeenLastCalledWith('/file?path=c.wav&src=branch%3Ax');
});

it('a failure to reach the file is not remembered: the next ask tries again', async () => {
  let fail = true;
  const d = deps({ fetchPeaks: vi.fn(async () => { if (fail) throw new Error('offline'); return bytes([9]); }), fetchFile: async () => { throw new Error('offline'); } });
  const load = peaksLoader(d);
  expect(await load('a.wav', 'here')).toBeNull();
  fail = false;
  expect(peaks(await load('a.wav', 'here'))).toEqual([9]);
});
