import { describe, expect, it } from 'vitest';
import { validateCut, type Cut } from '@nota-bene/shared/cut';
import {
  addClip, addTrack, deleteClips, dragGain, duplicateClip, freeAt, GAIN_MAX, GAIN_MIN, gainAtY, gainY, setFade, setGain, moveClip, moveTrack, movePlace, nudgeClip, removeTrack, renameTrack, resizePlace,
  duplicateClips, moveClips, setClip, setClips, setTrackFlag, setTrackGain, snapMove, snapPoints, snapTime, splitAt, trimEnd, trimStart,
  moveForward, rippleTrimEnd, trackForward,
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
  it('sets a track\'s gain (issue 410) in dB to the tenth, within the gain line\'s range; 0 leaves it out of the file', () => {
    const c = valid(setTrackGain(base(), 'a1', -6.04));
    expect(c.tracks[2]).toEqual({ id: 'a1', kind: 'audio', name: 'Voice', gain: -6 });
    expect(setTrackGain(base(), 'v1', 30).tracks[0]!.gain).toBe(GAIN_MAX); // a video track's gain is its clips' sound
    expect(setTrackGain(base(), 'a1', -90).tracks[2]!.gain).toBe(GAIN_MIN);
    expect(setTrackGain(c, 'a1', 0).tracks[2]).toEqual({ id: 'a1', kind: 'audio', name: 'Voice' });
    const b = base();
    expect(setTrackGain(b, 'nope', 3)).toBe(b);
    expect(setTrackGain(b, 'a1', Number.NaN)).toBe(b);
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

describe('edges that must not overlap', () => {
  // a clip shorter than a frame (an agent's file may have one) between two neighbours that touch it
  const tight = (): Cut => ({
    version: 1, width: 640, height: 360, fps: 25,
    tracks: [{ id: 'v1', kind: 'video' }],
    clips: [
      { id: 'a', track: 'v1', src: 'a.mp4', at: 0, out: 1 },
      { id: 'b', track: 'v1', src: 'b.mp4', at: 1, out: 0.02 },
      { id: 'c', track: 'v1', src: 'c.mp4', at: 1.02, out: 1 },
    ],
  });
  it('trimming a clip shorter than a frame never runs into its neighbours', () => {
    valid(trimStart(tight(), 'b', 0.5));
    valid(trimEnd(tight(), 'b', 0.5));
    valid(trimStart(tight(), 'b', 3));
    valid(trimEnd(tight(), 'b', 3));
  });
  it('rounding to the millisecond never pushes a clip into a neighbour', () => {
    const cut: Cut = {
      version: 1, width: 640, height: 360, fps: 25,
      tracks: [{ id: 'v1', kind: 'video' }],
      clips: [
        { id: 'a', track: 'v1', src: 'a.mp4', at: 0, out: 1.0004 },
        { id: 'z', track: 'v1', src: 'z.mp4', at: 2.0004, out: 1 },
        { id: 'm', track: 'v1', src: 'm.mp4', at: 5, out: 1 },
      ],
    };
    const at = freeAt(cut, 'v1', 1, 1, ['m']);
    expect(at).toBeGreaterThanOrEqual(1.0004 - 1e-6);
    valid(moveClip(cut, 'm', 1));
    valid(trimStart(moveClip(cut, 'm', 3.0004), 'm', 2));
    valid(trimEnd({ ...cut, clips: [...cut.clips, { id: 'q', track: 'v1', src: 'q.mp4', at: 1.0004, out: 0.5 }] }, 'q', 5));
  });
});

describe('the gain line and the fade handles (issue 431)', () => {
  it('gainY / gainAtY: 0 dB halfway down, the top GAIN_MAX, the bottom GAIN_MIN; one the inverse of the other', () => {
    expect(gainY(0)).toBeCloseTo(0.5, 1);
    expect(gainY(GAIN_MAX)).toBe(0);
    expect(gainY(GAIN_MIN)).toBeCloseTo(1, 9);
    expect(gainY(-6)).toBeGreaterThan(0.5);
    expect(gainY(6)).toBeLessThan(0.5);
    for (const g of [-40, -12, -3, 0, 4.5, 12]) expect(gainAtY(gainY(g))).toBeCloseTo(g, 6);
    // beyond the limits: the line stays on the clip
    expect(gainY(30)).toBe(0);
    expect(gainY(-200)).toBe(1);
  });

  it('dragGain: the line follows the pointer in 0.5 dB steps, Shift a tenth as far in 0.1 dB steps, within the limits', () => {
    const h = 40;
    expect(dragGain(0, 0, h, false)).toBe(0);
    const up = dragGain(0, -4, h, false);
    expect(up).toBeGreaterThan(0);
    expect(Number.isInteger(up * 2)).toBe(true);
    expect(dragGain(0, -4, h, false)).toBe(Math.round(gainAtY(gainY(0) - 4 / h) * 2) / 2);
    const fine = dragGain(0, -4, h, true);
    expect(fine).toBeCloseTo(Math.round(gainAtY(gainY(0) - 0.4 / h) * 10) / 10, 6);
    expect(Math.abs(fine)).toBeLessThan(Math.abs(up));
    expect(dragGain(0, -1000, h, false)).toBe(GAIN_MAX);
    expect(dragGain(0, 1000, h, false)).toBe(GAIN_MIN);
    // a gain the agent wrote outside the limits starts where the line is drawn, at the edge
    expect(dragGain(-90, 0, h, false)).toBe(GAIN_MIN);
  });

  it('setGain: the clip\'s gain in dB to the tenth, within the limits; 0 leaves it out of the file', () => {
    const c = valid(setGain(base(), 'c4', -3.04));
    expect(clip(c, 'c4').gain).toBe(-3);
    expect(clip(setGain(base(), 'c4', 40), 'c4').gain).toBe(GAIN_MAX);
    expect('gain' in clip(setGain(c, 'c4', 0), 'c4')).toBe(false);
    expect(setGain(base(), 'nope', 3)).toEqual(base());
  });

  it('setFade: a fade to the millisecond, at most what the other fade leaves of the clip; 0 leaves it out of the file', () => {
    // c1: 5 s long, fades 1 and 1
    expect(clip(valid(setFade(base(), 'c1', 'in', 2.5)), 'c1').fadeIn).toBe(2.5);
    expect(clip(valid(setFade(base(), 'c1', 'in', 9)), 'c1').fadeIn).toBe(4);
    expect(clip(valid(setFade(base(), 'c1', 'out', 9)), 'c1').fadeOut).toBe(4);
    expect('fadeIn' in clip(setFade(base(), 'c1', 'in', -1), 'c1')).toBe(false);
    expect(clip(valid(setFade(base(), 'c4', 'out', 1.23456)), 'c4').fadeOut).toBe(1.235);
    // a photo fades too (its picture)
    expect(clip(valid(setFade(base(), 'c3', 'in', 0.5)), 'c3').fadeIn).toBe(0.5);
  });
});

describe('a selection of clips (issue 432)', () => {
  it('moveClips: keeps the relative times and tracks; refuses an overlap on any track', () => {
    const cut = base();
    const a = valid(moveClips(cut, ['c2', 'c4'], 1)!);
    expect(clip(a, 'c2')).toMatchObject({ track: 'v1', at: 9 });
    expect(clip(a, 'c4')).toMatchObject({ track: 'a1', at: 1.5 });
    expect(clip(a, 'c1')).toEqual(clip(cut, 'c1'));
    // c1 4 s later would sit over c2 (8..12): the whole move is refused, c3 with it
    expect(moveClips(cut, ['c1', 'c3'], 4)).toBeNull();
    expect(cut.clips).toEqual(base().clips); // the given edit is left alone
  });
  it('moveClips: never before 0, the earliest clip stops there and the rest keep their distance', () => {
    const a = valid(moveClips(base(), ['c3', 'c4'], -5)!);
    expect(clip(a, 'c4').at).toBe(0);
    expect(clip(a, 'c3').at).toBe(0.5);
  });
  it('moveClips: a lane shift moves the clips of that kind by as many lanes in the drawn order, the others keep theirs', () => {
    const cut = base();
    // drawn top-down: v2 (top of the picture), v1; down one lane: v2 -> v1
    const a = valid(moveClips(cut, ['c3', 'c4'], 4, { kind: 'video', by: 1 })!);
    expect(clip(a, 'c3')).toMatchObject({ track: 'v1', at: 5 });
    expect(clip(a, 'c4')).toMatchObject({ track: 'a1', at: 4.5 });
    // past the last lane of the kind: refused
    expect(moveClips(cut, ['c3'], 0, { kind: 'video', by: 2 })).toBeNull();
    expect(moveClips(cut, [], 1)).toBeNull();
  });
  it('duplicateClips: the copies keep their spacing, after the selection, past anything in the way', () => {
    const cut = base();
    const r = duplicateClips(cut, ['c3', 'c4']);
    valid(r.cut);
    expect(r.ids).toHaveLength(2);
    // the span 0.5..6.5 is 6 long: c3 copy at 7, c4 copy at 6.5; nothing in the way on v2 or a1
    expect(r.cut.clips.find((c) => c.id === r.ids[0])).toMatchObject({ track: 'v2', src: 'media/logo.png', at: 7 });
    expect(r.cut.clips.find((c) => c.id === r.ids[1])).toMatchObject({ track: 'a1', at: 6.5 });
    // c1 and c2: span 0..12, the copies from 12 on
    const d = duplicateClips(cut, ['c1', 'c2']);
    valid(d.cut);
    expect(d.ids.map((id) => d.cut.clips.find((c) => c.id === id)!.at)).toEqual([12, 20]);
    // c1 alone: c2 (8..12) is in the way of a 5 s copy at 5, so it goes after c2
    const one = duplicateClips(cut, ['c1']);
    expect(one.cut.clips.find((c) => c.id === one.ids[0])!.at).toBe(12);
  });
  it('setClips: one change to every clip, refused whole when any would be invalid', () => {
    const cut = base();
    const a = valid(setClips(cut, ['c2', 'c4'], { gain: -3 })!);
    expect([clip(a, 'c2').gain, clip(a, 'c4').gain]).toEqual([-3, -3]);
    expect(setClips(cut, ['c2', 'c3'], { fadeIn: 3.5 })).toBeNull(); // c3 is 3 s long
    expect(clip(valid(setClips(cut, ['c1'], { fadeIn: undefined })!), 'c1')).not.toHaveProperty('fadeIn');
  });
});

describe('a clip with everything after it on its track (issue 437)', () => {
  // a third clip on the main track: c1 0..5, c2 8..12, c5 13..15
  const three = (): Cut => {
    const cut = base();
    return { ...cut, clips: [...cut.clips, { id: 'c5', track: 'v1', src: 'media/b.mp4', at: 13, out: 2 }] };
  };
  it('trackForward: the clip and the later clips of its track, in time order; earlier ones and other tracks left out', () => {
    const cut = three();
    expect(trackForward(cut, 'c2')).toEqual(['c2', 'c5']);
    expect(trackForward(cut, 'c1')).toEqual(['c1', 'c2', 'c5']);
    expect(trackForward(cut, 'c4')).toEqual(['c4']);
    expect(trackForward(cut, 'nope')).toEqual([]);
  });
  it('moveForward: they move together, keeping their gaps; left, they stop at the previous clip and at 0', () => {
    const cut = three();
    const later = valid(moveForward(cut, 'c2', 2));
    expect([clip(later, 'c1').at, clip(later, 'c2').at, clip(later, 'c5').at]).toEqual([0, 10, 15]);
    expect(clip(later, 'c3')).toEqual(clip(cut, 'c3'));
    expect(clip(later, 'c4')).toEqual(clip(cut, 'c4'));
    // 5 s left: c2 stops at the end of c1, c5 keeps its distance
    const left = valid(moveForward(cut, 'c2', -5));
    expect([clip(left, 'c2').at, clip(left, 'c5').at]).toEqual([5, 10]);
    const zero = valid(moveForward(cut, 'c1', -1));
    expect([clip(zero, 'c1').at, clip(zero, 'c2').at]).toEqual([0, 8]);
    expect(clip(valid(moveForward(cut, 'c2', 0.0004)), 'c2').at).toBe(8);
    expect(moveForward(cut, 'nope', 1)).toBe(cut);
    expect(clip(cut, 'c2').at).toBe(8); // the given edit is left alone
  });
  it('rippleTrimEnd: the end trims and every later clip of the track moves by as much, the gap kept', () => {
    const cut = three();
    const longer = valid(rippleTrimEnd(cut, 'c1', 6, 20));
    expect(clip(longer, 'c1').out).toBe(8);
    expect([clip(longer, 'c2').at, clip(longer, 'c5').at]).toEqual([9, 14]);
    // past where the next clip started: it moves on ahead
    const past = valid(rippleTrimEnd(cut, 'c1', 10, 20));
    expect([clip(past, 'c2').at, clip(past, 'c5').at]).toEqual([13, 18]);
    // shorter: they follow it back
    const shorter = valid(rippleTrimEnd(cut, 'c2', 10));
    expect(clip(shorter, 'c2').out).toBe(2);
    expect(clip(shorter, 'c5').at).toBe(11);
    expect(clip(shorter, 'c4')).toEqual(clip(cut, 'c4'));
  });
  it('clips that touch off the millisecond still touch after a move: every clip shifts by the same amount', () => {
    const cut: Cut = { ...base(), clips: [
      { id: 'a', track: 'v1', src: 'media/a.mp4', at: 0, out: 1.0004 },
      { id: 'b', track: 'v1', src: 'media/b.mp4', at: 1.0004, out: 1 },
    ] };
    const fwd = valid(moveForward(cut, 'a', 0.5));
    expect(clip(fwd, 'b').at - clip(fwd, 'a').at).toBeCloseTo(1.0004, 6);
    const sel = valid(moveClips(cut, ['a', 'b'], 0.5)!);
    expect(clip(sel, 'b').at - clip(sel, 'a').at).toBeCloseTo(1.0004, 6);
    // stopped at a previous clip whose end is off the millisecond: the moved ones touch it, not overlap
    const after: Cut = { ...cut, clips: [...cut.clips, { id: 'c', track: 'v1', src: 'media/c.mp4', at: 3, out: 1 }] };
    const left = valid(moveForward(after, 'c', -5));
    expect(clip(left, 'c').at).toBeCloseTo(2.0004, 6);
    valid(rippleTrimEnd(cut, 'a', 2));
  });
  it('rippleTrimEnd: within the source and one frame of length, the later clips moving only as far as the end did', () => {
    const cut = three();
    const src = valid(rippleTrimEnd(cut, 'c1', 9, 8)); // the source ends 6 s into the edit (in 2)
    expect(clip(src, 'c1').out).toBe(8);
    expect(clip(src, 'c2').at).toBe(9);
    const frame = valid(rippleTrimEnd(cut, 'c2', 0));
    expect(clip(frame, 'c2').out).toBe(0.04);
    expect(clip(frame, 'c5').at).toBe(9.04);
    expect(rippleTrimEnd(cut, 'nope', 3)).toBe(cut);
  });
});
