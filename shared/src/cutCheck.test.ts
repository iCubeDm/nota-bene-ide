import { describe, expect, it } from 'vitest';
import { clipLength, cutDuration, isCutPath, isPhotoSrc, validateCut, type CutIssue } from './cut.ts';

// a valid edit: a main video, a photo over it, voice and music
const base = () => ({
  version: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  tracks: [
    { id: 'v1', kind: 'video', name: 'Main' },
    { id: 'v2', kind: 'video', name: 'Over' },
    { id: 'a1', kind: 'audio', name: 'Voice', gain: -3 },
    { id: 'a2', kind: 'audio', name: 'Music', mute: true },
  ],
  clips: [
    { id: 'c1', track: 'v1', src: 'media/intro.mp4', at: 0, in: 2, out: 7 },
    { id: 'c2', track: 'v1', src: 'media/street.mov', at: 5, out: 4, fadeOut: 1 },
    { id: 'c3', track: 'v2', src: 'media/logo.png', at: 1, dur: 3, place: { x: 0.7, y: 0.05, w: 0.25, h: 0.2, opacity: 0.8 } },
    { id: 'c4', track: 'a1', src: 'media/voice.wav', at: 0.5, out: 6, gain: 2 },
    { id: 'c5', track: 'a2', src: 'media/music.mp3', at: 0, in: 10, out: 19, fadeIn: 1, fadeOut: 2 },
  ],
});
type Raw = ReturnType<typeof base>;
const issues = (v: unknown): CutIssue[] => {
  const r = validateCut(v);
  return r.ok ? [] : r.errors;
};
const codes = (v: unknown) => issues(v).map((i) => `${i.path} ${i.code}`);
const edit = (fn: (c: Raw & Record<string, unknown>) => void) => {
  const c = base();
  fn(c as Raw & Record<string, unknown>);
  return c;
};
const clip = (c: Raw, id: string) => c.clips.find((x) => x.id === id)! as Record<string, unknown>;

describe('validateCut', () => {
  it('accepts a valid edit and hands it back', () => {
    const c = base();
    const r = validateCut(c);
    expect(r).toEqual({ ok: true, cut: c });
  });

  it('accepts an empty edit', () => {
    expect(validateCut({ version: 1, width: 640, height: 360, fps: 25, tracks: [], clips: [] }).ok).toBe(true);
  });

  it('refuses what is not an edit at all', () => {
    expect(codes(null)).toEqual([' type']);
    expect(codes([])).toEqual([' type']);
    expect(codes('x')).toEqual([' type']);
  });

  it('refuses another version', () => {
    expect(codes(edit((c) => { c.version = 2; }))).toEqual(['version version']);
  });

  it('refuses a bad frame', () => {
    expect(codes(edit((c) => { c.width = 0; c.height = Number.NaN; c.fps = -1; }))).toEqual([
      'width positive', 'height number', 'fps positive',
    ]);
  });

  it('refuses tracks and clips that are not lists', () => {
    expect(codes(edit((c) => { (c as Record<string, unknown>).tracks = {}; (c as Record<string, unknown>).clips = undefined; }))).toEqual([
      'tracks type', 'clips type',
    ]);
  });

  it('names an unknown track, with the clip', () => {
    const r = issues(edit((c) => { clip(c, 'c2').track = 'v9'; }));
    expect(r).toEqual([{ path: 'clips[1].track', code: 'unknown-track', clip: 'c2' }]);
  });

  it('refuses a bad track kind and a duplicate track id', () => {
    const c = edit((c) => {
      (c.tracks[1] as Record<string, unknown>).kind = 'subtitles';
      c.tracks[3]!.id = 'a1';
    });
    expect(issues(c)).toEqual([
      { path: 'tracks[1].kind', code: 'kind', track: 'v2' },
      { path: 'tracks[3].id', code: 'duplicate', track: 'a1' },
      { path: 'clips[4].track', code: 'unknown-track', clip: 'c5' }, // a2 is gone
    ]);
  });

  it('refuses a duplicate clip id', () => {
    expect(issues(edit((c) => { clip(c, 'c4').id = 'c1'; }))).toEqual([{ path: 'clips[3].id', code: 'duplicate', clip: 'c1' }]);
  });

  it('refuses out before or at in', () => {
    expect(codes(edit((c) => { clip(c, 'c1').out = 2; }))).toEqual(['clips[0].out out-before-in']);
    expect(codes(edit((c) => { clip(c, 'c1').out = 1; }))).toEqual(['clips[0].out out-before-in']);
  });

  it('refuses a video or audio clip without out, or with dur', () => {
    expect(codes(edit((c) => { delete clip(c, 'c4').out; }))).toEqual(['clips[3].out media-no-out']);
    expect(codes(edit((c) => { clip(c, 'c1').dur = 3; }))).toEqual(['clips[0].dur media-dur']);
  });

  it('refuses a photo with in/out or without dur', () => {
    expect(codes(edit((c) => { clip(c, 'c3').in = 0; clip(c, 'c3').out = 2; }))).toEqual([
      'clips[2].in photo-in-out', 'clips[2].out photo-in-out',
    ]);
    expect(codes(edit((c) => { delete clip(c, 'c3').dur; }))).toEqual(['clips[2].dur photo-no-dur']);
    expect(codes(edit((c) => { clip(c, 'c3').dur = 0; }))).toEqual(['clips[2].dur positive']);
  });

  it('refuses a photo on an audio track', () => {
    expect(codes(edit((c) => { const x = clip(c, 'c3'); x.track = 'a1'; x.at = 20; delete x.place; }))).toEqual(['clips[2].track photo-audio']);
  });

  it('refuses bad numbers', () => {
    expect(codes(edit((c) => {
      clip(c, 'c1').at = -1;
      clip(c, 'c2').in = Number.NaN;
      clip(c, 'c4').gain = Number.POSITIVE_INFINITY;
      clip(c, 'c5').fadeIn = -0.5;
      (c.tracks[2] as Record<string, unknown>).gain = '3';
    }))).toEqual([
      'tracks[2].gain number', 'clips[0].at negative', 'clips[1].in number', 'clips[3].gain number', 'clips[4].fadeIn negative',
    ]);
  });

  it('a negative gain is fine', () => {
    expect(validateCut(edit((c) => { clip(c, 'c4').gain = -12; })).ok).toBe(true);
  });

  it('refuses fades longer than the clip', () => {
    expect(validateCut(edit((c) => { clip(c, 'c4').fadeIn = 3; clip(c, 'c4').fadeOut = 3; })).ok).toBe(true); // 6 s, exactly
    expect(codes(edit((c) => { clip(c, 'c4').fadeIn = 3; clip(c, 'c4').fadeOut = 3.5; }))).toEqual(['clips[3].fadeOut fade']);
  });

  it('refuses a place outside the frame and a bad opacity', () => {
    expect(issues(edit((c) => { clip(c, 'c3').place = { x: 1.2, y: 0, w: 0, h: 0.5, opacity: 2 }; }))).toEqual([
      { path: 'clips[2].place.x', code: 'place', clip: 'c3' },
      { path: 'clips[2].place.w', code: 'place', clip: 'c3' },
      { path: 'clips[2].place.opacity', code: 'opacity', clip: 'c3' },
    ]);
    expect(codes(edit((c) => { clip(c, 'c3').place = 'top'; }))).toEqual(['clips[2].place type']);
  });

  it('refuses a place on an audio track', () => {
    expect(codes(edit((c) => { clip(c, 'c4').place = { x: 0, y: 0, w: 1, h: 1 }; }))).toEqual(['clips[3].place place-audio']);
  });

  it('refuses an overlap within a track, not across tracks', () => {
    // c2 on v1 starts at 5; c1 runs 0..5: they touch, no overlap. Move c2 to 4.5: it overlaps
    expect(issues(edit((c) => { clip(c, 'c2').at = 4.5; }))).toEqual([{ path: 'clips[1].at', code: 'overlap', clip: 'c2', track: 'v1' }]);
    // listed in any order: the later clip on the timeline is the one named
    expect(issues(edit((c) => { c.clips.reverse(); clip(c, 'c2').at = 4.5; }))).toEqual([
      { path: 'clips[3].at', code: 'overlap', clip: 'c2', track: 'v1' },
    ]);
  });

  it('refuses a source that is not project-relative', () => {
    expect(codes(edit((c) => {
      clip(c, 'c1').src = '/abs/intro.mp4';
      clip(c, 'c2').src = '../outside.mov';
      clip(c, 'c4').src = '';
    }))).toEqual(['clips[0].src src', 'clips[1].src src', 'clips[3].src src']);
  });

  it('refuses a source that is not video, audio or a photo, and a sound file on a video track', () => {
    expect(issues(edit((c) => { clip(c, 'c1').src = 'media/notes.txt'; clip(c, 'c2').src = 'media/voice.wav'; }))).toEqual([
      { path: 'clips[0].src', code: 'src-kind', clip: 'c1' },
      { path: 'clips[1].track', code: 'audio-video', clip: 'c2' },
    ]);
    // a video file on an audio track gives its sound: fine; the extension in any case
    expect(validateCut(edit((c) => { clip(c, 'c4').src = 'media/talk.MP4'; clip(c, 'c1').src = 'media/intro.WebM'; })).ok).toBe(true);
  });

  it('refuses a clip without an id, and a non-boolean flag', () => {
    expect(codes(edit((c) => { delete clip(c, 'c1').id; (c.tracks[0] as Record<string, unknown>).mute = 'yes'; }))).toEqual([
      'tracks[0].mute type', 'clips[0].id type',
    ]);
  });
});

describe('helpers', () => {
  it('isCutPath: the .nbcut.json ending, any case', () => {
    expect(isCutPath('edits/trip.nbcut.json')).toBe(true);
    expect(isCutPath('TRIP.NBCUT.JSON')).toBe(true);
    expect(isCutPath('trip.json')).toBe(false);
    expect(isCutPath('nbcut.json')).toBe(false);
  });

  it('isPhotoSrc follows the image extensions', () => {
    for (const p of ['a.png', 'b/c.JPG', 'd.jpeg', 'e.gif', 'f.webp', 'g.avif', 'h.bmp', 'i.svg']) expect(isPhotoSrc(p)).toBe(true);
    for (const p of ['a.mp4', 'b.wav', 'c.png.mov', 'png']) expect(isPhotoSrc(p)).toBe(false);
  });

  it('clipLength: out - in for media (in defaults to 0), dur for a photo', () => {
    expect(clipLength({ id: 'a', track: 't', src: 'x.mp4', at: 3, in: 2, out: 7 })).toBe(5);
    expect(clipLength({ id: 'a', track: 't', src: 'x.mp4', at: 3, out: 4 })).toBe(4);
    expect(clipLength({ id: 'a', track: 't', src: 'x.png', at: 3, dur: 2.5 })).toBe(2.5);
  });

  it('cutDuration is the end of the last clip', () => {
    expect(cutDuration(base() as never)).toBe(9); // c2 ends at 5 + 4, c5 at 0 + 19 - 10
    expect(cutDuration({ version: 1, width: 1, height: 1, fps: 1, tracks: [], clips: [] })).toBe(0);
  });
});
