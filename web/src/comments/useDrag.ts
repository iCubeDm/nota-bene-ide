import { useRef, type PointerEvent, type MouseEvent, type RefObject } from 'react';

export type Pos = { left: number; top: number };

const MARGIN = 8;

/** Dragging a fixed window by a handle. `place(auto, key)` turns the anchored position into the shown one: once the user has
 * moved the window it stays where they put it (only clamped), until `key` changes (a new anchor places it next to it again). */
export function useDrag(root: RefObject<HTMLElement | null>, setPos: (p: Pos) => void) {
  const moved = useRef<Pos | null>(null);
  const shown = useRef<Pos | null>(null);
  const keyed = useRef<unknown>(undefined);
  const grab = useRef<{ id: number; x: number; y: number; from: Pos } | null>(null);

  const clamp = (p: Pos): Pos => {
    const { offsetWidth: w = 0, offsetHeight: h = 0 } = root.current ?? {};
    return {
      left: Math.max(MARGIN, Math.min(p.left, window.innerWidth - w - MARGIN)),
      top: Math.max(MARGIN, Math.min(p.top, window.innerHeight - h - MARGIN)),
    };
  };
  const place = (auto: Pos, key: unknown): Pos => {
    if (keyed.current !== key) { keyed.current = key; moved.current = null; }
    const p = moved.current ? clamp(moved.current) : auto;
    shown.current = p;
    return p;
  };

  const handle = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !e.isPrimary || !shown.current) return;
      // the controls inside the handle keep their own clicks
      if ((e.target as Element).closest?.('button, input, textarea, select, a, [contenteditable]')) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      grab.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: shown.current };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = grab.current;
      if (!g || g.id !== e.pointerId) return;
      const p = clamp({ left: g.from.left + e.clientX - g.x, top: g.from.top + e.clientY - g.y });
      moved.current = shown.current = p;
      setPos(p);
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      if (grab.current?.id !== e.pointerId) return;
      grab.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    },
    onPointerCancel: (e: PointerEvent<HTMLElement>) => {
      if (grab.current?.id !== e.pointerId) return;
      grab.current = null;
    },
    // no text selection and no focus change (the textarea keeps its caret) while grabbing the handle
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      if (e.button === 0 && !(e.target as Element).closest?.('button, input, textarea, select, a, [contenteditable]')) e.preventDefault();
    },
    className: 'cursor-move touch-none select-none',
  };
  return { place, handle };
}
