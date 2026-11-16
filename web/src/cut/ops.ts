// The editor's operations on an edit (issue 409) as pure functions: each takes a Cut and returns a new one (the given one
// is never changed), valid by validateCut when the given one was. One rule keeps a track free of overlaps: a clip that
// is moved, added or duplicated lands in the free place on its track nearest the time asked for (a gap that holds it, or
// after the last clip); a trim stops at the neighbour's edge, the source's ends and one frame of length.
import { AUDIO, clipLength, isPhotoSrc, PHOTO, validateCut, VIDEO, type Cut, type CutClip, type CutPlace, type CutTrack } from '@nota-bene/shared/cut';

// clips that touch do not overlap, whatever the float sums say (cutCheck.ts)
const EPS = 1e-6;
/** Times in the file are kept to the millisecond. */
export const ms = (x: number): number => Math.round(x * 1000) / 1000;
const end = (c: CutClip) => c.at + clipLength(c);
/** `x` to the millisecond when that stays within `lo..hi`; else `x` as it is (a neighbour's edge off the millisecond). */
const msWithin = (x: number, lo: number, hi: number): number => {
  const r = ms(x);
  return r >= lo - EPS && r <= hi + EPS ? r : x;
};
const frame = (cut: Cut) => 1 / cut.fps;
const trackOf = (cut: Cut, id: string) => cut.tracks.find((t) => t.id === id);
const others = (cut: Cut, track: string, except: readonly string[]) =>
  cut.clips.filter((c) => c.track === track && !except.includes(c.id)).sort((a, b) => a.at - b.at);
const withClip = (cut: Cut, id: string, f: (c: CutClip) => CutClip): Cut => ({ ...cut, clips: cut.clips.map((c) => (c.id === id ? f(c) : c)) });

/** A copy without the keys whose value is undefined (the file never says `"x": null` for "absent"). */
function compact<T extends object>(o: T): T {
  const out = { ...o };
  for (const k of Object.keys(out) as (keyof T)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** The first `<prefix><n>` not used by `used`. */
function freshId(prefix: string, used: Iterable<string>): string {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Whether a track of `kind` takes a clip of `src`: no sound file on a video track, no photo on an audio one. */
export function takes(kind: CutTrack['kind'], src: string): boolean {
  if (isPhotoSrc(src)) return kind === 'video' && PHOTO.test(src);
  if (AUDIO.test(src)) return kind === 'audio';
  return VIDEO.test(src);
}

/** Fades that fit the clip's length: the fade-in first, then what is left for the fade-out. */
function fitFades(c: CutClip): CutClip {
  const len = clipLength(c);
  const fadeIn = c.fadeIn === undefined ? undefined : ms(Math.min(c.fadeIn, len));
  const fadeOut = c.fadeOut === undefined ? undefined : ms(Math.min(c.fadeOut, len - (fadeIn ?? 0)));
  return compact({ ...c, fadeIn, fadeOut });
}

/**
 * The start nearest `at` where `len` seconds fit on `track` without overlapping its clips (`except` left out, the one
 * being moved): `at` itself when it fits, else the nearest edge of a gap that holds it. Never before 0.
 */
export function freeAt(cut: Cut, track: string, at: number, len: number, except: readonly string[] = []): number {
  const want = Math.max(0, at);
  let best = Infinity;
  let from = 0;
  const gaps: [number, number][] = [];
  for (const c of others(cut, track, except)) {
    gaps.push([from, c.at]);
    from = Math.max(from, end(c));
  }
  gaps.push([from, Infinity]);
  for (const [a, b] of gaps) {
    if (b - a < len - EPS) continue;
    const x = msWithin(Math.min(Math.max(want, a), b - len), a, b - len);
    if (Math.abs(x - want) < Math.abs(best - want)) best = x;
  }
  return best;
}

/** The clip at `at` (to the nearest free place), on `track` when given and of the same kind as its own; else unchanged. */
export function moveClip(cut: Cut, id: string, at: number, track?: string): Cut {
  const c = cut.clips.find((x) => x.id === id);
  if (!c) return cut;
  const to = track ?? c.track;
  if (to !== c.track && trackOf(cut, to)?.kind !== trackOf(cut, c.track)?.kind) return cut;
  return withClip(cut, id, (x) => ({ ...x, track: to, at: freeAt(cut, to, at, clipLength(c), [id]) }));
}

/** The clip `frames` frames later (earlier when negative). */
export function nudgeClip(cut: Cut, id: string, frames: number): Cut {
  const c = cut.clips.find((x) => x.id === id);
  return c ? moveClip(cut, id, c.at + frames * frame(cut)) : cut;
}

/**
 * The clip's start to `at`, its end where it was: a video or audio clip's `in` moves with it (not before the source's
 * start), a photo's `dur` changes. Not before the end of the clip before it, nor closer than a frame to its own end.
 */
export function trimStart(cut: Cut, id: string, at: number): Cut {
  const c = cut.clips.find((x) => x.id === id);
  if (!c) return cut;
  const e = end(c);
  const photo = isPhotoSrc(c.src);
  const prev = others(cut, c.track, [id]).filter((x) => x.at < c.at + EPS).reduce((m, x) => Math.max(m, end(x)), 0);
  const low = Math.min(c.at, Math.max(prev, photo ? 0 : c.at - (c.in ?? 0)));
  // a frame at least, unless the clip is shorter than that already: then it may only grow
  const high = Math.max(c.at, e - frame(cut));
  const t = msWithin(Math.min(high, Math.max(low, at)), low, high);
  if (photo) return withClip(cut, id, (x) => fitFades({ ...x, at: t, dur: msWithin(e - t, 0, e - t) }));
  // the end stays where it was: `in` moves by what `at` moved
  return withClip(cut, id, (x) => fitFades({ ...x, at: t, in: msWithin((x.in ?? 0) + t - x.at, (x.in ?? 0) + t - x.at, Infinity) }));
}

/**
 * The clip's end to `to`: a video or audio clip's `out` (within `srcLen`, the source's length when known), a photo's
 * `dur`. Not past the start of the next clip, nor closer than a frame to its own start.
 */
export function trimEnd(cut: Cut, id: string, to: number, srcLen?: number): Cut {
  const c = cut.clips.find((x) => x.id === id);
  if (!c) return cut;
  const photo = isPhotoSrc(c.src);
  const next = others(cut, c.track, [id]).filter((x) => x.at > c.at - EPS).reduce((m, x) => Math.min(m, x.at), Infinity);
  const high = Math.min(next, photo || srcLen === undefined ? Infinity : c.at + srcLen - (c.in ?? 0));
  // a frame at least, never into the next clip (a clip shorter than a frame before it may only shrink to what is there)
  const e = Math.min(next, Math.max(Math.min(c.at + frame(cut), end(c)), Math.min(high, to)));
  if (photo) return withClip(cut, id, (x) => fitFades({ ...x, dur: msWithin(e - x.at, 0, next - x.at) }));
  return withClip(cut, id, (x) => fitFades({ ...x, out: msWithin((x.in ?? 0) + e - x.at, 0, (x.in ?? 0) + next - x.at) }));
}

/**
 * Splits at `t` the clips `ids`, or with none given every clip under `t`: the left part keeps the id and the fade-in,
 * the right one gets a new id and the fade-out. A clip with less than a frame either side of `t` stays whole. `ids`
 * in the answer: the right parts.
 */
export function splitAt(cut: Cut, t: number, ids: readonly string[]): { cut: Cut; ids: string[] } {
  const at = ms(t);
  const f = frame(cut);
  const pick = cut.clips.filter((c) => (ids.length === 0 || ids.includes(c.id)) && at >= c.at + f - EPS && at <= end(c) - f + EPS);
  if (!pick.length) return { cut, ids: [] };
  const used = cut.clips.map((c) => c.id);
  const out: string[] = [];
  const clips = cut.clips.flatMap((c) => {
    if (!pick.includes(c)) return [c];
    const id = freshId('c', used);
    used.push(id);
    out.push(id);
    const cutAt = at - c.at;
    if (isPhotoSrc(c.src)) {
      const left = fitFades({ ...c, dur: ms(cutAt), fadeOut: undefined });
      return [left, fitFades({ ...c, id, at, dur: ms(clipLength(c) - cutAt), fadeIn: undefined })];
    }
    const mid = ms((c.in ?? 0) + cutAt);
    return [fitFades({ ...c, out: mid, fadeOut: undefined }), fitFades({ ...c, id, at, in: mid, fadeIn: undefined })];
  });
  return { cut: { ...cut, clips }, ids: out };
}

export const deleteClips = (cut: Cut, ids: readonly string[]): Cut => ({ ...cut, clips: cut.clips.filter((c) => !ids.includes(c.id)) });

/** A copy of the clip with a new id, in the first free place from its end on. */
export function duplicateClip(cut: Cut, id: string): { cut: Cut; id?: string } {
  const c = cut.clips.find((x) => x.id === id);
  if (!c) return { cut };
  const nid = freshId('c', cut.clips.map((x) => x.id));
  const len = clipLength(c);
  // the first gap after the clip that holds it: freeAt from its end, never earlier
  let at = end(c);
  for (const o of others(cut, c.track, [])) if (o.at < at + len - EPS && end(o) > at + EPS) at = end(o);
  const i = cut.clips.indexOf(c);
  const clips = [...cut.clips];
  clips.splice(i + 1, 0, { ...c, id: nid, at: ms(at) });
  return { cut: { ...cut, clips }, id: nid };
}

/**
 * A new clip of `src` (all of it: `len` seconds, a photo's `dur`) on `track` at the free place nearest `at`; null when the
 * track cannot take it (a sound on a video track, a photo on an audio one, a file the format does not read).
 */
export function addClip(cut: Cut, a: { track: string; src: string; at: number; len: number }): { cut: Cut; id: string } | null {
  const t = trackOf(cut, a.track);
  if (!t || !takes(t.kind, a.src) || !(a.len > 0)) return null;
  const id = freshId('c', cut.clips.map((c) => c.id));
  const len = ms(a.len);
  const at = freeAt(cut, a.track, a.at, len);
  const c: CutClip = isPhotoSrc(a.src) ? { id, track: a.track, src: a.src, at, dur: len } : { id, track: a.track, src: a.src, at, out: len };
  return { cut: { ...cut, clips: [...cut.clips, c] }, id };
}

/** The tracks of `kind` as the timeline draws them: the video ones from the top of the picture (the last in `tracks`) down, the audio ones in file order. */
const drawnOf = (cut: Cut, kind: CutTrack['kind']): CutTrack[] => {
  const same = cut.tracks.filter((x) => x.kind === kind);
  return kind === 'video' ? same.reverse() : same;
};
const overlaps = (a: CutClip, b: CutClip) => a.at < end(b) - EPS && end(a) > b.at + EPS;
/** `d` to the millisecond unless that takes it below `lo`: clips moved together all move by the one amount. */
const stepFrom = (d: number, lo: number) => (ms(d) >= lo - EPS ? ms(d) : d);
/**
 * `at` moved by `d`, to the millisecond when both are (issue 437): a clip off the millisecond, or a step that is, moves by
 * exactly `d`, so clips that touched still touch and none runs into the next.
 */
const shiftAt = (at: number, d: number) => (ms(at) === at && ms(d) === d ? ms(at + d) : at + d);

/**
 * A selection of clips moved together (issue 432): `dt` seconds later (the earliest stops at 0, the rest keep their distance),
 * and with `lanes` the clips of that kind `by` lanes down in the drawn order (up when negative), the others on their own
 * tracks. null when the move is refused: a clip would overlap one outside the selection, or a lane is not there.
 */
export function moveClips(cut: Cut, ids: readonly string[], dt: number, lanes?: { kind: CutTrack['kind']; by: number }): Cut | null {
  const group = cut.clips.filter((c) => ids.includes(c.id));
  if (!group.length) return null;
  const lo = -Math.min(...group.map((c) => c.at));
  const d = stepFrom(Math.max(dt, lo), lo);
  const moved = new Map<string, CutClip>();
  for (const c of group) {
    let track = c.track;
    const kind = trackOf(cut, c.track)?.kind;
    if (lanes && lanes.by !== 0 && kind === lanes.kind) {
      const order = drawnOf(cut, kind);
      const to = order[order.findIndex((x) => x.id === c.track) + lanes.by];
      if (!to) return null;
      track = to.id;
    }
    moved.set(c.id, { ...c, track, at: Math.max(0, shiftAt(c.at, d)) });
  }
  for (const m of moved.values()) {
    if (cut.clips.some((o) => !moved.has(o.id) && o.track === m.track && overlaps(m, o))) return null;
  }
  return { ...cut, clips: cut.clips.map((c) => moved.get(c.id) ?? c) };
}

/** The clip `id` and the clips after it on its track, in time order (issue 437); none when it is not there. */
export function trackForward(cut: Cut, id: string): string[] {
  const c = cut.clips.find((x) => x.id === id);
  if (!c) return [];
  return [c, ...others(cut, c.track, [id]).filter((x) => x.at > c.at - EPS)].map((x) => x.id);
}

/**
 * The clip `id` and every clip after it on its track `dt` seconds later (issue 437), their gaps kept, on their track:
 * earlier, not before the end of the clip before it, nor before 0. The other clips stay.
 */
export function moveForward(cut: Cut, id: string, dt: number): Cut {
  const c = cut.clips.find((x) => x.id === id);
  if (!c) return cut;
  const ids = trackForward(cut, id);
  const prev = others(cut, c.track, ids).reduce((m, x) => Math.max(m, end(x)), 0);
  const d = stepFrom(Math.max(dt, prev - c.at), prev - c.at);
  return { ...cut, clips: cut.clips.map((x) => (ids.includes(x.id) ? { ...x, at: Math.max(0, shiftAt(x.at, d)) } : x)) };
}

/**
 * The clip's end to `to` as trimEnd does it, the clips after it on its track moved by as much as the end did (issue 437):
 * the gap after it neither opens nor closes, so the next clip's start is no limit.
 */
export function rippleTrimEnd(cut: Cut, id: string, to: number, srcLen?: number): Cut {
  const c = cut.clips.find((x) => x.id === id);
  if (!c) return cut;
  const later = trackForward(cut, id).slice(1);
  const trimmed = trimEnd({ ...cut, clips: cut.clips.filter((x) => !later.includes(x.id)) }, id, to, srcLen);
  const d = end(trimmed.clips.find((x) => x.id === id)!) - end(c);
  const moved = new Map(trimmed.clips.map((x) => [x.id, x]));
  return { ...cut, clips: cut.clips.map((x) => moved.get(x.id) ?? { ...x, at: shiftAt(x.at, d) }) };
}

/** How far `to` is from `from` in the drawn order of their kind, for moveClips; null when they are of different kinds or not there. */
export function laneShift(cut: Cut, from: string, to: string): { kind: CutTrack['kind']; by: number } | null {
  const a = trackOf(cut, from), b = trackOf(cut, to);
  if (!a || !b || a.kind !== b.kind) return null;
  const order = drawnOf(cut, a.kind);
  return { kind: a.kind, by: order.indexOf(b) - order.indexOf(a) };
}

/**
 * Copies of the clips with new ids, keeping their tracks and their spacing (issue 432): from the end of the selection on,
 * later still while any copy would overlap a clip on its track. `ids` in the answer: the copies, in the order of `clips`.
 */
export function duplicateClips(cut: Cut, ids: readonly string[]): { cut: Cut; ids: string[] } {
  const group = cut.clips.filter((c) => ids.includes(c.id));
  if (!group.length) return { cut, ids: [] };
  const from = Math.min(...group.map((c) => c.at));
  let off = Math.max(...group.map(end)) - from;
  for (let busy = true; busy;) {
    busy = false;
    for (const c of group) {
      const copy = { ...c, at: c.at + off };
      for (const o of cut.clips) {
        if (o.track === c.track && overlaps(copy, o)) { off = end(o) - c.at; busy = true; }
      }
    }
  }
  const used = cut.clips.map((c) => c.id);
  const out: string[] = [];
  const clips = [...cut.clips];
  for (const c of group) {
    const id = freshId('c', used);
    used.push(id);
    out.push(id);
    clips.splice(clips.indexOf(c) + 1, 0, { ...c, id, at: ms(c.at + off) });
  }
  return { cut: { ...cut, clips }, ids: out };
}

/** A new empty track: `v<n>` or `a<n>`; a video one goes last in `tracks`, so over the picture of the others. */
export function addTrack(cut: Cut, kind: CutTrack['kind']): { cut: Cut; id: string } {
  const id = freshId(kind === 'video' ? 'v' : 'a', cut.tracks.map((t) => t.id));
  return { cut: { ...cut, tracks: [...cut.tracks, { id, kind }] }, id };
}

/** The track and its clips gone. */
export const removeTrack = (cut: Cut, id: string): Cut => ({
  ...cut, tracks: cut.tracks.filter((t) => t.id !== id), clips: cut.clips.filter((c) => c.track !== id),
});

/** A name for the track; an empty one removes it (the view says "Video 1" then). */
export function renameTrack(cut: Cut, id: string, name: string): Cut {
  const n = name.trim();
  return { ...cut, tracks: cut.tracks.map((t) => (t.id === id ? compact({ ...t, name: n || undefined }) : t)) };
}

/** Mute, solo or (a video track) hidden on or off: the file says only what is on. */
export function setTrackFlag(cut: Cut, id: string, key: 'mute' | 'solo' | 'hidden', on: boolean): Cut {
  const t = trackOf(cut, id);
  if (!t || (key === 'hidden' && t.kind !== 'video')) return cut;
  return { ...cut, tracks: cut.tracks.map((x) => (x.id === id ? compact({ ...x, [key]: on || undefined }) : x)) };
}

/** A gain as the timeline writes it (issue 410): a sign, at most one decimal, no trailing `.0`: `+3`, `−3.3`, `0`. */
export function fmtDb(g: number): string {
  const r = (Math.sign(g) * Math.round(Math.abs(g) * 10)) / 10 || 0;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}`;
}

/** A typed gain: a comma or a typographic minus (U+2212) taken as `.` and `-`; null when it is no number. */
export function parseDb(text: string): number | null {
  const s = text.trim().replace(/,/g, '.').replace(/\u2212/g, '-');
  const v = s === '' ? NaN : Number(s);
  return Number.isFinite(v) ? v : null;
}

/**
 * A track's gain (issue 410) at `db`, to the tenth and within the gain line's range (GAIN_MIN..GAIN_MAX): on an audio
 * track its clips, on a video track its clips' own sound. 0 dB is the default, left out of the file.
 */
export function setTrackGain(cut: Cut, id: string, db: number): Cut {
  if (!trackOf(cut, id) || !Number.isFinite(db)) return cut;
  const g = Math.round(within(db, GAIN_MIN, GAIN_MAX) * 10) / 10 || 0;
  return { ...cut, tracks: cut.tracks.map((x) => (x.id === id ? compact({ ...x, gain: g === 0 ? undefined : g }) : x)) };
}

/**
 * The track one place up (`-1`) or down (`1`) among the tracks of its kind as the timeline draws them: the video
 * tracks from the top of the picture (the last in `tracks`) down, then the audio tracks in file order.
 */
export function moveTrack(cut: Cut, id: string, dir: -1 | 1): Cut {
  const t = trackOf(cut, id);
  if (!t) return cut;
  const drawn = drawnOf(cut, t.kind);
  const i = drawn.indexOf(t);
  const j = i + dir;
  if (j < 0 || j >= drawn.length) return cut;
  [drawn[i], drawn[j]] = [drawn[j]!, drawn[i]!];
  const order = t.kind === 'video' ? drawn.reverse() : drawn;
  let k = 0;
  return { ...cut, tracks: cut.tracks.map((x) => (x.kind === t.kind ? order[k++]! : x)) };
}

/** The inspector's change to a clip (an undefined field is removed); null when the edit would not be valid. */
export function setClip(cut: Cut, id: string, patch: Partial<Omit<CutClip, 'id' | 'track' | 'src'>>): Cut | null {
  if (!cut.clips.some((c) => c.id === id)) return null;
  const next = withClip(cut, id, (c) => compact({ ...c, ...patch }));
  return validateCut(next).ok ? next : null;
}

/** The clip panel's change to several clips at once (issue 432); null when any would not be valid. */
export function setClips(cut: Cut, ids: readonly string[], patch: Partial<Omit<CutClip, 'id' | 'track' | 'src'>>): Cut | null {
  if (!cut.clips.some((c) => ids.includes(c.id))) return null;
  const next = { ...cut, clips: cut.clips.map((c) => (ids.includes(c.id) ? compact({ ...c, ...patch }) : c)) };
  return validateCut(next).ok ? next : null;
}

/** The gain line's range (issue 431), dB: the format takes any gain, a drag stays within these. */
export const GAIN_MIN = -60;
export const GAIN_MAX = 12;
const lin = (db: number) => 10 ** (db / 20);
// a fader's law: the square root of the amplitude against the top's, stretched so GAIN_MIN is the bottom; 0 dB sits about halfway
const ROOT_MIN = Math.sqrt(lin(GAIN_MIN) / lin(GAIN_MAX));

/** Where the gain line of a clip at `db` is drawn: a fraction of the clip's height from its top, 0..1. */
export function gainY(db: number): number {
  const r = Math.sqrt(lin(within(db, GAIN_MIN, GAIN_MAX)) / lin(GAIN_MAX));
  return within((1 - r) / (1 - ROOT_MIN), 0, 1);
}

/** The gain at a fraction `y` of the clip's height from its top: gainY's inverse. */
export function gainAtY(y: number): number {
  const r = 1 - within(y, 0, 1) * (1 - ROOT_MIN);
  return within(20 * Math.log10(lin(GAIN_MAX) * r * r), GAIN_MIN, GAIN_MAX);
}

/**
 * The gain after dragging the line `dy` px on a clip `h` px high from `db`: the line follows the pointer in 0.5 dB steps;
 * `fine` (Shift) moves it a tenth as far, in 0.1 dB steps. Within GAIN_MIN..GAIN_MAX.
 */
export function dragGain(db: number, dy: number, h: number, fine: boolean): number {
  const y = gainY(db) + (fine ? dy / 10 : dy) / Math.max(1, h);
  const step = fine ? 10 : 2;
  return within(Math.round(gainAtY(y) * step) / step, GAIN_MIN, GAIN_MAX) || 0;
}

/** The clip's sound at `db` (to the tenth, within the gain line's range); 0 dB is the default, left out of the file. */
export function setGain(cut: Cut, id: string, db: number): Cut {
  if (!cut.clips.some((c) => c.id === id)) return cut;
  const g = Math.round(within(db, GAIN_MIN, GAIN_MAX) * 10) / 10 || 0;
  return withClip(cut, id, (c) => compact({ ...c, gain: g === 0 ? undefined : g }));
}

/**
 * A fade of the clip (`in` from its start, `out` to its end) to `sec`, to the millisecond: never below 0 nor longer than
 * what the other fade leaves of the clip. 0 is no fade, left out of the file.
 */
export function setFade(cut: Cut, id: string, edge: 'in' | 'out', sec: number): Cut {
  const c = cut.clips.find((x) => x.id === id);
  if (!c) return cut;
  const other = (edge === 'in' ? c.fadeOut : c.fadeIn) ?? 0;
  const room = Math.max(0, clipLength(c) - other);
  // to the millisecond, and never past the room left (rounding up could)
  let v = ms(within(sec, 0, room));
  if (v > room + EPS) v = Math.floor(room * 1000) / 1000;
  return withClip(cut, id, (x) => compact({ ...x, [edge === 'in' ? 'fadeIn' : 'fadeOut']: v > 0 ? v : undefined }));
}

/** Where a moved or trimmed edge may snap: 0, the playhead and the edges of every clip but `except`, sorted. */
export function snapPoints(cut: Cut, playhead: number, except: readonly string[]): number[] {
  const pts = new Set<number>([0, ms(playhead)]);
  for (const c of cut.clips) if (!except.includes(c.id)) { pts.add(ms(c.at)); pts.add(ms(end(c))); }
  return [...pts].sort((a, b) => a - b);
}

/** `t` on the nearest of `points` within `tol` seconds, else `t`. */
export function snapTime(t: number, points: readonly number[], tol: number): number {
  let best = t;
  let d = Infinity;
  for (const p of points) if (Math.abs(p - t) <= tol && Math.abs(p - t) < d) { best = p; d = Math.abs(p - t); }
  return best;
}

/** A clip `len` long moved to `at`: its start or its end on the nearest point within `tol`, else `at`. */
export function snapMove(at: number, len: number, points: readonly number[], tol: number): number {
  let best = at;
  let d = Infinity;
  for (const p of points) {
    for (const x of [p, p - len]) if (Math.abs(x - at) <= tol && Math.abs(x - at) < d) { best = x; d = Math.abs(x - at); }
  }
  return ms(best);
}

/** The whole frame, a clip's place when it has none. */
export const FULL: CutPlace = { x: 0, y: 0, w: 1, h: 1 };
/** The smallest side of a place, a fraction of the frame. */
export const MIN_PLACE = 0.05;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const within = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The place moved by fractions of the frame, kept inside it. */
export function movePlace(p: CutPlace, dx: number, dy: number): CutPlace {
  return { ...p, x: r4(within(p.x + dx, 0, Math.max(0, 1 - p.w))), y: r4(within(p.y + dy, 0, Math.max(0, 1 - p.h))) };
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se';
/**
 * The place resized by dragging `corner` by fractions of the frame, the opposite corner fixed, kept inside the frame and
 * no side under MIN_PLACE; `keep`: the box keeps its proportions.
 */
export function resizePlace(p: CutPlace, corner: Corner, dx: number, dy: number, keep: boolean): CutPlace {
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';
  const ax = west ? p.x + p.w : p.x; // the fixed corner
  const ay = north ? p.y + p.h : p.y;
  const cx = within((west ? p.x : p.x + p.w) + dx, 0, 1);
  const cy = within((north ? p.y : p.y + p.h) + dy, 0, 1);
  const roomX = west ? ax : 1 - ax;
  const roomY = north ? ay : 1 - ay;
  let w = Math.max(MIN_PLACE, west ? ax - cx : cx - ax);
  let h = Math.max(MIN_PLACE, north ? ay - cy : cy - ay);
  if (keep) {
    const lo = Math.max(MIN_PLACE / p.w, MIN_PLACE / p.h);
    const s = within(Math.max(w / p.w, h / p.h), lo, Math.min(roomX / p.w, roomY / p.h));
    w = p.w * s;
    h = p.h * s;
  } else {
    w = Math.min(w, roomX);
    h = Math.min(h, roomY);
  }
  return { ...p, x: r4(west ? ax - w : ax), y: r4(north ? ay - h : ay), w: r4(w), h: r4(h) };
}
