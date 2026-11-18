import { expect, it, vi } from 'vitest';
import type { CutClip } from '@nota-bene/shared/cut';
import { reversedStore } from './reverse.ts';

const clip = (o: Partial<CutClip> = {}): CutClip => ({ id: 'c', track: 'v1', src: 'media/a.mp4', at: 0, in: 1, out: 3, reverse: true, ...o });
const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const tick = () => new Promise((r) => setTimeout(r, 0));

it('asks the server once per source and part, again each poll while it makes the copy; then the copy\'s URL, subscribers told', async () => {
  const replies = [null, answer(202, { making: true }), answer(200, { path: '.nota-bene/reverse/x.mp4' })];
  const fetch = vi.fn(async () => {
    const r = replies.shift();
    if (!r) throw new TypeError('unreachable'); // a server restarting: asked again
    return r;
  });
  const waits: number[] = [];
  const s = reversedStore({ fetch, wait: async (ms) => { waits.push(ms); } });
  const told = vi.fn();
  s.subscribe(told);
  expect(s.of(clip(), 'here')).toBe('making');
  expect(s.of(clip({ id: 'other' }), 'here')).toBe('making'); // the same part of the same source
  for (let i = 0; i < 5; i++) await tick();
  expect(s.of(clip(), 'here')).toEqual({ url: '/file?path=.nota-bene%2Freverse%2Fx.mp4' });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch).toHaveBeenCalledWith('media/a.mp4', 1, 3);
  expect(waits).toEqual([1000, 1000]);
  expect(told).toHaveBeenCalledTimes(1);
});

it('a refusal is a failed copy; an edit of another branch or worktree gets none, nothing asked', async () => {
  const fetch = vi.fn(async () => answer(501, { error: 'no-ffmpeg' }));
  const s = reversedStore({ fetch, wait: async () => {} });
  s.of(clip({ in: undefined }), 'here');
  await tick();
  await tick();
  expect(s.of(clip({ in: undefined }), 'here')).toBe('failed');
  expect(fetch).toHaveBeenCalledWith('media/a.mp4', 0, 3);
  expect(s.of(clip({ out: 4 }), 'wt:feature')).toBe('failed');
  expect(fetch).toHaveBeenCalledTimes(1);
});
