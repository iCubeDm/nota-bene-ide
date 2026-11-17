import { rangeRect } from '@/page/frame.ts';

/**
 * Centres a range in its pane's scroll element by the range's own rect. Scrolling an ancestor element into view
 * (the M1 way) lands in the middle of the file when the fragment's parent is a whole plain `<code>` block.
 */
export function scrollRangeIntoView(range: Range, scroller: HTMLElement, behavior: ScrollBehavior = 'smooth') {
  scrollRectIntoView(rangeRect(range), scroller, behavior);
}

/** Centres a box (this window's coordinates) in a scroll element. */
export function scrollRectIntoView(r: DOMRect, scroller: HTMLElement, behavior: ScrollBehavior = 'smooth') {
  const b = scroller.getBoundingClientRect();
  const top = scroller.scrollTop + r.top - b.top - scroller.clientHeight / 2 + r.height / 2;
  scroller.scrollTo({ top: Math.max(0, top), behavior });
}

/**
 * Brings a range into view sideways inside the boxes that scroll it horizontally between it and `root` (a wide table's
 * `.md-table`, issue 453), innermost first, centring it where it is cut off. Vertical scrolling stays with the caller.
 */
export function revealRangeSideways(range: Range, root: HTMLElement) {
  const start = range.startContainer;
  for (let e = start instanceof Element ? start : start.parentElement; e && e !== root && root.contains(e); e = e.parentElement) {
    if (e.scrollWidth <= e.clientWidth) continue;
    const ox = getComputedStyle(e).overflowX;
    if (ox !== 'auto' && ox !== 'scroll') continue;
    const r = rangeRect(range), b = e.getBoundingClientRect();
    if (r.left >= b.left && r.right <= b.right) continue;
    e.scrollLeft += r.left - b.left - e.clientWidth / 2 + r.width / 2;
  }
}
