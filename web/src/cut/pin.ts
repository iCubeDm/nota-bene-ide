// Where a comment on an edit's timeline is pinned, and how it keeps to its clip (issue 430).
import type { CutAnchor, CutAnchorClip, FileSource } from '@nota-bene/shared';
import { clipLength, isPhotoSrc, type Cut, type CutClip } from '@nota-bene/shared/cut';

const ms = (t: number) => Math.round(t * 1000) / 1000;
/** Where a clip starts in its source: `in` (0 by default); a photo's own time starts at its showing. */
const from = (c: CutClip) => (isPhotoSrc(c.src) ? 0 : c.in ?? 0);

function clipOf(cut: Cut, c: CutClip, srcTime: number): CutAnchorClip {
  const name = cut.tracks.find((t) => t.id === c.track)?.name;
  return { id: c.id, track: c.track, ...(name ? { trackName: name } : {}), src: c.src, srcTime: ms(srcTime) };
}

/**
 * The anchor of a new comment: on the selected clip at the playhead when the playhead is on it, else at the clip's start;
 * with nothing selected, the playhead's moment of the timeline.
 */
export function pinAnchor(cut: Cut, source: FileSource, playhead: number, sel: string | null): CutAnchor {
  const c = sel === null ? undefined : cut.clips.find((x) => x.id === sel);
  if (!c) return { kind: 'cut', source, time: ms(playhead) };
  const on = playhead >= c.at && playhead < c.at + clipLength(c);
  const time = ms(on ? playhead : c.at);
  return { kind: 'cut', source, time, clip: clipOf(cut, c, from(c) + time - c.at) };
}

/**
 * Where a comment is on the timeline in `cut`: its clip's moment of the source (kept within the clip, whose ends a trim may
 * have moved past it); a moment of the timeline is where it is. undefined: its clip is no longer in the edit.
 */
export function timeOf(a: CutAnchor, cut: Cut): number | undefined {
  if (!a.clip) return a.time;
  const id = a.clip.id;
  const c = cut.clips.find((x) => x.id === id);
  if (!c) return undefined;
  return ms(Math.min(c.at + clipLength(c), Math.max(c.at, c.at + a.clip.srcTime - from(c))));
}

/**
 * The anchor after its clip moved, was trimmed or changed track: the time, the track and the src as `cut` has them, the
 * moment in the source kept. null when nothing changed, or when the clip is gone (the comment keeps its time).
 */
export function followAnchor(a: CutAnchor, cut: Cut): CutAnchor | null {
  if (!a.clip) return null;
  const id = a.clip.id;
  const c = cut.clips.find((x) => x.id === id);
  const time = timeOf(a, cut);
  if (!c || time === undefined) return null;
  const next: CutAnchor = { ...a, time, clip: clipOf(cut, c, a.clip.srcTime) };
  return JSON.stringify(next) === JSON.stringify(a) ? null : next;
}

/** The server that takes cut anchors (protocol 23); an older one would refuse the comment. */
export const CUT_PROTOCOL = 23;
