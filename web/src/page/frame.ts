import { useSyncExternalStore } from 'react';

// A rendered HTML page lives in its own document (HtmlBody's frame). The comment machinery works in this window's
// coordinates and DOM; these helpers carry what it reads across the frame's edge.

/** The server protocol from which a comment may point at a page element or area (PageAnchor). */
export const PAGE_PROTOCOL = 13;

/** The frame HtmlBody renders a page into. */
export const PAGE_FRAME = 'iframe[data-page-frame]';

/** The frame element holding `n`, when `n` is in a page frame's document; null for this window's own nodes. */
export function frameOf(n: Node): HTMLIFrameElement | null {
  const w = n.ownerDocument?.defaultView;
  return w && w !== window ? ((w.frameElement as HTMLIFrameElement | null) ?? null) : null;
}

/** How far the page's own client coordinates sit from this window's: the frame's content box corner. */
export function shiftOf(n: Node): { x: number; y: number } {
  const f = frameOf(n);
  if (!f) return { x: 0, y: 0 };
  const r = f.getBoundingClientRect();
  return { x: r.left + f.clientLeft, y: r.top + f.clientTop };
}

/** A rect of the page's window in this window's coordinates. */
export function outOf(n: Node, r: DOMRect): DOMRect {
  const s = shiftOf(n);
  return s.x === 0 && s.y === 0 ? r : new DOMRect(r.x + s.x, r.y + s.y, r.width, r.height);
}

/** A range's line boxes in this window's coordinates, wherever its text lives. */
export const rangeRects = (range: Range): DOMRect[] => [...range.getClientRects()].map((r) => outOf(range.startContainer, r));

/** A range's bounding box in this window's coordinates. */
export const rangeRect = (range: Range): DOMRect => outOf(range.startContainer, range.getBoundingClientRect());

/** The page's body in a pane, once HtmlBody has marked it as the text root; null while the pane shows no page. */
export function pageRoot(pane: Element): HTMLElement | null {
  const body = pane.querySelector<HTMLIFrameElement>(PAGE_FRAME)?.contentDocument?.body;
  return body?.hasAttribute('data-page-root') ? body : null;
}

/** The element a file pane's text lives in: the page's body for a rendered page, else the pane itself. */
export const textRootOf = (pane: HTMLElement): HTMLElement => pageRoot(pane) ?? pane;

/** The text selected in a page shown in `pane`, if any (this window's selection never reaches into a frame). */
export function pageSelection(pane: Element): Selection | null {
  const f = pane.querySelector<HTMLIFrameElement>(PAGE_FRAME);
  const sel = f?.contentWindow?.getSelection() ?? null;
  return sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel : null;
}

/** Drops the selection in every shown page (after a comment is made from one, as with this window's own). */
export function clearPageSelections(): void {
  for (const f of document.querySelectorAll<HTMLIFrameElement>(PAGE_FRAME)) f.contentWindow?.getSelection()?.removeAllRanges();
}

// A page renders after its text has loaded (the frame loads it on its own): what reads the page DOM from outside
// (a card judging its orphan) waits for this count to move. Module state: the frame and its readers are far apart.
let gen = 0;
const genListeners = new Set<() => void>();
/** HtmlBody: a page has finished rendering (first load or a reload). */
export function pageRendered(): void {
  gen++;
  for (const fn of genListeners) fn();
}
const subscribeGen = (fn: () => void): (() => void) => {
  genListeners.add(fn);
  return () => void genListeners.delete(fn);
};
/** A number that moves each time any page finishes rendering. */
export const usePageGen = (): number => useSyncExternalStore(subscribeGen, () => gen);
