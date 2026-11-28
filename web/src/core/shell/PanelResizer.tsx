import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '@/core/i18n/index.ts';
import { storage, string } from '@/sdk/storage.ts';

const STEP = 16;
/** a panel never takes more than this share of the window, so the middle column keeps room */
const MAX_SHARE = 0.45;

const clampTo = (w: number, min: number) => Math.round(Math.max(min, Math.min(w, Math.max(min, window.innerWidth * MAX_SHARE))));

const saved = (key: string) => storage.local(key, string, '');

function readWidth(key: string, initial: number, min: number): number {
  const v = Number(saved(key).get());
  return Number.isFinite(v) && v > 0 ? clampTo(v, min) : initial;
}

/**
 * A docked panel's width: dragged or set with the keyboard, persisted under `key` (one width for every project). The
 * panels also cap it at 45vw in CSS, for a window made narrower after the width was set.
 */
export function usePanelWidth(key: string, initial: number, min: number) {
  const [width, setWidth] = useState(() => readWidth(key, initial, min));
  const set = useCallback((w: number) => {
    const next = clampTo(w, min);
    setWidth(next);
    saved(key).set(String(next));
  }, [key, min]);
  const reset = useCallback(() => {
    setWidth(initial);
    saved(key).remove();
  }, [key, initial]);
  return { width, set, reset };
}

const PLACE = {
  right: 'inset-y-0 -right-[3px] w-1.5 cursor-col-resize',
  left: 'inset-y-0 -left-[3px] w-1.5 cursor-col-resize',
  bottom: 'inset-x-0 -bottom-[3px] h-1.5 cursor-row-resize',
};
const KEYS = { right: ['ArrowRight', 'ArrowLeft'], left: ['ArrowLeft', 'ArrowRight'], bottom: ['ArrowDown', 'ArrowUp'] } as const;

/**
 * The drag edge of a docked panel (IntelliJ: drag the border). `edge`: which side of the panel it sits on, so dragging
 * towards the middle column widens the panel. Arrows step 16 px; double-click or Home restores the default width. A
 * `bottom` edge sets a height instead (the video editor's preview over its timeline): `width` is then that height.
 */
export function PanelResizer({ edge, width, onWidth, onReset, min, label }: {
  edge: 'left' | 'right' | 'bottom'; width: number; onWidth: (w: number) => void; onReset: () => void; min: number; label: string;
}) {
  const t = useT();
  const drag = useRef<{ at: number; w: number } | null>(null);
  const sign = edge === 'left' ? -1 : 1;
  const across = edge === 'bottom';
  const at = (e: PointerEvent) => (across ? e.clientY : e.clientX);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { at: at(e), w: width };
    document.body.style.cursor = across ? 'row-resize' : 'col-resize';
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onWidth(drag.current.w + sign * (at(e) - drag.current.at));
  };
  const end = () => {
    drag.current = null;
    document.body.style.cursor = '';
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const [grow, shrink] = KEYS[edge];
    if (e.key === grow) onWidth(width + STEP);
    else if (e.key === shrink) onWidth(width - STEP);
    else if (e.key === 'Home') onReset();
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation={across ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      tabIndex={0}
      title={t('resizeTip')}
      data-resizer={edge}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={`absolute z-[6] touch-none outline-none hover:bg-primary/40 focus-visible:bg-primary/60 ${PLACE[edge]}`}
    />
  );
}
