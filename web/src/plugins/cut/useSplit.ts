import { useEffect, useState } from 'react';
import { json, storage, useStored } from '@/sdk';
import { LANES_MIN } from './Timeline.tsx';

/** the preview's least height, px: its row's `min-h-24` */
const PREVIEW_MIN = 96;
/** today's 3:2 */
const SHARE = 0.6;

const saved = storage.local('cut:preview:share', json((v): v is number => typeof v === 'number' && v > 0 && v < 1), SHARE);

/**
 * How the preview and the timeline share the height (issue 739): the preview's fraction of it, the same for every edit
 * and project, so it holds as the window or the pane is resized. `ref` goes on the preview's row, a sibling of the
 * timeline; `height`, `max` and `set` are the preview's in px for its PanelResizer. The layout keeps each side's minimum
 * (the timeline's: its toolbar, however many lines it wraps to, over LANES_MIN); this keeps the share within them.
 */
export function useSplit() {
  const share = useStored(saved);
  const [row, ref] = useState<HTMLElement | null>(null);
  // the two sides' height together, and the most the preview may take of it
  const [box, setBox] = useState({ total: 0, max: 0 });
  useEffect(() => {
    if (!row || typeof ResizeObserver === 'undefined') return;
    const timeline = row.parentElement?.querySelector<HTMLElement>(':scope > [data-timeline]');
    const bar = timeline?.querySelector<HTMLElement>(':scope > [data-timeline-bar]');
    const ro = new ResizeObserver(() => {
      const total = row.offsetHeight + (timeline?.offsetHeight ?? 0);
      const max = total - (bar?.offsetHeight ?? 0) - LANES_MIN;
      setBox((b) => (b.total === total && b.max === max ? b : { total, max }));
    });
    for (const el of [row, timeline, bar]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [row]);
  const { total, max } = box;
  const clamp = (px: number) => Math.round(Math.max(PREVIEW_MIN, Math.min(px, max)));
  const height = clamp(share * total);
  return {
    ref, height, min: PREVIEW_MIN, max: total ? max : undefined,
    // flex-grow of the two; laid out unmeasured (a hidden tab), the stored share
    grow: total ? [height / total, (total - height) / total] : [share, 1 - share],
    // a pane too short for both minimums keeps the share it has
    set: (px: number) => { if (max >= PREVIEW_MIN) saved.set(clamp(px) / total); },
    reset: () => saved.remove(),
  };
}
