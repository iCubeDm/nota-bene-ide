import { expect, it } from 'vitest';
import type { Cut } from '@nota-bene/shared/cut';
import { cutChanges, isNoChange } from './changes.ts';

const base: Cut = {
  version: 1, width: 640, height: 360, fps: 25,
  tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }],
  clips: [
    { id: 'c1', track: 'v1', src: 'a.mp4', at: 0, out: 3 },
    { id: 'c2', track: 'v1', src: 'b.mp4', at: 3, out: 2 },
    { id: 'c3', track: 'a1', src: 'm.wav', at: 0, out: 5 },
  ],
};
const withClips = (clips: Cut['clips']): Cut => ({ ...base, clips });

it('the same edit, or one only reordered or written with its keys in another order, has no changes', () => {
  expect(isNoChange(cutChanges(base, base))).toBe(true);
  const reordered = withClips([...base.clips].reverse().map((c) => Object.fromEntries(Object.entries(c).reverse()) as typeof c));
  expect(isNoChange(cutChanges(base, reordered))).toBe(true);
});

it('a clip with a new id is added, one whose id is gone is removed (with where it was)', () => {
  const next = withClips([base.clips[0]!, base.clips[2]!, { id: 'c4', track: 'a1', src: 'v.wav', at: 5, out: 1 }]);
  const d = cutChanges(base, next);
  expect(d.added).toEqual(['c4']);
  expect(d.changed).toEqual([]);
  expect(d.removed).toEqual([base.clips[1]]);
});

it('any field of a clip changed makes it changed: moved, trimmed, another track, gain, a fade, a placement', () => {
  const [c1, c2, c3] = base.clips as [Cut['clips'][0], Cut['clips'][0], Cut['clips'][0]];
  const next = withClips([{ ...c1, at: 1 }, { ...c2, in: 0.5 }, { ...c3, gain: -6 }]);
  expect(cutChanges(base, next).changed).toEqual(['c1', 'c2', 'c3']);
  expect(cutChanges(base, withClips([{ ...c1, track: 'v2' }, c2, c3])).changed).toEqual(['c1']);
  expect(cutChanges(base, withClips([c1, { ...c2, fadeIn: 0.2 }, c3])).changed).toEqual(['c2']);
  expect(cutChanges(base, withClips([c1, c2, { ...c3, gain: undefined }])).changed).toEqual([]); // undefined: not in the file
});

it('a change to the tracks alone highlights no clip', () => {
  const d = cutChanges(base, { ...base, tracks: [...base.tracks, { id: 'v2', kind: 'video' }] });
  expect(isNoChange(d)).toBe(true);
});
