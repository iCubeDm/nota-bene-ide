import { describe, expect, it } from 'vitest';
import type { Cut } from '@nota-bene/shared/cut';
import { cutState, followAnchor, pinAnchor, timeOf } from './pin.ts';
import { deleteClips, duplicateClip, moveClip, splitAt, trimEnd, trimStart } from './ops.ts';

const base = (): Cut => ({
  version: 1, width: 1280, height: 720, fps: 25,
  tracks: [{ id: 'v1', kind: 'video', name: 'Main' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio', name: 'Voice' }],
  clips: [
    { id: 'c1', track: 'v1', src: 'media/intro.mp4', at: 0, in: 2, out: 7 },
    { id: 'c3', track: 'v2', src: 'media/logo.png', at: 1, dur: 3 },
    { id: 'c4', track: 'a1', src: 'media/voice.wav', at: 0.5, out: 6 },
  ],
});
const source = { kind: 'file', path: 'e.nbcut.json' } as const;

describe('pinAnchor (issue 430)', () => {
  it('a selected clip under the playhead: that clip at the playhead, with the moment in its source', () => {
    expect(pinAnchor(base(), source, 3.1234, 'c1')).toEqual({
      kind: 'cut', source, time: 3.123, clip: { id: 'c1', track: 'v1', trackName: 'Main', src: 'media/intro.mp4', srcTime: 5.123 },
    });
  });
  it('a selected clip away from the playhead: the clip at its start', () => {
    expect(pinAnchor(base(), source, 7, 'c4')).toEqual({
      kind: 'cut', source, time: 0.5, clip: { id: 'c4', track: 'a1', trackName: 'Voice', src: 'media/voice.wav', srcTime: 0 },
    });
    // the clip's end is not on it
    expect(pinAnchor(base(), source, 5, 'c1').time).toBe(0);
  });
  it('a photo: the offset into its showing; a track without a name has none', () => {
    expect(pinAnchor(base(), source, 2.5, 'c3')).toEqual({ kind: 'cut', source, time: 2.5, clip: { id: 'c3', track: 'v2', src: 'media/logo.png', srcTime: 1.5 } });
  });
  it('nothing selected, or a selection that is not a clip: the moment of the timeline', () => {
    expect(pinAnchor(base(), source, 4.5, null)).toEqual({ kind: 'cut', source, time: 4.5 });
    expect(pinAnchor(base(), source, 4.5, 'gone')).toEqual({ kind: 'cut', source, time: 4.5 });
  });
});

describe('followAnchor: the comment keeps to its clip by id (issue 430)', () => {
  const pinned = pinAnchor(base(), source, 3, 'c1'); // 1 s into the source past in = 2
  it('unchanged: null', () => {
    expect(followAnchor(pinned, base())).toBeNull();
    expect(followAnchor({ kind: 'cut', source, time: 2 }, base())).toBeNull();
  });
  it('a moved clip, to another track too: the time moves with it, the moment in the source stays', () => {
    const moved = moveClip(base(), 'c1', 10, 'v2');
    const a = followAnchor(pinned, moved)!;
    expect(a).toEqual({ ...pinned, time: 13, clip: { id: 'c1', track: 'v2', src: 'media/intro.mp4', srcTime: 5 } });
  });
  it('a trimmed start: the moment stays where it is in the source', () => {
    const trimmed = trimStart(base(), 'c1', 1);
    expect(trimmed.clips[0]).toMatchObject({ at: 1, in: 3 });
    expect(followAnchor(pinned, trimmed)).toBeNull(); // at 1 + (5 - 3) = 3: where it was
  });
  it('a moment trimmed away: the tick keeps to the clip, at its nearest end', () => {
    const trimmed = trimStart(base(), 'c1', 4); // in 6 > srcTime 5
    expect(followAnchor(pinned, trimmed)).toEqual({ ...pinned, time: 4 });
  });
  it('the clip is gone: null (the comment keeps its time)', () => {
    expect(followAnchor(pinned, { ...base(), clips: base().clips.slice(1) })).toBeNull();
  });
  it('timeOf: where the comment is on the timeline now; undefined for a gone clip', () => {
    expect(timeOf(pinned, moveClip(base(), 'c1', 10))).toBe(13);
    expect(timeOf({ kind: 'cut', source, time: 7 }, base())).toBe(7);
    expect(timeOf(pinned, { ...base(), clips: [] })).toBeUndefined();
  });
});

describe('a split, or another clip of the same source on the track, takes the comment where its moment is (issue 430)', () => {
  const late = pinAnchor(base(), source, 5.5, 'c4'); // voice, 5 s into the source
  it('split before the moment: the right part (a new id) takes it, at the same place', () => {
    const r = splitAt(base(), 3, ['c4']);
    const right = r.ids[0]!;
    const a = followAnchor(late, r.cut)!;
    expect(a).toEqual({ ...late, clip: { ...late.clip!, id: right } });
    expect(timeOf(late, r.cut)).toBe(5.5);
    expect(followAnchor(a, r.cut)).toBeNull();
  });
  it('split after the moment: it stays on the left part', () => {
    expect(followAnchor(late, splitAt(base(), 6, ['c4']).cut)).toBeNull();
  });
  it('the split undone: the whole clip takes it back from the right part\'s gone id', () => {
    const r = splitAt(base(), 3, ['c4']);
    const onRight = followAnchor(late, r.cut)!;
    expect(followAnchor(onRight, base())).toEqual(late);
  });
  it('a clip of the same source on another track, or of another source, does not take it', () => {
    const cut = base();
    const other = { ...cut, clips: [...cut.clips.filter((c) => c.id !== 'c4'), { id: 'x', track: 'a1', src: 'media/other.wav', at: 0.5, out: 6 }] };
    expect(followAnchor(late, other)).toBeNull();
    expect(timeOf(late, other)).toBeUndefined();
  });
});

describe('cutState: whether the comment\'s moment is still in its clip (issue 430)', () => {
  const late = pinAnchor(base(), source, 5.5, 'c4');
  it('ok, trimmed out (the time clamps, the moment in the source stays), gone', () => {
    expect(cutState(late, base())).toBe('ok');
    const trimmed = trimEnd(base(), 'c4', 3);
    expect(cutState(late, trimmed)).toBe('trimmed');
    expect(followAnchor(late, trimmed)).toEqual({ ...late, time: 3 });
    expect(cutState(late, deleteClips(base(), ['c4']))).toBe('gone');
    expect(cutState({ kind: 'cut', source, time: 1 }, base())).toBe('ok');
  });
  it('a duplicate elsewhere does not steal a comment whose clip is still there', () => {
    const d = duplicateClip(base(), 'c4');
    expect(followAnchor(late, d.cut)).toBeNull();
  });
});
