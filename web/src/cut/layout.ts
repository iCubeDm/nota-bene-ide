// What the timeline draws from an edit, valid or not: the lanes and the clips it can place. An invalid edit still
// shows what is readable in it; its problems are listed by the view (validateCut), never thrown.
import { isPhotoSrc } from '@nota-bene/shared/cut';

export type Lane = { id: string; kind: 'video' | 'audio'; name?: string; n: number; gain?: number; mute?: boolean; solo?: boolean; hidden?: boolean };
/**
 * A clip as drawn: `i` its index in `clips` (issue paths name it), `from` where it starts in its source; its sound's
 * gain (dB) and mute and its fades (issue 431), when the file has them.
 */
export type Block = {
  i: number; id: string; track: string; src: string; at: number; len: number; from: number; photo: boolean;
  gain?: number; mute?: boolean; fadeIn?: number; fadeOut?: number;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Lanes top-down: the video tracks from the one on top of the picture (the last in `tracks`) down, then the audio
 * tracks in their order; `n` numbers a track within its kind in file order, for a default name. A clip is drawn when its
 * track is a lane and its time and length make sense.
 */
export function drawable(v: unknown): { lanes: Lane[]; blocks: Block[]; end: number } {
  const lanes: Lane[] = [];
  const blocks: Block[] = [];
  if (!isObj(v)) return { lanes, blocks, end: 0 };
  const seen = new Set<string>();
  const count = { video: 0, audio: 0 };
  for (const t of Array.isArray(v.tracks) ? v.tracks : []) {
    if (!isObj(t) || typeof t.id !== 'string' || (t.kind !== 'video' && t.kind !== 'audio') || seen.has(t.id)) continue;
    seen.add(t.id);
    lanes.push({
      id: t.id, kind: t.kind, n: ++count[t.kind],
      ...(typeof t.name === 'string' && t.name && { name: t.name }),
      ...(fin(t.gain) && { gain: t.gain }),
      ...(t.mute === true && { mute: true }), ...(t.solo === true && { solo: true }), ...(t.hidden === true && { hidden: true }),
    });
  }
  const order = [...lanes.filter((l) => l.kind === 'video').reverse(), ...lanes.filter((l) => l.kind === 'audio')];
  let end = 0;
  (Array.isArray(v.clips) ? v.clips : []).forEach((c: unknown, i) => {
    if (!isObj(c) || typeof c.track !== 'string' || !seen.has(c.track) || typeof c.src !== 'string' || !fin(c.at) || c.at < 0) return;
    const photo = isPhotoSrc(c.src);
    const from = fin(c.in) ? c.in : 0;
    const len = photo ? c.dur : fin(c.out) ? c.out - from : NaN;
    if (!fin(len) || len <= 0) return;
    blocks.push({
      i, id: typeof c.id === 'string' ? c.id : '', track: c.track, src: c.src, at: c.at, len, from: photo ? 0 : from, photo,
      ...(fin(c.gain) && { gain: c.gain }), ...(c.mute === true && { mute: true }),
      ...(fin(c.fadeIn) && c.fadeIn > 0 && { fadeIn: c.fadeIn }), ...(fin(c.fadeOut) && c.fadeOut > 0 && { fadeOut: c.fadeOut }),
    });
    end = Math.max(end, c.at + len);
  });
  return { lanes: order, blocks, end };
}

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
/** Seconds between ruler labels at `pps` pixels a second: at least 70 px apart. */
export const rulerStep = (pps: number): number => STEPS.find((s) => s * pps >= 70) ?? STEPS[STEPS.length - 1]!;

/** `m:ss` (`h:mm:ss` from an hour), with tenths `m:ss.t`. */
export function fmtTime(sec: number, tenths = false): string {
  const d = Math.floor(Math.max(0, sec) * 10 + 1e-6);
  const s = Math.floor(d / 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  const ms = `${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  const body = s >= 3600 ? `${Math.floor(s / 3600)}:${ms}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  return tenths ? `${body}.${d % 10}` : body;
}

/** Seconds the timeline draws: the edit and room after it in proportion, so a fitted edit leaves no scrollbar. */
export const drawnSpan = (end: number): number => Math.max(end, 1) * 1.03;

// the widest the lanes get, px: browsers stop drawing (or placing) elements somewhere above 10M px
const MAX_WIDTH = 2_000_000;
/** The zoom's limits in pixels a second for `span` seconds drawn: 1000 at most, and never wider than MAX_WIDTH. */
export function ppsRange(span: number): { min: number; max: number } {
  const max = Math.min(1000, MAX_WIDTH / span);
  return { min: Math.min(0.5, max), max };
}

/** The ruler's ticks every `step` seconds from the one at or before `from` to the one after `to`, within `span`. */
export function ticksIn(step: number, span: number, from: number, to: number): number[] {
  const out: number[] = [];
  const last = Math.floor(Math.min(to, span) / step + 1e-9) + 1;
  for (let k = Math.max(0, Math.floor(from / step + 1e-9)); k <= last; k++) {
    const s = Math.round(k * step * 1000) / 1000;
    if (s > span + 1e-9) break;
    out.push(s);
  }
  return out;
}
