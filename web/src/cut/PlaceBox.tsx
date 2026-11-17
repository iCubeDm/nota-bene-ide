import { useEffect, useRef, type PointerEvent } from 'react';
import type { Cut, CutClip, CutPlace } from '@nota-bene/shared/cut';
import { FULL, movePlace, resizePlace, setClip, type Corner } from './ops.ts';

const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];
const AT: Record<Corner, string> = { nw: 'left-0 top-0 cursor-nwse-resize', ne: 'right-0 top-0 cursor-nesw-resize', sw: 'left-0 bottom-0 cursor-nesw-resize', se: 'right-0 bottom-0 cursor-nwse-resize' };

/**
 * The selected video clip's frame over the preview (issue 409): dragged it moves, by a corner it resizes keeping its
 * proportions (Shift: free), always inside the output frame. Each move shows the result (`draft`), the release commits.
 */
export function PlaceBox({ cut, clip, draft, commit }: { cut: Cut; clip: CutClip; draft: (c: Cut | null) => void; commit: (c: Cut) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  // the edit as it is now: one that changed under the drag (the agent's version reloaded) ends it, nothing committed
  const now = useRef(cut);
  now.current = cut;
  const p = clip.place ?? FULL;

  const start = (e: PointerEvent<HTMLElement>, corner: Corner | null) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const frame = box.current?.parentElement?.getBoundingClientRect();
    if (!frame || frame.width <= 0 || frame.height <= 0) return;
    stop.current?.();
    const x0 = e.clientX, y0 = e.clientY;
    let out: Cut | null = null;
    const move = (m: { clientX: number; clientY: number; shiftKey: boolean }) => {
      if (now.current !== cut) return void stop.current?.();
      const dx = (m.clientX - x0) / frame.width, dy = (m.clientY - y0) / frame.height;
      const next: CutPlace = corner ? resizePlace(p, corner, dx, dy, !m.shiftKey) : movePlace(p, dx, dy);
      out = setClip(cut, clip.id, { place: next }) ?? out;
      if (out) draft(out);
    };
    const up = () => {
      stop.current?.();
      if (out && now.current === cut) commit(out);
      draft(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    stop.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      stop.current = null;
    };
  };

  return (
    <div
      ref={box} data-place-box onPointerDown={(e) => start(e, null)}
      className="absolute z-10 cursor-move touch-none outline-2 outline-primary outline-dashed"
      style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%` }}
    >
      {CORNERS.map((k) => (
        <span key={k} data-corner={k} onPointerDown={(e) => start(e, k)} className={`absolute size-3 rounded-sm border border-primary bg-background ${AT[k]}`} />
      ))}
    </div>
  );
}
