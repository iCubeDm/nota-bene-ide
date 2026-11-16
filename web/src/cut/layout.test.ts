import { expect, it } from 'vitest';
import { drawable, fmtTime, rulerStep } from './layout.ts';

it('drawable: video tracks top-down from the one on top of the picture, then the audio tracks in order', () => {
  const d = drawable({
    tracks: [
      { id: 'a1', kind: 'audio' },
      { id: 'v1', kind: 'video', name: 'Main' },
      { id: 'v2', kind: 'video', hidden: true },
      { id: 'a2', kind: 'audio', mute: true, gain: -6 },
      { id: 'v1', kind: 'audio' }, // a duplicate: the first one stands
      { id: 'x', kind: 'subtitles' },
    ],
    clips: [],
  });
  expect(d.lanes.map((l) => `${l.id}:${l.kind}:${l.n}`)).toEqual(['v2:video:2', 'v1:video:1', 'a1:audio:1', 'a2:audio:2']);
  expect(d.lanes[0]!.hidden).toBe(true);
  expect(d.lanes[3]).toMatchObject({ mute: true, gain: -6 });
  expect(d.lanes[1]!.name).toBe('Main');
});

it('drawable: places what it can, by index, and skips the rest', () => {
  const d = drawable({
    tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }],
    clips: [
      { id: 'c1', track: 'v1', src: 'm/a.mp4', at: 1, in: 2, out: 5 },
      { id: 'c2', track: 'v1', src: 'm/b.png', at: 4, dur: 2 },
      { id: 'c3', track: 'nope', src: 'm/c.mp4', at: 0, out: 1 },
      { id: 'c4', track: 'a1', src: 'm/d.wav', at: 0, in: 3, out: 1 }, // out before in
      { id: 'c5', track: 'a1', src: 'm/e.wav', at: 'x', out: 1 },
      'junk',
      { id: 'c7', track: 'a1', src: 'm/f.wav', at: 2, out: 4 },
    ],
  });
  expect(d.blocks).toEqual([
    { i: 0, id: 'c1', track: 'v1', src: 'm/a.mp4', at: 1, len: 3, from: 2, photo: false },
    { i: 1, id: 'c2', track: 'v1', src: 'm/b.png', at: 4, len: 2, from: 0, photo: true },
    { i: 6, id: 'c7', track: 'a1', src: 'm/f.wav', at: 2, len: 4, from: 0, photo: false },
  ]);
  expect(d.end).toBe(6);
});

it('drawable: nothing to draw from what is not an edit', () => {
  expect(drawable(null)).toEqual({ lanes: [], blocks: [], end: 0 });
  expect(drawable({ tracks: 'x', clips: 3 })).toEqual({ lanes: [], blocks: [], end: 0 });
});

it('rulerStep keeps labels apart', () => {
  expect(rulerStep(100)).toBe(1); // 100 px a second: a label each second
  expect(rulerStep(40)).toBe(2);
  expect(rulerStep(1000)).toBe(0.1);
  expect(rulerStep(2)).toBe(60);
  expect(rulerStep(0.01)).toBe(3600);
});

it('fmtTime: minutes and seconds, tenths when asked', () => {
  expect(fmtTime(0)).toBe('0:00');
  expect(fmtTime(65)).toBe('1:05');
  expect(fmtTime(5.25, true)).toBe('0:05.2');
  expect(fmtTime(3725)).toBe('1:02:05');
});
