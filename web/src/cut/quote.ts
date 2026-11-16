// How a comment on an edit's timeline (issue 430) reads: in the batch the agent gets, on the card and in the popup.
import type { CutAnchor, CutAnchorClip } from '@nota-bene/shared';
import { isPhotoSrc } from '@nota-bene/shared/cut';
import { tIn, type Lang } from '@/i18n/index.ts';
import { mediaTime } from '@/media/markup/geometry.ts';

/** A track as the batch names it: its name with its id, or the id alone. */
export const trackLabel = (c: CutAnchorClip): string => (c.trackName ? `${c.trackName} (${c.track})` : c.track);

/** Where the comment is: the edit's file (`path @ ref` for another branch) and the time on its timeline. */
export const cutWhere = (a: CutAnchor, file: string, lang: Lang): string => tIn(lang, 'srcCut', file, mediaTime(a.time));

/**
 * What it is on: the clip, its track, its source and the same moment in that file (`in` + the offset into the clip), so
 * the agent can open the right second of it; a photo has no moment of its own. No clip: a moment of the timeline.
 */
export function cutQuote(a: CutAnchor, lang: Lang): string {
  const c = a.clip;
  if (!c) return tIn(lang, 'cutMomentQ');
  return isPhotoSrc(c.src) ? tIn(lang, 'cutClipPhotoQ', c.id, trackLabel(c), c.src) : tIn(lang, 'cutClipQ', c.id, trackLabel(c), c.src, mediaTime(c.srcTime));
}
