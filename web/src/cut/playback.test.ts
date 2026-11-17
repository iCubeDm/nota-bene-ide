import { expect, it } from 'vitest';
import type { Cut } from '@nota-bene/shared/cut';
import {
  activeClips, audible, clipEdges, lastFrame, clipLevel, dbGain, edgeStep, fadeAt, fadeRamp, frameStep, gainAt, layerOpacity, nextClip, sourceTime,
  syncAction, trackLevel,
} from './playback.ts';

// two cameras on two video tracks (the upper one hidden for a while), a photo over them, a voice and a music track
const cut = (): Cut => ({
  version: 1, width: 1280, height: 720, fps: 25,
  tracks: [
    { id: 'v1', kind: 'video' },
    { id: 'v2', kind: 'video' },
    { id: 'v3', kind: 'video', hidden: true },
    { id: 'a1', kind: 'audio', gain: -6 },
    { id: 'a2', kind: 'audio', mute: true },
  ],
  clips: [
    { id: 'c1', track: 'v1', src: 'media/a.mp4', at: 0, in: 2, out: 7 },
    { id: 'c2', track: 'v1', src: 'media/a.mp4', at: 5, in: 10, out: 14 },
    { id: 'p1', track: 'v2', src: 'media/logo.png', at: 1, dur: 3, place: { x: 0.7, y: 0.05, w: 0.25, h: 0.2, opacity: 0.5 } },
    { id: 'c3', track: 'v3', src: 'media/b.mov', at: 0, out: 9 },
    { id: 's1', track: 'a1', src: 'media/voice.wav', at: 0.5, out: 5.5, gain: 6, fadeIn: 1, fadeOut: 2 },
    { id: 's2', track: 'a1', src: 'media/voice2.wav', at: 8, out: 1 },
    { id: 'm1', track: 'a2', src: 'media/music.mp3', at: 0, in: 10, out: 19 },
  ],
});
const ids = (m: Map<string, { id: string }>) => Object.fromEntries([...m].map(([k, c]) => [k, c.id]));

it('activeClips: the clip in view on each track at a time; a clip ends where the next one starts', () => {
  const c = cut();
  expect(ids(activeClips(c, 0))).toEqual({ v1: 'c1', v3: 'c3', a2: 'm1' });
  expect(ids(activeClips(c, 2))).toEqual({ v1: 'c1', v2: 'p1', v3: 'c3', a1: 's1', a2: 'm1' });
  expect(ids(activeClips(c, 5))).toEqual({ v1: 'c2', v3: 'c3', a1: 's1', a2: 'm1' });
  expect(ids(activeClips(c, 4))).toEqual({ v1: 'c1', v3: 'c3', a1: 's1', a2: 'm1' }); // the photo's 3 s are over
  expect(ids(activeClips(c, 8.5))).toEqual({ v1: 'c2', v3: 'c3', a1: 's2', a2: 'm1' });
  expect(ids(activeClips(c, 9))).toEqual({}); // where the last clips end
  expect(ids(activeClips(c, 20))).toEqual({});
  // float sums: a clip ending at 0.1 + 0.2 gives way to one starting at 0.3
  const f: Cut = { ...c, clips: [
    { id: 'x', track: 'v1', src: 'x.mp4', at: 0.1, out: 0.2 },
    { id: 'y', track: 'v1', src: 'y.mp4', at: 0.3, out: 1 },
  ] };
  expect(ids(activeClips(f, 0.1 + 0.2))).toEqual({ v1: 'y' });
});

it('sourceTime: in + the time since the clip started, within the used part', () => {
  const [c1, c2] = cut().clips;
  expect(sourceTime(c1!, 0)).toBe(2);
  expect(sourceTime(c1!, 3.5)).toBe(5.5);
  expect(sourceTime(c2!, 5)).toBe(10);
  expect(sourceTime(c2!, 100)).toBe(14);
  expect(sourceTime(c2!, 0)).toBe(10);
  expect(sourceTime({ id: 'n', track: 'v1', src: 'n.mp4', at: 1, out: 3 }, 2)).toBe(1); // in defaults to 0
});

it('nextClip: the first clip on the track that starts after the time, for preloading', () => {
  const c = cut();
  expect(nextClip(c, 'v1', 0)?.id).toBe('c2');
  expect(nextClip(c, 'v1', 5)).toBeUndefined(); // c2 is in view, nothing after it
  expect(nextClip(c, 'a1', 0)?.id).toBe('s1');
  expect(nextClip(c, 'a1', 3)?.id).toBe('s2');
  expect(nextClip(c, 'v2', 0.5)?.id).toBe('p1');
});

it('dbGain: decibels as an amplitude factor', () => {
  expect(dbGain(0)).toBe(1);
  expect(dbGain(-6)).toBeCloseTo(0.501, 3);
  expect(dbGain(6)).toBeCloseTo(1.995, 3);
  expect(dbGain(-20)).toBeCloseTo(0.1, 6);
});

it('fadeAt: linear from the clip start over fadeIn and to its end over fadeOut; 0 outside the clip', () => {
  const s1 = cut().clips[4]!; // 0.5..6, fade in 1 s, out 2 s
  expect(fadeAt(s1, 0.5)).toBe(0);
  expect(fadeAt(s1, 1)).toBeCloseTo(0.5);
  expect(fadeAt(s1, 1.5)).toBe(1);
  expect(fadeAt(s1, 3)).toBe(1);
  expect(fadeAt(s1, 5)).toBeCloseTo(0.5);
  expect(fadeAt(s1, 6)).toBe(0);
  expect(fadeAt(s1, 0.2)).toBe(0);
  expect(fadeAt(cut().clips[0]!, 0)).toBe(1); // no fades: full from the first instant
});

it('mute and solo: a muted track is silent; any solo silences the tracks without solo', () => {
  const c = cut();
  const [v1, , , a1, a2] = c.tracks;
  expect([audible(c, v1!), audible(c, a1!), audible(c, a2!)]).toEqual([true, true, false]);
  a1!.solo = true;
  expect([audible(c, v1!), audible(c, a1!), audible(c, a2!)]).toEqual([false, true, false]);
  a2!.solo = true; // solo does not undo mute
  expect(audible(c, a2!)).toBe(false);
  expect(trackLevel(c, a1!)).toBeCloseTo(0.501, 3);
  expect(trackLevel(c, v1!)).toBe(0);
});

it('gainAt: clip gain × fade × track gain, with the clip mute, solo and a photo (no sound)', () => {
  const c = cut();
  const s1 = c.clips[4]!;
  expect(gainAt(c, s1, 3)).toBeCloseTo(1); // +6 dB clip on a −6 dB track
  expect(gainAt(c, s1, 1)).toBeCloseTo(0.5);
  expect(gainAt(c, c.clips[6]!, 3)).toBe(0); // its track is muted
  expect(gainAt(c, c.clips[0]!, 1)).toBe(1);
  expect(gainAt(c, c.clips[3]!, 1)).toBe(1); // a hidden track's sound still plays
  expect(gainAt(c, c.clips[2]!, 2)).toBe(0); // a photo has no sound
  expect(clipLevel({ ...s1, mute: true })).toBe(0);
  c.tracks[4]!.mute = false;
  c.tracks[4]!.solo = true;
  expect(gainAt(c, c.clips[6]!, 3)).toBe(1);
  expect(gainAt(c, s1, 3)).toBe(0);
});

it('layerOpacity: a video clip\'s picture fades with its fades (issue 431), times its place\'s opacity', () => {
  const c = cut();
  const fading = { ...c.clips[0]!, fadeIn: 1, fadeOut: 2 }; // 0..5
  expect(layerOpacity(fading, 0)).toBe(0); // from black
  expect(layerOpacity(fading, 0.5)).toBeCloseTo(0.5);
  expect(layerOpacity(fading, 2)).toBe(1);
  expect(layerOpacity(fading, 4)).toBeCloseTo(0.5);
  expect(layerOpacity(c.clips[0]!, 0)).toBe(1); // no fades: whole from the first frame
  const photo = { ...c.clips[2]!, fadeIn: 1 }; // at 1, opacity 0.5
  expect(layerOpacity(photo, 1.5)).toBeCloseTo(0.25);
  expect(layerOpacity(c.clips[2]!, 2)).toBe(0.5);
});

it('fadeRamp: the fade envelope from a time to the clip end as points for linear ramps', () => {
  const s1 = cut().clips[4]!; // 0.5..6, in 1 s, out 2 s
  expect(fadeRamp(s1, 0.5)).toEqual([{ t: 0.5, v: 0 }, { t: 1.5, v: 1 }, { t: 4, v: 1 }, { t: 6, v: 0 }]);
  const mid = fadeRamp(s1, 1);
  expect(mid[0]!.t).toBe(1);
  expect(mid[0]!.v).toBeCloseTo(0.5);
  expect(mid.slice(1)).toEqual([{ t: 1.5, v: 1 }, { t: 4, v: 1 }, { t: 6, v: 0 }]);
  expect(fadeRamp(s1, 5)).toEqual([{ t: 5, v: 0.5 }, { t: 6, v: 0 }]);
  expect(fadeRamp(cut().clips[0]!, 1)).toEqual([{ t: 1, v: 1 }]); // no fades: one level
});

it('frameStep: one frame back or forward on the frame grid, within the edit', () => {
  expect(frameStep(0, 25, 1, 10)).toBeCloseTo(0.04);
  expect(frameStep(0.12, 25, 1, 10)).toBeCloseTo(0.16); // on a frame: the next one
  expect(frameStep(0.13, 25, 1, 10)).toBeCloseTo(0.16); // between frames: the next on the grid
  expect(frameStep(0.13, 25, -1, 10)).toBeCloseTo(0.12);
  expect(frameStep(0.12, 25, -1, 10)).toBeCloseTo(0.08);
  expect(frameStep(0, 25, -1, 10)).toBe(0);
  expect(frameStep(10, 25, 1, 10)).toBeCloseTo(9.96); // the last frame: the end itself shows nothing
  expect(frameStep(9.96, 25, 1, 10)).toBeCloseTo(9.96);
  // 3 frames forward and back land where they started
  let t = 1;
  for (let i = 0; i < 3; i++) t = frameStep(t, 30, 1, 10);
  for (let i = 0; i < 3; i++) t = frameStep(t, 30, -1, 10);
  expect(t).toBeCloseTo(1, 9);
});

it('lastFrame: where the last frame of the edit starts', () => {
  expect(lastFrame(10, 25)).toBeCloseTo(9.96);
  expect(lastFrame(9.97, 25)).toBeCloseTo(9.96);
  expect(lastFrame(0.01, 25)).toBe(0);
  expect(lastFrame(0, 25)).toBe(0);
});

it('clipEdges and edgeStep: the previous or next clip start or end on any track', () => {
  const c = cut();
  expect(clipEdges(c)).toEqual([0, 0.5, 1, 4, 5, 6, 8, 9]);
  expect(edgeStep(c, 0, 1)).toBe(0.5);
  expect(edgeStep(c, 4.5, 1)).toBe(5);
  expect(edgeStep(c, 5, 1)).toBe(6);
  expect(edgeStep(c, 5, -1)).toBe(4);
  expect(edgeStep(c, 4.5, -1)).toBe(4);
  expect(edgeStep(c, 0, -1)).toBe(0);
  expect(edgeStep(c, 9, 1)).toBe(9);
  expect(edgeStep(c, 12, -1)).toBe(9);
});

it('syncAction: a playing element nudges its rate for small drift and seeks for large; a paused one seeks to the frame', () => {
  const fps = 25;
  expect(syncAction(5, 5.01, fps, true)).toEqual({ rate: 1 }); // within a frame
  const behind = syncAction(5, 5.1, fps, true);
  expect(behind.seek).toBeUndefined();
  expect(behind.rate).toBeGreaterThan(1);
  expect(behind.rate).toBeLessThanOrEqual(1.1);
  const ahead = syncAction(5.1, 5, fps, true);
  expect(ahead.rate).toBeLessThan(1);
  expect(ahead.rate).toBeGreaterThanOrEqual(0.9);
  expect(syncAction(5, 6, fps, true)).toEqual({ rate: 1, seek: 6 });
  expect(syncAction(5, 5.01, fps, false)).toEqual({ rate: 1 }); // the same frame
  expect(syncAction(5, 5.1, fps, false)).toEqual({ rate: 1, seek: 5.1 });
});
