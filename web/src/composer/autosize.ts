import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Height an auto-growing textarea wants. `scrollHeight` covers content and padding but not the border, while a
 * border-box height includes it: using the bare scrollHeight leaves the field a border short, so a one-line draft
 * showed a scrollbar.
 */
export function wantedHeight(content: number, border: number): number {
  return Math.ceil(content) + border;
}

/** The field scrolls only once the CSS max-height cut it below the height it wants. */
export function overflowFor(wanted: number, rendered: number): 'hidden' | 'auto' {
  return rendered < wanted ? 'auto' : 'hidden';
}

/** Resizes `el` to its text; `empty` keeps one line (a long placeholder would wrap and grow it). */
export function autosize(el: HTMLTextAreaElement, empty = false): void {
  el.style.height = 'auto';
  el.style.overflowY = 'hidden';
  if (empty) return;
  const border = el.offsetHeight - el.clientHeight; // the borders: no scrollbar is shown at this point
  const wanted = wantedHeight(el.scrollHeight, border);
  el.style.height = `${wanted}px`;
  el.style.overflowY = overflowFor(wanted, el.offsetHeight); // offsetHeight is already cut by max-height
}

/**
 * Keeps a textarea fitted: on every change of `text`, and when its width changes (panel/window resize, shell mode's
 * font and padding, zoom) or the window resizes (the 40vh cap moves). Our own height writes do not change the width,
 * so the observer cannot loop.
 */
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, text: string, empty = false): void {
  const emptyRef = useRef(empty);
  emptyRef.current = empty;
  useLayoutEffect(() => {
    if (ref.current) autosize(ref.current, empty);
  }, [ref, text, empty]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const refit = () => autosize(el, emptyRef.current);
    let width = el.offsetWidth;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (el.offsetWidth === width) return;
      width = el.offsetWidth;
      refit();
    });
    ro?.observe(el);
    window.addEventListener('resize', refit);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', refit);
    };
  }, [ref]);
}
