import { useEffect, useState } from 'react';
import { json, storage, useStored } from '@/sdk';

/** the preview's least height, px: its row's `min-h-24` */
const PREVIEW_MIN = 96;
/** the timeline's, px: its toolbar (32), ruler (24), add-track row (24) and one video lane (56) */
const TIMELINE_MIN = 136;
/** today's 3:2 */
const SHARE = 0.6;

const saved = storage.local('cut:preview:share', json((v): v is number => typeof v === 'number' && v > 0 && v < 1), SHARE);

/**
 * How the preview and the timeline share the height (issue 739): the preview's fraction of it, the same for every edit
 * and project, so it holds as the window or the pane is resized. `ref` goes on the preview's row, a sibling of the
 * timeline; `height` and `set` are the preview's in px for its PanelResizer, each side kept to its minimum.
 */
export function useSplit() {
  const share = useStored(saved);
  const [row, ref] = useState<HTMLElement | null>(null);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    if (!row || typeof ResizeObserver === 'undefined') return;
    const timeline = row.parentElement?.querySelector<HTMLElement>(':scope > [data-timeline]');
    const ro = new ResizeObserver(() => setTotal(row.offsetHeight + (timeline?.offsetHeight ?? 0)));
    ro.observe(row);
    if (timeline) ro.observe(timeline);
    return () => ro.disconnect();
  }, [row]);
  const clamp = (px: number) => Math.round(Math.max(PREVIEW_MIN, Math.min(px, total - TIMELINE_MIN)));
  const height = clamp(share * total);
  return {
    ref, height, min: PREVIEW_MIN,
    // flex-grow of the two; laid out unmeasured (a hidden tab), the stored share
    grow: total ? [height / total, (total - height) / total] : [share, 1 - share],
    set: (px: number) => { if (total) saved.set(clamp(px) / total); },
    reset: () => saved.remove(),
  };
}
