// Files from the Files tree into an edit (issue 426): "Add to edit" appends them to an open edit, "New edit from selection"
// lays them out in a new one. Pure: the lengths come from the caller (durations.ts), the clips from ops.ts.
import { AUDIO, clipLength, PHOTO, VIDEO, type Cut, type CutTrack } from '@nota-bene/shared/cut';
import { addClip, addTrack, takes } from './ops.ts';

/** A file to add, and how long its clip is (a photo's duration, a video's or sound's whole length), seconds. */
export type MediaItem = { src: string; len: number };

/** A new edit's frame: Full HD at 30 frames a second, the size most cameras and phones record. */
export const NEW_CUT: Cut = { version: 1, width: 1920, height: 1080, fps: 30, tracks: [], clips: [] };

/** A file an edit takes as a clip, by its extension: a video, a sound or a photo (not a gif or svg). */
export const isEditMedia = (p: string): boolean => VIDEO.test(p) || AUDIO.test(p) || PHOTO.test(p);

/** The kind of track a file goes on: a sound on an audio track, a video or a photo on a video one. */
export const kindOf = (src: string): CutTrack['kind'] => (AUDIO.test(src) ? 'audio' : 'video');

/**
 * `items` in their order, each after the last clip of the first track of its kind (a video or photo on the first video
 * track, the lowest in the picture; a sound on the first audio track), a track of that kind added when there is none.
 * `skipped`: the files no track takes (a gif, a text file) or without a length. Null when nothing was added.
 */
export function appendMedia(cut: Cut, items: readonly MediaItem[]): { cut: Cut; ids: string[]; skipped: string[] } | null {
  let next = cut;
  const ids: string[] = [];
  const skipped: string[] = [];
  for (const it of items) {
    const kind = kindOf(it.src);
    if (!takes(kind, it.src) || !(it.len > 0)) {
      skipped.push(it.src);
      continue;
    }
    let track = next.tracks.find((t) => t.kind === kind)?.id;
    if (track === undefined) {
      const r = addTrack(next, kind);
      next = r.cut;
      track = r.id;
    }
    const at = next.clips.filter((c) => c.track === track).reduce((m, c) => Math.max(m, c.at + clipLength(c)), 0);
    const r = addClip(next, { track, src: it.src, at, len: it.len });
    if (!r) {
      skipped.push(it.src);
      continue;
    }
    next = r.cut;
    ids.push(r.id);
  }
  return ids.length ? { cut: next, ids, skipped } : null;
}

/** A new edit (NEW_CUT's frame) of `items` back to back from 0 in their order, a video track and an audio track as needed. */
export function newCutOf(items: readonly MediaItem[]): { cut: Cut; skipped: string[] } | null {
  const r = appendMedia(NEW_CUT, items);
  return r && { cut: r.cut, skipped: r.skipped };
}
