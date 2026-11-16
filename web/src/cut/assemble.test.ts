import { describe, expect, it } from 'vitest';
import { validateCut, type Cut } from '@nota-bene/shared/cut';
import { appendMedia, NEW_CUT, newCutOf } from './assemble.ts';

const base = (): Cut => ({
  version: 1, width: 1280, height: 720, fps: 25,
  tracks: [
    { id: 'v1', kind: 'video', name: 'Main' },
    { id: 'v2', kind: 'video' },
    { id: 'a1', kind: 'audio' },
    { id: 'a2', kind: 'audio' },
  ],
  clips: [
    { id: 'c1', track: 'v1', src: 'media/intro.mp4', at: 0, out: 5 },
    { id: 'c2', track: 'v1', src: 'media/street.mov', at: 8, out: 4 },
    { id: 'c3', track: 'v2', src: 'media/logo.png', at: 20, dur: 3 },
    { id: 'c4', track: 'a2', src: 'media/music.mp3', at: 0, out: 30 },
  ],
});
const valid = (cut: Cut) => {
  const r = validateCut(cut);
  expect(r.ok ? [] : r.errors).toEqual([]);
  return cut;
};

describe('appendMedia (issue 426): files after the end of the first track of their kind', () => {
  it('a video and a photo go after the last clip of the first video track, a sound after the first audio track\'s', () => {
    const r = appendMedia(base(), [{ src: 'media/b.webm', len: 2 }, { src: 'media/p.jpg', len: 5 }, { src: 'media/voice.wav', len: 3 }])!;
    valid(r.cut);
    const added = r.ids.map((id) => r.cut.clips.find((c) => c.id === id)!);
    expect(added.map((c) => [c.track, c.src, c.at])).toEqual([
      ['v1', 'media/b.webm', 12], ['v1', 'media/p.jpg', 14], ['a1', 'media/voice.wav', 0],
    ]);
    expect(added[0]).toMatchObject({ out: 2 });
    expect(added[1]).toMatchObject({ dur: 5 });
    expect(r.skipped).toEqual([]);
    expect(r.cut.tracks).toHaveLength(4);
  });

  it('adds a track of the kind when there is none', () => {
    const cut: Cut = { ...base(), tracks: [{ id: 'v1', kind: 'video' }], clips: [] };
    const r = appendMedia(cut, [{ src: 'a.mp3', len: 4 }, { src: 'b.m4a', len: 1.5 }])!;
    valid(r.cut);
    expect(r.cut.tracks.map((t) => t.kind)).toEqual(['video', 'audio']);
    const a = r.cut.tracks[1]!.id;
    expect(r.cut.clips.map((c) => [c.track, c.at, c.out])).toEqual([[a, 0, 4], [a, 4, 1.5]]);
  });

  it('skips what no track takes (a gif, a text file) and lengths that are not above 0; nothing taken is null', () => {
    const r = appendMedia(base(), [{ src: 'x.gif', len: 5 }, { src: 'notes.txt', len: 5 }, { src: 'c.mp4', len: 0 }, { src: 'd.mp4', len: 1 }])!;
    expect(r.skipped).toEqual(['x.gif', 'notes.txt', 'c.mp4']);
    expect(r.ids).toHaveLength(1);
    expect(appendMedia(base(), [{ src: 'x.gif', len: 5 }])).toBeNull();
  });
});

describe('newCutOf (issue 426): an edit of the files back to back in their order', () => {
  it('lays videos and photos on one video track and sounds on one audio track, each from 0', () => {
    const r = newCutOf([{ src: 'clips/a.mp4', len: 3 }, { src: 'clips/b.png', len: 5 }, { src: 'clips/m.wav', len: 10 }, { src: 'clips/c.mov', len: 2.5 }])!;
    valid(r.cut);
    expect({ ...r.cut, tracks: [], clips: [] }).toEqual({ ...NEW_CUT, tracks: [], clips: [] });
    expect(r.cut.tracks.map((t) => t.kind)).toEqual(['video', 'audio']);
    expect(r.cut.clips.map((c) => [c.src, c.at])).toEqual([['clips/a.mp4', 0], ['clips/b.png', 3], ['clips/m.wav', 0], ['clips/c.mov', 8]]);
  });

  it('nothing it can take: null', () => {
    expect(newCutOf([{ src: 'a.txt', len: 1 }])).toBeNull();
    expect(newCutOf([])).toBeNull();
  });
});
