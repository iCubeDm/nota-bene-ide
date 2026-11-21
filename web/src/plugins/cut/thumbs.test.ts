import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { posterCache } from './thumbs.ts';

let made: number;
let revoked: string[];
beforeEach(() => {
  made = 0;
  revoked = [];
  vi.stubGlobal('URL', Object.assign(Object.create(URL) as typeof URL, {
    createObjectURL: () => `blob:${++made}`,
    revokeObjectURL: (u: string) => void revoked.push(u),
  }));
});
afterEach(() => vi.unstubAllGlobals());

it('grabs a frame once per file and time, for every clip that shows it', async () => {
  const grab = vi.fn(async () => new Blob(['x']));
  const poster = posterCache(grab);
  const all = await Promise.all(Array.from({ length: 100 }, () => poster('/file?path=a.mp4', 2)));
  expect(grab).toHaveBeenCalledTimes(1);
  expect(new Set(all)).toEqual(new Set(['blob:1']));
  expect(await poster('/file?path=a.mp4', 3)).toBe('blob:2'); // another time is another frame
  expect(grab).toHaveBeenCalledTimes(2);
});

it('keeps a few: the oldest is let go, its URL revoked', async () => {
  const poster = posterCache(async () => new Blob(['x']), 2);
  await poster('a', 0);
  await poster('b', 0);
  await poster('a', 0); // used again: now the newest
  await poster('c', 0);
  await Promise.resolve();
  expect(revoked).toEqual(['blob:2']); // b's
  expect(await poster('a', 0)).toBe('blob:1');
});

it('a frame that could not be grabbed is tried again next time', async () => {
  const grab = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(new Blob(['x']));
  const poster = posterCache(grab);
  expect(await poster('a', 0)).toBeNull();
  expect(await poster('a', 0)).toBe('blob:1');
});

it('grabs two frames at a time at most', async () => {
  let running = 0;
  let most = 0;
  const poster = posterCache(async () => {
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, 1));
    running--;
    return new Blob(['x']);
  });
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map((u) => poster(u, 0)));
  expect(most).toBe(2);
});
