// How a comment's place reads, per kind of anchor (issue 511): in the batch the agent gets, on its card, in its popup and
// under the sent message. Pure, over the protocol's anchors: the batch is a contract the phone keeps too.
import { isAttachmentAnchor, isCutAnchor, isMediaAnchor, isPageAnchor, isTextAnchor, type Anchor, type CutAnchor, type CutAnchorClip, type MediaAnchor, type MediaShape, type PageAnchor } from '@nota-bene/shared';
import { isPhotoSrc } from '@nota-bene/shared/cut';
import { tIn, type Lang } from '../i18n/index.ts';

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** One line per shape for the batch, e.g. `rect x=0.42 y=0.4 w=0.16 h=0.24 (px 806,432 307×259)`. */
export function describeShape(s: MediaShape, natW: number, natH: number): string {
  const n = (v: number) => String(round4(v));
  const px = (v: number, nat: number) => Math.round(v * nat);
  switch (s.kind) {
    case 'rect':
      return `rect x=${n(s.x)} y=${n(s.y)} w=${n(s.w)} h=${n(s.h)} (px ${px(s.x, natW)},${px(s.y, natH)} ${px(s.w, natW)}×${px(s.h, natH)})`;
    case 'ellipse': {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2, rx = s.w / 2, ry = s.h / 2;
      return `ellipse cx=${n(cx)} cy=${n(cy)} rx=${n(rx)} ry=${n(ry)} (px ${px(cx, natW)},${px(cy, natH)} r ${px(rx, natW)}×${px(ry, natH)})`;
    }
    case 'arrow':
      return `arrow (${n(s.x1)},${n(s.y1)})→(${n(s.x2)},${n(s.y2)}) (px ${px(s.x1, natW)},${px(s.y1, natH)}→${px(s.x2, natW)},${px(s.y2, natH)})`;
    case 'pen': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < s.points.length; i += 2) {
        minX = Math.min(minX, s.points[i]); maxX = Math.max(maxX, s.points[i]);
        minY = Math.min(minY, s.points[i + 1]); maxY = Math.max(maxY, s.points[i + 1]);
      }
      const w = maxX - minX, h = maxY - minY;
      return `pen ${s.points.length / 2} pts, bbox x=${n(minX)} y=${n(minY)} w=${n(w)} h=${n(h)} (px ${px(minX, natW)},${px(minY, natH)} ${px(w, natW)}×${px(h, natH)})`;
    }
    case 'polygon': { // issue 447: every point, so the agent can rebuild the mask
      const pts: string[] = [];
      for (let i = 0; i + 1 < s.points.length; i += 2) pts.push(`${px(s.points[i], natW)},${px(s.points[i + 1], natH)}`);
      return `polygon ${s.points.length / 2} pts (px ${pts.join(' ')})`;
    }
  }
}

/** A video time as `m:ss.mmm` (what `ffmpeg -ss` takes), e.g. 4.24 → `0:04.240`. */
export function mediaTime(t: number): string {
  const ms = Math.round(t * 1000);
  const m = Math.floor(ms / 60000), rest = ms - m * 60000;
  return `${m}:${String(Math.floor(rest / 1000)).padStart(2, '0')}.${String(rest % 1000).padStart(3, '0')}`;
}

/** A media comment's line: the file's name, the paused time and [count] of its shapes; none for a comment on the whole picture (issue 494). */
export function mediaLine(a: MediaAnchor, count: (n: number) => string): string {
  const name = a.source.path.slice(a.source.path.lastIndexOf('/') + 1);
  return `${name}${a.time !== undefined ? ` @ ${mediaTime(a.time)}` : ''}${a.shapes.length ? ` · ${count(a.shapes.length)}` : ''}`;
}

// an edit's timeline (issue 430)

/** One line of a field: a break or a tab (which the server refuses anyway) never leaves the batch's quote. */
const flat = (s: string) => s.replace(/[\s\p{Cc}]+/gu, ' ');
/** A track as the batch names it: its name with its id, or the id alone. */
const trackLabel = (c: CutAnchorClip): string => flat(c.trackName ? `${c.trackName} (${c.track})` : c.track);

/** Where the comment is: the edit's file (`path @ ref` for another branch) and the time on its timeline. */
export const cutWhere = (a: CutAnchor, file: string, lang: Lang): string => tIn(lang, 'srcCut', file, mediaTime(a.time));

/**
 * What it is on: the clip, its track, its source and the same moment in that file (`in` + the offset into the clip), so
 * the agent can open the right second of it; a photo has no moment of its own. No clip: a moment of the timeline.
 */
export function cutQuote(a: CutAnchor, lang: Lang): string {
  const c = a.clip;
  if (!c) return tIn(lang, 'cutMomentQ');
  return isPhotoSrc(c.src) ? tIn(lang, 'cutClipPhotoQ', flat(c.id), trackLabel(c), flat(c.src)) : tIn(lang, 'cutClipQ', flat(c.id), trackLabel(c), flat(c.src), mediaTime(c.srcTime));
}

/** The comment in one line, for its card, its popup and the sent message: the time on the timeline, then what it is on. */
export const cutLine = (a: CutAnchor, lang: Lang): string => `${mediaTime(a.time)} · ${cutQuote(a, lang)}`;

// a rendered page

/** The trail as one line: `h2 «Карта» › svg «Молекула долины» › g.node «Депо»`. */
const trailLine = (a: PageAnchor): string => a.trail.join(' › ');

/** What a card, the popup and the sent message show: the element itself, or the diagram and the area's size. */
export function pageQuote(a: PageAnchor, lang: Lang): string {
  const self = a.trail[a.trail.length - 1] ?? '';
  return a.box ? `${self} · ${tIn(lang, 'pageArea', a.box.x, a.box.y, a.box.w, a.box.h)}` : self;
}

/** The quoted lines the agent gets: where it is in the page, the area and what it covers, and the element's path. */
export function pageLines(a: PageAnchor, lang: Lang): string[] {
  return [
    trailLine(a),
    ...(a.box ? [tIn(lang, 'pageArea', a.box.x, a.box.y, a.box.w, a.box.h)] : []),
    ...(a.near?.length ? [tIn(lang, 'pageNear', a.near)] : []),
    tIn(lang, 'pageElement', a.selector),
  ];
}

/** The comment's place in one line, for its card, its popup and the sent message ('' for a kind this client does not know). */
export function anchorLine(a: Anchor, lang: Lang): string {
  return isMediaAnchor(a) ? mediaLine(a, (n) => tIn(lang, 'markShapes', n))
    : isPageAnchor(a) ? pageQuote(a, lang)
    : isCutAnchor(a) ? cutLine(a, lang)
    : isAttachmentAnchor(a) ? tIn(lang, 'markShapes', a.shapes.length)
    : isTextAnchor(a) ? a.quote
    : '';
}

/** The quoted lines of a batch item, each `> `-prefixed; '' for a kind this client does not know (no quote). */
export function batchQuote(a: Anchor, lang: Lang): string {
  return isMediaAnchor(a) || isAttachmentAnchor(a) ? a.shapes.map((s) => '> ' + describeShape(s, a.width, a.height)).join('\n')
    : isPageAnchor(a) ? pageLines(a, lang).map((l) => '> ' + l).join('\n')
    : isCutAnchor(a) ? '> ' + cutQuote(a, lang)
    : isTextAnchor(a) ? a.quote.split('\n').map((l) => '> ' + l).join('\n')
    : '';
}
