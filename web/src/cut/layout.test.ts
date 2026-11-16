import { expect, it } from 'vitest';
import { drawable, drawnSpan, fmtTime, ppsRange, rulerStep, ticksIn } from './layout.ts';

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

it('drawnSpan: the edit and a little room after it, in proportion', () => {
  expect(drawnSpan(100)).toBeCloseTo(103);
  expect(drawnSpan(3600)).toBeCloseTo(3708);
  expect(drawnSpan(0)).toBeCloseTo(1.03); // an empty edit still has a second to draw
});

it('ppsRange: the zoom keeps a long edit well below the width a browser can draw', () => {
  expect(ppsRange(10)).toEqual({ min: 0.5, max: 1000 });
  const long = ppsRange(drawnSpan(3600));
  expect(long.max * drawnSpan(3600)).toBeLessThanOrEqual(2_000_000);
  const huge = ppsRange(1e7);
  expect(huge.min).toBeLessThanOrEqual(huge.max);
});

it('ticksIn: only the ticks within the seen range, on the step', () => {
  expect(ticksIn(1, 100, 10.5, 13.2)).toEqual([10, 11, 12, 13, 14]); // a tick before and after the range
  expect(ticksIn(0.1, 5, 0, 0.3)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
  expect(ticksIn(60, 100, 0, 1000)).toEqual([0, 60]); // never past the span
  expect(ticksIn(0.1, 3708, 1800, 1810)).toHaveLength(102);
});
