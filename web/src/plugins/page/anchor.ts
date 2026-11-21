// Places on a rendered HTML page (PageAnchor): what an element is called, the path to it, and how it is found again.
// Pure DOM reads over the page's own document; no layout except where a function says so.

import { PAGE_LIST_MAX, PAGE_SELECTOR_MAX, PAGE_TEXT_MAX, type FileSource, type PageAnchor } from '@nota-bene/shared';

/** the longest name an element is described by */
const NAME_MAX = 60;
/** how many labelled ancestors a trail keeps above the element */
const TRAIL_UP = 5;
/** what an area lists when it covers nothing: this many nearest labelled shapes */
const NEAREST = 3;

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const tagOf = (el: Element): string => el.tagName.toLowerCase();
const inSvg = (el: Element): boolean => tagOf(el) !== 'svg' && !!el.closest('svg');

/** An SVG element's own `<title>` (a direct child): the tooltip a diagram gives each shape. */
function ownTitle(el: Element): string {
  for (const c of el.children) if (tagOf(c) === 'title') return c.textContent ?? '';
  return '';
}

/** What the element calls itself: its title, its aria-label, a `<text>`'s own text, a group's first text, or the start of its text. */
function nameOf(el: Element): string {
  const own = ownTitle(el) || el.getAttribute('aria-label') || el.getAttribute('title');
  if (own) return own;
  const tag = tagOf(el);
  if (tag === 'svg') return '';
  if (tag === 'g') return el.querySelector('text')?.textContent ?? '';
  return el.textContent ?? '';
}

/** How an element reads to a person and to the agent: `g.node «Депо»`, `h2 «Карта»`, `svg «Молекула долины»`. */
export function describe(el: Element): string {
  const tag = tagOf(el);
  const id = el.id ? `#${el.id}` : '';
  const cls = el.classList[0] ? `.${el.classList[0]}` : '';
  const name = clip(nameOf(el), NAME_MAX);
  return clip(`${tag}${id}${cls}${name ? ` «${name}»` : ''}`, PAGE_TEXT_MAX);
}

/** A trail entry above the element: an ancestor a reader would name (a diagram, a group, a landmark), not every wrapper. */
function labelled(el: Element): boolean {
  const tag = tagOf(el);
  return tag === 'svg' || !!el.id || !!ownTitle(el) || el.hasAttribute('aria-label') || (tag === 'g' && el.classList.length > 0)
    || tag === 'section' || tag === 'article' || tag === 'figure' || tag === 'table';
}

/** The last h1–h3 that comes before the element in the page: the part of the page it is in. */
function headingBefore(el: Element): Element | null {
  let hit: Element | null = null;
  for (const h of el.ownerDocument.querySelectorAll('h1, h2, h3')) {
    if (h === el || h.contains(el)) break;
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) hit = h;
    else break;
  }
  return hit;
}

/** How the element reads in its page, outermost first: the heading it is under, its named ancestors, itself. */
export function trailOf(el: Element): string[] {
  const up: string[] = [];
  const body = el.ownerDocument.body;
  for (let p = el.parentElement; p && p !== body && up.length < TRAIL_UP; p = p.parentElement) if (labelled(p)) up.unshift(describe(p));
  const h = headingBefore(el);
  return [...(h ? [describe(h)] : []), ...up, describe(el)].slice(-PAGE_LIST_MAX);
}

/** The element's path from `body` by child positions: what still finds it when nothing above it moved. */
export function selectorOf(el: Element): string {
  const steps: string[] = [];
  const body = el.ownerDocument.body;
  for (let e: Element = el; e !== body && e.parentElement; e = e.parentElement) {
    steps.unshift(`:nth-child(${[...e.parentElement.children].indexOf(e) + 1})`);
  }
  return ['body', ...steps].join('>');
}

/**
 * What a click on `el` means: in a diagram, the nearest shape that carries its own title, else its group, else the
 * shape; on the rest of the page the element itself. Nothing for the page's own root.
 */
export function pickTarget(el: Element): Element | null {
  const doc = el.ownerDocument;
  if (el === doc.documentElement || el === doc.body) return null;
  if (!inSvg(el)) return el;
  for (let e: Element | null = el; e && tagOf(e) !== 'svg'; e = e.parentElement) if (ownTitle(e)) return e;
  return el.closest('svg g') ?? el;
}

/** The anchor for an element of the page in the file `source`; null for one nested too deep to name by its path. */
export function elementAnchor(source: FileSource, el: Element): PageAnchor | null {
  const selector = selectorOf(el);
  return selector.length > PAGE_SELECTOR_MAX ? null : { kind: 'page', source, selector, trail: trailOf(el) };
}

/** The anchor for an area of `svg`: `box` in its user units, `near` what it covers (from layout, see nearOf). */
export function areaAnchor(source: FileSource, svg: Element, box: NonNullable<PageAnchor['box']>, near: string[]): PageAnchor | null {
  const r = (v: number) => Math.round(v * 10) / 10;
  const selector = selectorOf(svg);
  if (selector.length > PAGE_SELECTOR_MAX) return null;
  return {
    kind: 'page', source, selector, trail: trailOf(svg),
    box: { x: r(box.x), y: r(box.y), w: Math.max(0.1, r(box.w)), h: Math.max(0.1, r(box.h)) },
    ...(near.length ? { near: near.slice(0, PAGE_LIST_MAX) } : {}),
  };
}

/** The diagram's shapes a reader would name, outermost only: a group's titled circle is the group. */
function namedShapes(svg: Element): Element[] {
  const all = [...svg.querySelectorAll('*')].filter((e) => tagOf(e) !== 'title' && (ownTitle(e) || (tagOf(e) === 'g' && e.classList.length > 0 && nameOf(e))));
  return all.filter((e) => !all.some((o) => o !== e && o.contains(e)));
}

type Box = { left: number; top: number; right: number; bottom: number };

/** Layout: the named shapes an area (client coordinates of the page's own window) covers, most covered first; none covered, the nearest few. */
export function nearOf(svg: Element, area: Box): string[] {
  const shapes = namedShapes(svg).map((e) => ({ e, r: e.getBoundingClientRect() }));
  const overlap = (r: DOMRect) => Math.max(0, Math.min(r.right, area.right) - Math.max(r.left, area.left)) * Math.max(0, Math.min(r.bottom, area.bottom) - Math.max(r.top, area.top));
  const covered = shapes.map((s) => ({ ...s, o: overlap(s.r) })).filter((s) => s.o > 0).sort((a, b) => b.o - a.o);
  if (covered.length) return covered.slice(0, PAGE_LIST_MAX).map((s) => describe(s.e));
  const cx = (area.left + area.right) / 2, cy = (area.top + area.bottom) / 2;
  const dist = (r: DOMRect) => Math.hypot((r.left + r.right) / 2 - cx, (r.top + r.bottom) / 2 - cy);
  return shapes.sort((a, b) => dist(a.r) - dist(b.r)).slice(0, NEAREST).map((s) => describe(s.e));
}

function query(doc: Document, selector: string): Element | null {
  try {
    return doc.querySelector(selector);
  } catch {
    return null; // not a selector (an anchor from elsewhere)
  }
}

const sameTrail = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The element an anchor points at in the page as it is now: at its path if what is there still reads the same, else
 * the one element anywhere that reads the same (with the same trail when several do). null: it is gone or ambiguous.
 */
export function resolvePage(doc: Document, a: PageAnchor): Element | null {
  const want = a.trail[a.trail.length - 1];
  const at = query(doc, a.selector);
  if (at && describe(at) === want) return at;
  const same = [...doc.body.querySelectorAll('*')].filter((e) => describe(e) === want);
  if (same.length === 1) return same[0]!;
  const exact = same.filter((e) => sameTrail(trailOf(e), a.trail));
  return exact.length === 1 ? exact[0]! : null;
}

/** An area anchor's box in the page window's client coordinates, through the SVG's current transform; null without one. */
export function areaRect(svg: Element, box: NonNullable<PageAnchor['box']>): DOMRect | null {
  const g = svg as SVGGraphicsElement;
  const m = g.getScreenCTM?.();
  if (!m) return null;
  const p = (x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  const a = p(box.x, box.y), b = p(box.x + box.w, box.y + box.h);
  return new DOMRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
}

/** A client-coordinate rectangle of the page window in the SVG's user units (its viewBox); null without a transform. */
export function toUserBox(svg: Element, r: Box): NonNullable<PageAnchor['box']> | null {
  const m = (svg as SVGGraphicsElement).getScreenCTM?.()?.inverse();
  if (!m) return null;
  const p = (x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  const a = p(r.left, r.top), b = p(r.right, r.bottom);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
