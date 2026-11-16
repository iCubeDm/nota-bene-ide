import { describe, expect, it } from 'vitest';
import type { Cut } from '@nota-bene/shared/cut';
import { followAnchor, pinAnchor, timeOf } from './pin.ts';
import { moveClip, trimStart } from './ops.ts';

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
