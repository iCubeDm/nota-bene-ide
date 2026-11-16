// The edit's checks and the small sums the editor and the export share. Pure: a missing source file is the editor's
// check (against the project), not this one's.
import { CUT_EXT, type Cut, type CutClip } from './cut.ts';
import { isAbsPath } from './paths.ts';

/** Image files; a clip whose source is one is a photo. web/src/files/kinds.ts reuses it for the file view. */
export const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
/** The photos an edit takes: the images the export reads as a still (not gif or svg). */
export const PHOTO = /\.(png|jpe?g|webp|avif|bmp)$/i;
/** Video and sound files: an edit's other sources, and the file view's players (web/src/files/kinds.ts). */
export const VIDEO = /\.(mp4|mov|webm|m4v)$/i;
export const AUDIO = /\.(mp3|wav|m4a|ogg)$/i;

/** An edit's file: `<name>.nbcut.json`, a name before the ending. */
export const isCutPath = (p: string): boolean => p.length > CUT_EXT.length && p.toLowerCase().endsWith(CUT_EXT) && !p.endsWith(`/${CUT_EXT}`);

export const isPhotoSrc = (src: string): boolean => IMAGE.test(src);

/** A clip's length on the timeline: `dur` for a photo, `out - in` for video and audio. */
export const clipLength = (c: CutClip): number => (isPhotoSrc(c.src) ? c.dur ?? 0 : (c.out ?? 0) - (c.in ?? 0));

/** Where the last clip ends; 0 for an edit without clips. */
export const cutDuration = (cut: Cut): number => cut.clips.reduce((m, c) => Math.max(m, c.at + clipLength(c)), 0);

/**
 * What is wrong in an edit: `path` names the field (`clips[2].out`), `clip`/`track` the id it belongs to. Codes:
 * `type` (missing or of the wrong type), `version`, `number` (not a finite number), `negative`, `positive` (must be
 * above 0), `frame-size` (width or height not a whole number from 16 to 8192), `fps` (not from 1 to 120), `out-before-in`, `kind` (a track is not video or audio), `duplicate` (an id used twice), `unknown-track`,
 * `photo-in-out`, `photo-no-dur`, `media-no-out`, `media-dur`, `photo-audio` (a photo on an audio track), `fade` (the
 * fades are longer than the clip), `place` (outside 0..1, or no size), `opacity` (outside 0..1), `place-audio` (a
 * place on an audio track), `src` (not a project-relative path), `src-kind` (not a video, sound or photo file by its
 * extension), `photo-kind` (an image the export cannot read as a still: gif, svg), `audio-video` (a sound file on a video track), `overlap` (with the clip before it on its track).
 */
export type CutIssue = { path: string; code: string; clip?: string; track?: string };

export type CutCheck = { ok: true; cut: Cut } | { ok: false; errors: CutIssue[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// clips that touch (one ends where the next starts) do not overlap, whatever the float sums say
const EPS = 1e-6;

/** Checks a parsed `*.nbcut.json`. On success the same object comes back typed; unknown fields are left alone. */
export function validateCut(v: unknown): CutCheck {
  if (!isObj(v)) return { ok: false, errors: [{ path: '', code: 'type' }] };
  const errors: CutIssue[] = [];
  let owner: { clip?: string; track?: string } = {};
  const fail = (path: string, code: string) => void errors.push({ path, code, ...owner });
  // a finite number at `path`, or undefined (and an issue unless it is optional and absent)
  const num = (o: Record<string, unknown>, at: string, key: string, rule: 'any' | 'min0' | 'positive', optional = false): number | undefined => {
    const x = o[key];
    const path = at ? `${at}.${key}` : key;
    if (x === undefined && optional) return undefined;
    if (typeof x !== 'number' || !Number.isFinite(x)) return void fail(path, x === undefined ? 'type' : 'number');
    if (rule === 'min0' && x < 0) return void fail(path, 'negative');
    if (rule === 'positive' && x <= 0) return void fail(path, 'positive');
    return x;
  };
  const flag = (o: Record<string, unknown>, at: string, key: string) => {
    if (o[key] !== undefined && typeof o[key] !== 'boolean') fail(`${at}.${key}`, 'type');
  };
  const id = (o: Record<string, unknown>, at: string): string | undefined => {
    if (typeof o.id === 'string' && o.id) return o.id;
    fail(`${at}.id`, 'type');
  };

  if (v.version !== 1) fail('version', 'version');
  for (const k of ['width', 'height']) {
    const x = num(v, '', k, 'any');
    if (x !== undefined && (!Number.isInteger(x) || x < 16 || x > 8192)) fail(k, 'frame-size');
  }
  const fps = num(v, '', 'fps', 'any');
  if (fps !== undefined && (fps < 1 || fps > 120)) fail('fps', 'fps');

  const kinds = new Map<string, unknown>(); // track id -> its kind ('video', 'audio', or whatever wrong value it has)
  if (!Array.isArray(v.tracks)) fail('tracks', 'type');
  else v.tracks.forEach((t: unknown, i) => {
    const at = `tracks[${i}]`;
    owner = {};
    if (!isObj(t)) return fail(at, 'type');
    const tid = id(t, at);
    owner = tid === undefined ? {} : { track: tid };
    if (tid !== undefined) {
      if (kinds.has(tid)) fail(`${at}.id`, 'duplicate');
      else kinds.set(tid, t.kind);
    }
    if (t.kind !== 'video' && t.kind !== 'audio') fail(`${at}.kind`, 'kind');
    if (t.name !== undefined && typeof t.name !== 'string') fail(`${at}.name`, 'type');
    num(t, at, 'gain', 'any', true);
    for (const k of ['mute', 'solo', 'hidden']) flag(t, at, k);
  });

  // the clips that can be placed, for the overlap check
  const placed: { i: number; id: string | undefined; track: string; start: number; end: number }[] = [];
  const clipIds = new Set<string>();
  if (!Array.isArray(v.clips)) fail('clips', 'type');
  else v.clips.forEach((c: unknown, i) => {
    const at = `clips[${i}]`;
    owner = {};
    if (!isObj(c)) return fail(at, 'type');
    const cid = id(c, at);
    owner = cid === undefined ? {} : { clip: cid };
    if (cid !== undefined) {
      if (clipIds.has(cid)) fail(`${at}.id`, 'duplicate');
      clipIds.add(cid);
    }
    let kind: unknown;
    if (typeof c.track !== 'string') fail(`${at}.track`, 'type');
    else if (!kinds.has(c.track)) fail(`${at}.track`, 'unknown-track');
    else kind = kinds.get(c.track);
    const src = typeof c.src === 'string' ? c.src : undefined;
    if (src === undefined || !src || isAbsPath(src) || src.includes('\\') || src.split('/').includes('..')) fail(`${at}.src`, 'src');
    const photo = src !== undefined && isPhotoSrc(src);
    const sound = src !== undefined && AUDIO.test(src);
    if (src && !photo && !sound && !VIDEO.test(src)) fail(`${at}.src`, 'src-kind');
    if (photo && !PHOTO.test(src)) fail(`${at}.src`, 'photo-kind');
    if (photo && kind === 'audio') fail(`${at}.track`, 'photo-audio');
    if (sound && kind === 'video') fail(`${at}.track`, 'audio-video');
    const start = num(c, at, 'at', 'min0');
    let len: number | undefined;
    if (photo) {
      if (c.in !== undefined) fail(`${at}.in`, 'photo-in-out');
      if (c.out !== undefined) fail(`${at}.out`, 'photo-in-out');
      if (c.dur === undefined) fail(`${at}.dur`, 'photo-no-dur');
      else len = num(c, at, 'dur', 'positive');
    } else {
      const from = num(c, at, 'in', 'min0', true);
      if (c.out === undefined) fail(`${at}.out`, 'media-no-out');
      else {
        const to = num(c, at, 'out', 'min0');
        // a bad `in` already has its issue: no length from it
        if (to !== undefined && (c.in === undefined || from !== undefined)) {
          if (to <= (from ?? 0)) fail(`${at}.out`, 'out-before-in');
          else len = to - (from ?? 0);
        }
      }
      if (c.dur !== undefined) fail(`${at}.dur`, 'media-dur');
    }
    num(c, at, 'gain', 'any', true);
    flag(c, at, 'mute');
    const fadeIn = num(c, at, 'fadeIn', 'min0', true);
    const fadeOut = num(c, at, 'fadeOut', 'min0', true);
    if (len !== undefined && (fadeIn ?? 0) + (fadeOut ?? 0) > len + EPS) fail(`${at}.${fadeOut !== undefined ? 'fadeOut' : 'fadeIn'}`, 'fade');
    if (c.place !== undefined) {
      const p = c.place;
      if (kind === 'audio') fail(`${at}.place`, 'place-audio');
      else if (!isObj(p)) fail(`${at}.place`, 'type');
      else {
        for (const k of ['x', 'y', 'w', 'h']) {
          const x = num(p, `${at}.place`, k, 'any');
          if (x !== undefined && (x < 0 || x > 1 || ((k === 'w' || k === 'h') && x === 0))) fail(`${at}.place.${k}`, 'place');
        }
        const o = num(p, `${at}.place`, 'opacity', 'any', true);
        if (o !== undefined && (o < 0 || o > 1)) fail(`${at}.place.opacity`, 'opacity');
      }
    }
    if (kind !== undefined && start !== undefined && len !== undefined) placed.push({ i, id: cid, track: c.track as string, start, end: start + len });
  });

  // overlap: on each track by start, a clip that starts before the previous one ends is named
  const byTrack = new Map<string, typeof placed>();
  for (const p of placed) byTrack.set(p.track, [...(byTrack.get(p.track) ?? []), p]);
  for (const [track, list] of byTrack) {
    list.sort((a, b) => a.start - b.start || a.i - b.i);
    let end = -Infinity;
    for (const p of list) {
      if (p.start < end - EPS) errors.push({ path: `clips[${p.i}].at`, code: 'overlap', ...(p.id !== undefined && { clip: p.id }), track });
      end = Math.max(end, p.end);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, cut: v as unknown as Cut };
}
