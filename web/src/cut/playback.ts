// The preview's timing and mixing as pure sums (issue 408): which clip each track shows or sounds at a timeline time,
// where in its source that is, what to preload, the gain of a clip's sound at a time, and the playhead's steps. The
// engine (engine.ts) only applies them to media elements and Web Audio nodes.
import { clipLength, isPhotoSrc, type Cut, type CutClip, type CutTrack } from '@nota-bene/shared/cut';

// a clip that ends where the next one starts gives way to it, whatever the float sums say (cutCheck.ts's EPS)
const EPS = 1e-6;

export const clipEnd = (c: CutClip): number => c.at + clipLength(c);

// each track's clips by start, once per edit object (an edited file is a new object)
const index = new WeakMap<Cut, Map<string, CutClip[]>>();
function byTrack(cut: Cut): Map<string, CutClip[]> {
  let m = index.get(cut);
  if (!m) {
    m = new Map(cut.tracks.map((t) => [t.id, [] as CutClip[]]));
    for (const c of cut.clips) m.get(c.track)?.push(c);
    for (const list of m.values()) list.sort((a, b) => a.at - b.at);
    index.set(cut, m);
  }
  return m;
}

const covers = (c: CutClip, t: number) => c.at <= t + EPS && t < clipEnd(c) - EPS;

/** The clip in view (or sounding) on each track at `t`, by track id; a track with nothing there is absent. */
export function activeClips(cut: Cut, t: number): Map<string, CutClip> {
  const out = new Map<string, CutClip>();
  for (const [track, list] of byTrack(cut)) {
    const c = list.find((x) => covers(x, t));
    if (c) out.set(track, c);
  }
  return out;
}

/** The first clip on `track` that starts after `t`: the one to preload behind the clip in view. */
export const nextClip = (cut: Cut, track: string, t: number): CutClip | undefined =>
  byTrack(cut).get(track)?.find((c) => c.at > t + EPS);

/** Where in its source a video or audio clip is at timeline time `t`: `in + (t - at)`, within `in..out`. */
export function sourceTime(c: CutClip, t: number): number {
  const from = c.in ?? 0;
  return Math.min(c.out ?? from, Math.max(from, from + t - c.at));
}

export type Layer = { track: string; clip: CutClip; z: number };
/** The picture at `t`: the visible video tracks' clips in view, bottom-up (tracks order, a later one covers). */
export function videoLayers(cut: Cut, t: number): Layer[] {
  const on = activeClips(cut, t);
  return cut.tracks.filter((x) => x.kind === 'video').flatMap((x, z) => {
    const clip = on.get(x.id);
    return clip && !x.hidden ? [{ track: x.id, clip, z }] : [];
  });
}

/** Decibels as an amplitude factor. */
export const dbGain = (db: number): number => 10 ** (db / 20);

/** The clip's fade envelope at `t`: linear up over `fadeIn` from its start and down over `fadeOut` to its end, 0 outside. */
export function fadeAt(c: CutClip, t: number): number {
  const end = clipEnd(c);
  if (t < c.at - EPS || t >= end - EPS) return 0;
  const up = c.fadeIn ? (t - c.at) / c.fadeIn : 1;
  const down = c.fadeOut ? (end - t) / c.fadeOut : 1;
  return Math.max(0, Math.min(1, up, down));
}

/** Whether a track's sound is heard: not muted, and soloed if any track is. */
export const audible = (cut: Cut, track: CutTrack): boolean => !track.mute && (track.solo === true || !cut.tracks.some((x) => x.solo));

/** A track's gain node: its dB, or 0 when mute or solo silences it. */
export const trackLevel = (cut: Cut, track: CutTrack): number => (audible(cut, track) ? dbGain(track.gain ?? 0) : 0);

/** A clip's own sound level before fades: its dB, 0 for a muted clip or a photo (no sound). */
export const clipLevel = (c: CutClip): number => (c.mute || isPhotoSrc(c.src) ? 0 : dbGain(c.gain ?? 0));

/** The clip's sound at `t` as it reaches the master: clip gain × fade × track gain (mute, solo). */
export function gainAt(cut: Cut, c: CutClip, t: number): number {
  const track = cut.tracks.find((x) => x.id === c.track);
  return track ? clipLevel(c) * fadeAt(c, t) * trackLevel(cut, track) : 0;
}

/**
 * The fade envelope from `from` to the clip's end as points for linear ramps: the level at `from`, then each corner
 * after it (fade-in done, fade-out begins, the end). Without fades it is one level.
 */
export function fadeRamp(c: CutClip, from: number): { t: number; v: number }[] {
  const end = clipEnd(c);
  const pts = [{ t: from, v: fadeAt(c, from) }];
  const corner = (t: number, v: number) => { if (t > from + EPS && t <= end + EPS) pts.push({ t, v }); };
  if (c.fadeIn) corner(c.at + c.fadeIn, 1);
  if (c.fadeOut) {
    corner(end - c.fadeOut, 1);
    corner(end, 0);
  }
  return pts;
}

/** One frame back (`dir` −1) or forward on the edit's frame grid, within `0..end`. */
export function frameStep(t: number, fps: number, dir: 1 | -1, end: number): number {
  const f = t * fps;
  const n = dir > 0 ? Math.floor(f + EPS) + 1 : Math.ceil(f - EPS) - 1;
  return Math.max(0, Math.min(end, n / fps));
}

/** Every clip start and end, and 0, in order: where the edge keys stop. */
export function clipEdges(cut: Cut): number[] {
  const all = [0, ...cut.clips.flatMap((c) => [c.at, clipEnd(c)])].sort((a, b) => a - b);
  return all.filter((x, i) => i === 0 || x - all[i - 1]! > EPS);
}

/** The previous (`dir` −1) or next clip edge from `t`: the start when there is none before, `t` when none after. */
export function edgeStep(cut: Cut, t: number, dir: 1 | -1): number {
  const edges = clipEdges(cut);
  if (dir > 0) return edges.find((e) => e > t + EPS) ?? t;
  return edges.findLast((e) => e < t - EPS) ?? 0;
}

// beyond this a playing element seeks; below it, its rate is nudged until it is back within a frame
const SEEK_DRIFT = 0.2;
const NUDGE = 0.1;

/**
 * What keeps an element on the clock: `have` where it is in its source, `want` where the clock says. A playing one
 * within a frame runs at 1; further off it runs up to 10 % faster or slower to catch up, and over SEEK_DRIFT it seeks.
 * A paused one seeks to the frame unless it already shows it (within half a frame).
 */
export function syncAction(have: number, want: number, fps: number, playing: boolean): { rate: number; seek?: number } {
  const d = have - want;
  if (!playing) return Math.abs(d) > 0.5 / fps ? { rate: 1, seek: want } : { rate: 1 };
  if (Math.abs(d) <= 1 / fps) return { rate: 1 };
  if (Math.abs(d) > SEEK_DRIFT) return { rate: 1, seek: want };
  return { rate: Math.max(1 - NUDGE, Math.min(1 + NUDGE, 1 - d)) };
}
