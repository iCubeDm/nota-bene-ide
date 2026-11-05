import type { PageAnchor } from '@nota-bene/shared';
import { tIn, type Lang } from '../i18n/index.ts';

/** The trail as one line: `h2 «Карта» › svg «Молекула долины» › g.node «Депо»`. */
export const trailLine = (a: PageAnchor): string => a.trail.join(' › ');

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
