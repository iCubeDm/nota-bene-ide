// The header's git branch sits over the middle column: its left edge on the first tab's, wherever the side panels put it
// (opened, closed, resized). A project block wider than that pushes it right, a gap after the block.
import { useLayoutEffect, useState, type RefObject } from 'react';

const GAP = 12;

/** The branch's left inside the header, from the page x of the header, the tab strip (null: not laid out) and the block's right. */
export function alignedLeft(o: { header: number; tabs: number | null; block: number }): number {
  const after = o.block + GAP;
  return (o.tabs === null ? after : Math.max(o.tabs, after)) - o.header;
}

/** `alignedLeft` kept current: on any size change of the header, the block or the middle column ([data-center]). */
export function useTabAligned(header: RefObject<HTMLElement | null>, block: RefObject<HTMLElement | null>): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const h = header.current, b = block.current;
    if (!h || !b) return;
    const center = document.querySelector<HTMLElement>('[data-center]');
    const measure = () => {
      const tabs = document.querySelector<HTMLElement>('[role="tablist"]');
      setLeft(alignedLeft({ header: h.getBoundingClientRect().left, tabs: tabs ? tabs.getBoundingClientRect().left : null, block: b.getBoundingClientRect().right }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    for (const el of [h, b, center]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [header, block]);
  return left;
}
