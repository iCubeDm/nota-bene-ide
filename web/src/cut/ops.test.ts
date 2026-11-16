import { describe, expect, it } from 'vitest';
import { validateCut, type Cut } from '@nota-bene/shared/cut';
import {
  addClip, addTrack, deleteClips, duplicateClip, freeAt, moveClip, moveTrack, movePlace, nudgeClip, removeTrack, renameTrack, resizePlace,
  setClip, setTrackFlag, snapMove, snapPoints, snapTime, splitAt, trimEnd, trimStart,
} from './ops.ts';

// a main video track with two clips and a gap, a photo over it, a voice track
const base = (): Cut => ({
  version: 1, width: 1280, height: 720, fps: 25,
  tracks: [
    { id: 'v1', kind: 'video', name: 'Main' },
    { id: 'v2', kind: 'video' },
    { id: 'a1', kind: 'audio', name: 'Voice' },
  ],
  clips: [
    { id: 'c1', track: 'v1', src: 'media/intro.mp4', at: 0, in: 2, out: 7, fadeIn: 1, fadeOut: 1 },
    { id: 'c2', track: 'v1', src: 'media/street.mov', at: 8, out: 4 },
    { id: 'c3', track: 'v2', src: 'media/logo.png', at: 1, dur: 3, place: { x: 0.7, y: 0.05, w: 0.25, h: 0.2 } },
    { id: 'c4', track: 'a1', src: 'media/voice.wav', at: 0.5, out: 6 },
  ],
});
const clip = (cut: Cut, id: string) => cut.clips.find((c) => c.id === id)!;
// every operation leaves an edit the format accepts
const valid = (cut: Cut) => {
  const r = validateCut(cut);
  expect(r.ok ? [] : r.errors).toEqual([]);
  return cut;
};

describe('freeAt: the nearest place without overlap', () => {
  it('keeps a time that fits, else the nearest gap that holds the length', () => {
    const cut = base();
    expect(freeAt(cut, 'v1', 5.5, 1)).toBe(5.5); // in the gap 5..8
    expect(freeAt(cut, 'v1', 6, 3)).toBe(5); // the gap holds 3: pushed back to its start
    expect(freeAt(cut, 'v1', 6, 4)).toBe(12); // no room in the gap: after the last clip
    expect(freeAt(cut, 'v1', 9, 2, ['c2'])).toBe(9); // the moved clip itself is not in the way
    expect(freeAt(cut, 'v1', -3, 1, ['c1'])).toBe(0);
  });
});

describe('moveClip', () => {
  it('moves in time, never over a neighbour, never below 0', () => {
    let cut = valid(moveClip(base(), 'c2', 6));
    expect(clip(cut, 'c2').at).toBe(6);
    cut = valid(moveClip(base(), 'c2', 3)); // would overlap c1 (0..5): the nearest free place
    expect(clip(cut, 'c2').at).toBe(5);
    cut = valid(moveClip(base(), 'c1', -2));
    expect(clip(cut, 'c1').at).toBe(0);
  });
  it('moves to a track of the same kind only', () => {
    const cut = valid(moveClip(base(), 'c2', 6, 'v2'));
    expect(clip(cut, 'c2')).toMatchObject({ track: 'v2', at: 6 });
    expect(moveClip(base(), 'c2', 6, 'a1')).toEqual(base());
    expect(moveClip(base(), 'c4', 6, 'v1')).toEqual(base());
  });
  it('rounds times to the millisecond and leaves the original alone', () => {
    const before = base();
    const cut = moveClip(before, 'c2', 9.123456);
    expect(clip(cut, 'c2').at).toBe(9.123);
    expect(clip(before, 'c2').at).toBe(8);
  });
  it('nudges by frames', () => {
    expect(clip(valid(nudgeClip(base(), 'c2', 1)), 'c2').at).toBe(8.04);
    expect(clip(valid(nudgeClip(base(), 'c1', -1)), 'c1').at).toBe(0);
  });
});

describe('trim', () => {
  it('the start of a video moves its in, not past the source start or the clip before', () => {
    let cut = valid(trimStart(base(), 'c1', 1));
    expect(clip(cut, 'c1')).toMatchObject({ at: 1, in: 3, out: 7 });
    cut = valid(trimStart(base(), 'c2', 3)); // c2 starts at source 0: cannot reach earlier
    expect(clip(cut, 'c2')).toMatchObject({ at: 8, out: 4 });
    const later = moveClip(base(), 'c2', 6);
    cut = valid(trimStart(trimStart(later, 'c2', 7), 'c2', 2)); // in 1, then back to the end of c1 at 5... limited by in 0
    expect(clip(cut, 'c2')).toMatchObject({ at: 6, in: 0, out: 4 });
  });
  it('the end of a video moves its out, within the source length and before the next clip', () => {
    let cut = valid(trimEnd(base(), 'c1', 4));
    expect(clip(cut, 'c1')).toMatchObject({ at: 0, in: 2, out: 6 });
    cut = valid(trimEnd(base(), 'c1', 7)); // c2 starts at 8, the source is 9 s: out may reach 9
    expect(clip(cut, 'c1').out).toBe(9);
    cut = valid(trimEnd(base(), 'c1', 30, 20)); // up to the next clip
    expect(clip(cut, 'c1').out).toBe(10);
    cut = valid(trimEnd(base(), 'c1', 30, 8)); // up to the end of the source
    expect(clip(cut, 'c1').out).toBe(8);
    cut = valid(trimEnd(base(), 'c2', 30)); // no next clip, the source length unknown: as asked
    expect(clip(cut, 'c2').out).toBe(22);
  });
  it('keeps one frame at least and shortens fades that no longer fit', () => {
    const cut = valid(trimEnd(base(), 'c1', -5));
    expect(clip(cut, 'c1')).toMatchObject({ at: 0, in: 2, out: 2.04 });
    expect(clip(cut, 'c1').fadeIn! + clip(cut, 'c1').fadeOut!).toBeLessThanOrEqual(0.04 + 1e-9);
    const s = valid(trimStart(base(), 'c1', 99));
    expect(clip(s, 'c1')).toMatchObject({ at: 4.96, in: 6.96, out: 7 });
  });
  it('a photo trims its dur from either end', () => {
    let cut = valid(trimEnd(base(), 'c3', 6));
    expect(clip(cut, 'c3')).toMatchObject({ at: 1, dur: 5 });
    cut = valid(trimStart(base(), 'c3', 0));
    expect(clip(cut, 'c3')).toMatchObject({ at: 0, dur: 4 });
    expect(clip(cut, 'c3').in).toBeUndefined();
  });
});

describe('split, delete, duplicate', () => {
  it('splits the clip at a time into two that play the same', () => {
    const { cut, ids } = splitAt(base(), 3, ['c1']);
    valid(cut);
    const right = clip(cut, ids[0]!);
    expect(clip(cut, 'c1')).toMatchObject({ at: 0, in: 2, out: 5, fadeIn: 1 });
    expect(clip(cut, 'c1').fadeOut).toBeUndefined();
    expect(right).toMatchObject({ track: 'v1', src: 'media/intro.mp4', at: 3, in: 5, out: 7, fadeOut: 1 });
    expect(right.fadeIn).toBeUndefined();
  });
  it('without a clip given, splits every clip under the time; a photo too', () => {
    const { cut, ids } = splitAt(base(), 2, []);
    valid(cut);
    expect(ids).toHaveLength(3); // c1, c3, c4
    expect(clip(cut, 'c3').dur).toBe(1);
    expect(cut.clips.find((c) => c.src === 'media/logo.png' && c.at === 2)).toMatchObject({ dur: 2, place: { x: 0.7 } });
  });
  it('does not split at an edge or outside the clip', () => {
    expect(splitAt(base(), 0, ['c1']).cut).toEqual(base());
    expect(splitAt(base(), 6, ['c1']).cut).toEqual(base());
    expect(splitAt(base(), 4.99, ['c1']).cut).toEqual(base()); // less than a frame left
  });
  it('deletes clips', () => {
    const cut = valid(deleteClips(base(), ['c1', 'c4']));
    expect(cut.clips.map((c) => c.id)).toEqual(['c2', 'c3']);
  });
  it('duplicates into the first free place after the clip', () => {
    let r = duplicateClip(base(), 'c2');
    valid(r.cut);
    expect(clip(r.cut, r.id!)).toMatchObject({ src: 'media/street.mov', at: 12, out: 4 });
    r = duplicateClip(base(), 'c1'); // 5 s: the gap 5..8 is too short
    expect(clip(valid(r.cut), r.id!).at).toBe(12);
    expect(new Set(r.cut.clips.map((c) => c.id)).size).toBe(r.cut.clips.length);
  });
});

describe('addClip', () => {
  it('a video on a video track, a sound on an audio track, at the nearest free place', () => {
    let r = addClip(base(), { track: 'v1', src: 'media/b.webm', at: 6, len: 2 });
    expect(clip(valid(r!.cut), r!.id)).toMatchObject({ track: 'v1', at: 6, out: 2 });
    r = addClip(base(), { track: 'a1', src: 'media/music.mp3', at: 2, len: 10 });
    expect(clip(valid(r!.cut), r!.id)).toMatchObject({ at: 6.5, out: 10 });
    r = addClip(base(), { track: 'v2', src: 'media/p.jpg', at: 4, len: 5 });
    expect(clip(valid(r!.cut), r!.id)).toMatchObject({ at: 4, dur: 5 });
  });
  it('refuses what the track cannot take or the format cannot read', () => {
    expect(addClip(base(), { track: 'v1', src: 'media/music.mp3', at: 0, len: 1 })).toBeNull();
    expect(addClip(base(), { track: 'a1', src: 'media/p.png', at: 0, len: 1 })).toBeNull();
    expect(addClip(base(), { track: 'v1', src: 'notes.txt', at: 0, len: 1 })).toBeNull();
    expect(addClip(base(), { track: 'v1', src: 'anim.gif', at: 0, len: 1 })).toBeNull();
    expect(addClip(base(), { track: 'nope', src: 'a.mp4', at: 0, len: 1 })).toBeNull();
  });
});

describe('tracks', () => {
  it('adds a track with a new id: a video one on top of the picture', () => {
    let r = addTrack(base(), 'video');
    expect(r.id).toBe('v3');
    expect(valid(r.cut).tracks.at(-1)).toEqual({ id: 'v3', kind: 'video' });
    r = addTrack(base(), 'audio');
    expect(r.id).toBe('a2');
  });
  it('removes a track with its clips', () => {
    const cut = valid(removeTrack(base(), 'v1'));
    expect(cut.tracks.map((t) => t.id)).toEqual(['v2', 'a1']);
    expect(cut.clips.map((c) => c.id)).toEqual(['c3', 'c4']);
  });
  it('renames; an empty name goes back to the default', () => {
    expect(renameTrack(base(), 'v2', ' Logo ').tracks[1]).toEqual({ id: 'v2', kind: 'video', name: 'Logo' });
    expect(renameTrack(base(), 'v1', '  ').tracks[0]).toEqual({ id: 'v1', kind: 'video' });
  });
  it('toggles mute, solo and hidden, writing only what is on', () => {
    const on = valid(setTrackFlag(base(), 'a1', 'mute', true));
    expect(on.tracks[2]).toMatchObject({ mute: true });
    expect(setTrackFlag(on, 'a1', 'mute', false).tracks[2]).toEqual({ id: 'a1', kind: 'audio', name: 'Voice' });
    expect(setTrackFlag(base(), 'a1', 'hidden', true)).toEqual(base()); // an audio track has no picture
  });
  it('reorders in the drawn order: up for a video track is over the picture', () => {
    // drawn: v2, v1, a1; v1 up goes over v2, that is after it in the file
    expect(moveTrack(base(), 'v1', -1).tracks.map((t) => t.id)).toEqual(['v2', 'v1', 'a1']);
    expect(moveTrack(base(), 'v2', -1)).toEqual(base()); // already on top
    expect(moveTrack(base(), 'v1', 1)).toEqual(base()); // the lowest video track: audio is no neighbour
    const two = addTrack(base(), 'audio').cut;
    expect(moveTrack(two, 'a2', -1).tracks.map((t) => t.id)).toEqual(['v1', 'v2', 'a2', 'a1']);
  });
});

describe('setClip: the inspector', () => {
  it('applies a valid change, refuses an invalid one', () => {
    expect(clip(valid(setClip(base(), 'c4', { gain: -6, fadeIn: 0.5 })!), 'c4')).toMatchObject({ gain: -6, fadeIn: 0.5 });
    expect(setClip(base(), 'c2', { at: 3 })).toBeNull(); // over c1
    expect(setClip(base(), 'c1', { out: 1 })).toBeNull(); // before in
    expect(setClip(base(), 'c1', { fadeIn: 9 })).toBeNull();
  });
  it('an undefined field is removed', () => {
    expect(clip(setClip(base(), 'c3', { place: undefined })!, 'c3').place).toBeUndefined();
    expect('place' in clip(setClip(base(), 'c3', { place: undefined })!, 'c3')).toBe(false);
  });
});

describe('snapping', () => {
  it('the points: 0, the playhead and the other clips edges', () => {
    expect(snapPoints(base(), 2.5, ['c1'])).toEqual([0, 0.5, 1, 2.5, 4, 6.5, 8, 12]);
  });
  it('a time snaps to the nearest point within the tolerance', () => {
    expect(snapTime(4.1, [0, 4, 8], 0.2)).toBe(4);
    expect(snapTime(4.3, [0, 4, 8], 0.2)).toBe(4.3);
  });
  it('a move snaps by either edge of the clip', () => {
    expect(snapMove(3.9, 2, [0, 4, 8], 0.2)).toBe(4); // start to 4
    expect(snapMove(5.9, 2, [0, 4, 8], 0.2)).toBe(6); // end to 8
    expect(snapMove(5, 2, [0, 4, 8], 0.2)).toBe(5);
  });
});

describe('placement', () => {
  const p = { x: 0.5, y: 0.5, w: 0.25, h: 0.25 };
  it('moves inside the frame', () => {
    expect(movePlace(p, 0.1, -0.1)).toEqual({ x: 0.6, y: 0.4, w: 0.25, h: 0.25 });
    expect(movePlace(p, 1, 1)).toEqual({ x: 0.75, y: 0.75, w: 0.25, h: 0.25 });
    expect(movePlace({ ...p, opacity: 0.5 }, -1, -1)).toEqual({ x: 0, y: 0, w: 0.25, h: 0.25, opacity: 0.5 });
  });
  it('resizes from a corner keeping its aspect, the other corner fixed', () => {
    expect(resizePlace(p, 'se', 0.25, 0, true)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(resizePlace(p, 'nw', -0.1, -0.1, true)).toEqual({ x: 0.4, y: 0.4, w: 0.35, h: 0.35 });
    expect(resizePlace(p, 'se', 0.1, 0.2, false)).toEqual({ x: 0.5, y: 0.5, w: 0.35, h: 0.45 });
  });
  it('stays in the frame and above a minimum size', () => {
    expect(resizePlace(p, 'se', 1, 1, true)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(resizePlace(p, 'se', -1, -1, true)).toEqual({ x: 0.5, y: 0.5, w: 0.05, h: 0.05 });
    expect(resizePlace({ x: 0, y: 0, w: 1, h: 0.5 }, 'nw', -0.5, -0.5, true)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    const r = resizePlace(p, 'ne', 0.5, -0.9, false);
    expect(r).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.75 });
  });
});
