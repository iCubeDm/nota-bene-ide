import { expect, it, vi } from 'vitest';
import type { Cut } from '@nota-bene/shared/cut';
import { reversedCopies, reversedParts, type Part } from './reverse.ts';

const part = (o: Partial<Part> = {}): Part => ({ src: 'media/a.mp4', in: 1, out: 3, sound: false, ...o });
const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const copyAt = (p: string) => answer(200, { path: p });

it('reversedParts: the edit\'s reversed video and audio clips; on an audio track their sound alone', () => {
  const cut: Cut = {
    version: 1, width: 64, height: 64, fps: 10, tracks: [{ id: 'v', kind: 'video' }, { id: 'a', kind: 'audio' }],
    clips: [
      { id: 'c1', track: 'v', src: 'media/a.mp4', at: 0, in: 1, out: 3, reverse: true },
      { id: 'c2', track: 'a', src: 'media/a.mp4', at: 0, out: 2, reverse: true },
      { id: 'c3', track: 'v', src: 'media/b.mp4', at: 3, out: 2 },
    ],
  };
  expect(reversedParts(cut)).toEqual([part(), part({ in: undefined, out: 2, sound: true })]);
});

it('asks for each wanted part, again each poll while the copy is made and through an unreachable server; then the copy\'s URL, subscribers told', async () => {
  const replies = [answer(202, { making: true }), null, copyAt('.nota-bene/reverse/x.mp4')];
  const fetch = vi.fn(async () => {
    const r = replies.shift();
    if (!r) throw new TypeError('unreachable');
    return r;
  });
  const waits: number[] = [];
  const s = reversedCopies({ fetch, wait: async (ms) => { waits.push(ms); } });
  const told = vi.fn();
  s.subscribe(told);
  s.want([part(), part()], 'here');
  expect(s.of(part())).toBe('making');
  await ticks();
  expect(s.of(part())).toEqual({ url: '/file?path=.nota-bene%2Freverse%2Fx.mp4' });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch).toHaveBeenCalledWith(part());
  expect(waits).toEqual([1000, 1000]);
  expect(told).toHaveBeenCalledTimes(2); // making, then the URL
  expect(s.of(part({ out: 4 }))).toBeNull(); // never wanted: nothing known, nothing asked
});

it('asks again on every want: a copy removed meanwhile is made again, a changed source gives a new URL, a refusal is tried again', async () => {
  const replies = [copyAt('a.mp4'), answer(202), copyAt('b.mp4'), answer(501, { error: 'no-ffmpeg' }), copyAt('c.mp4')];
  const fetch = vi.fn(async () => replies.shift()!);
  const s = reversedCopies({ fetch, wait: async () => {} });
  s.want([part()], 'here');
  await ticks();
  expect(s.of(part())).toEqual({ url: '/file?path=a.mp4' });
  s.want([part()], 'here'); // gone from the disk: made again
  await ticks();
  expect(s.of(part())).toEqual({ url: '/file?path=b.mp4' });
  s.want([part()], 'here');
  await ticks();
  expect(s.of(part())).toBe('failed');
  s.want([part()], 'here'); // ffmpeg installed since
  await ticks();
  expect(s.of(part())).toEqual({ url: '/file?path=c.mp4' });
});

it('a part too long to reverse has its own state; a load error of a copy asks for it again', async () => {
  const replies = [answer(422, { error: 'too-long' }), copyAt('a.mp4'), copyAt('a2.mp4')];
  const fetch = vi.fn(async () => replies.shift()!);
  const s = reversedCopies({ fetch, wait: async () => {} });
  s.want([part({ out: 99 }), part()], 'here');
  await ticks();
  expect(s.of(part({ out: 99 }))).toBe('too-long');
  expect(s.of(part())).toEqual({ url: '/file?path=a.mp4' });
  s.failed('/file?path=a.mp4');
  await ticks();
  expect(s.of(part())).toEqual({ url: '/file?path=a2.mp4' });
});

it('stops asking for a part no longer wanted, and for all once closed; an edit of another branch or worktree asks nothing', async () => {
  const fetch = vi.fn(async (_p: Part) => answer(202));
  const s = reversedCopies({ fetch, wait: () => new Promise((r) => setTimeout(r, 0)) });
  const asked = (out: number) => fetch.mock.calls.filter(([p]) => p.out === out).length;
  s.want([part()], 'here');
  await ticks(4);
  s.want([part({ out: 2 })], 'here');
  await ticks(2);
  const before = asked(3);
  await ticks(6);
  expect(asked(3)).toBe(before);
  expect(asked(2)).toBeGreaterThan(1);
  s.close();
  await ticks(2);
  const n = fetch.mock.calls.length;
  await ticks(6);
  expect(fetch.mock.calls.length).toBe(n);
  const elsewhere = vi.fn();
  const other = reversedCopies({ fetch: elsewhere, wait: async () => {} });
  other.want([part()], 'wt:feature');
  expect(other.of(part())).toBe('elsewhere');
  expect(elsewhere).not.toHaveBeenCalled();
});
