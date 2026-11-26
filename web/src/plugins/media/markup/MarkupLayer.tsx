import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { MARK_COLORS, PEN_MAX_VALUES, POLYGON_MAX_POINTS, type MediaShape } from '@nota-bene/shared';
import { useT, useAppDispatch, useAppSelector, keysInScope, useFeature } from '@/sdk';
import { ConfirmDialog } from '@/sdk/ui';
import { box as rectBox, dense, hitPolygon, movePoints, rectFrom, setVertex, shapePath, shapesBounds, simplify, toRel } from './geometry.ts';
import { MarkupToolbar } from './MarkupToolbar.tsx';
import { HALO, HALO_PX, shapeEls, STROKE_PX, useNatSize, useOverlayPlacement, type Media } from './overlay.tsx';
import { addShape, clear, commitEdit, replaceShape, selectDraft, setColor, setMode, setTool, undo, type MarkTool } from './slice.ts';

type Pt = { x: number; y: number };

const TOOL_KEYS: Record<string, MarkTool> = { KeyR: 'rect', KeyE: 'ellipse', KeyP: 'pen', KeyA: 'arrow', KeyG: 'polygon' };
/** How near (client px) a press must be to a polygon's point to hit it: the first one closes, any one is dragged. */
const HIT_PX = 8;
/** The dots of a polygon's points (client px across): a round cap of a zero-length line, the same size at any zoom. */
const DOT_PX = 5;
/** A press this soon (ms) and this near (client px) after the one that added a point is a double-click's second press. */
const DBL_MS = 500;
const DBL_PX = 5;
/** A click this near (client px) to the last point adds none: a jitter. */
const JITTER_PX = 2;
/** The lasso (issue 729): a press that moves this far (client px) is a drag; its outline takes a point every STEP_PX. */
const DRAG_PX = 4;
const STEP_PX = 2;
/** SVG path of dots at the points (x, y pairs). */
const dotsPath = (pts: number[]): string => {
  let d = '';
  for (let i = 0; i + 1 < pts.length; i += 2) d += `M${pts[i]} ${pts[i + 1]}h0`;
  return d;
};


/** A finished drag as a shape, or null when it has no extent (a click with a box tool is not a drawing). */
function shapeOf(tool: MarkTool, color: MediaShape['color'], a: Pt, b: Pt, pen: number[]): MediaShape | null {
  if (tool === 'pen') {
    let pts = simplify(pen);
    if (pts.length === 2) pts = [pts[0], pts[1], pts[0], pts[1]]; // a tap is a dot: never lose a short stroke
    for (let eps = 0.003; pts.length > PEN_MAX_VALUES; eps *= 2) pts = simplify(pen, eps);
    return { kind: 'pen', color, points: pts };
  }
  if (tool === 'polygon') return null; // drawn point by point, never by a drag
  if (tool === 'arrow') return a.x === b.x && a.y === b.y ? null : { kind: 'arrow', color, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  const r = rectFrom(a, b);
  return r.w > 0 && r.h > 0 ? { kind: tool, color, ...r } : null;
}

/**
 * Markup mode of one media tab (an image, or a video paused on a frame): the toolbar in the tab's top-right corner and,
 * while on, an SVG over the media's content box where the shapes are drawn.
 *
 * Lag: the SVG is a child of the pane (the media's scroll container), so it scrolls with the media natively, with no
 * per-frame JS; its box follows resizes and the fit/natural toggle through a ResizeObserver. A drag touches no React
 * state: the live shape is one ref'd element whose attribute is set in place, the store gets the shape once, on
 * pointerup. Skew: coordinates come from `contentBox` of the media element's own rect (it has no border or padding), in
 * client px, so neither the zoom, the scroll nor the device pixel ratio enters them.
 */
/**
 * `onAdd(shapes, at)`: Comment was asked for; `at` is the client rect around the shapes, or the toolbar's when they are
 * scrolled out of sight (where the comment popup opens). `held`: the popup is open, so the mode's keys are off.
 * `saving`: the popup's Add is writing the drawing: no new shape, no Comment, no toolbar (the draft is what is saved).
 */
export function MarkupLayer({ tabId, media, fit, onAdd, held = false, saving = false }: {
  tabId: string; media: Media; fit: 'contain' | 'natural'; onAdd: (shapes: MediaShape[], at: DOMRect) => void; held?: boolean; saving?: boolean;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  const offered = useFeature('mediaAnchors');
  // polygons (issue 447): an older server would refuse the comment
  const mask = useFeature('polygons');
  const draft = useAppSelector((s) => selectDraft(s, tabId));
  const [asking, setAsking] = useState(false);
  const pane = media.parentElement;
  const svg = useRef<SVGSVGElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const live = useRef<SVGPathElement>(null);
  const liveHalo = useRef<SVGPathElement>(null);
  const livePen = useRef<SVGPolylineElement>(null);
  const livePenHalo = useRef<SVGPolylineElement>(null);
  const livePoly = useRef<SVGPathElement>(null);
  const livePolyHalo = useRef<SVGPathElement>(null);
  const livePolyDots = useRef<SVGPathElement>(null);
  const [nat, syncNat] = useNatSize(media);

  // once on, the mode stays through a reconnect (protocol is 0 until the next hello): a drawing never vanishes
  const on = draft.on;
  const box = useOverlayPlacement(svg, media, fit, on);

  // ---- drawing: refs only until pointerup ----
  // `box`: the content box at pointerdown (no layout read per move); a scroll during the drag refreshes it.
  // `tool`/`color`: fixed at pointerdown, so a key pressed mid-drag changes the next shape, not this one.
  // `ptsText`: the live pen's points as a string, kept only where SVGPointList is missing
  // `edit`: a press on a drawn polygon (issue 447): its index, the point dragged (null: the whole shape) and its points then
  type Drag = {
    id: number; a: Pt; b: Pt; pen: number[]; ptsText: string; box: DOMRect; tool: MarkTool; color: MediaShape['color'];
    edit?: { index: number; vertex: number | null; points: number[] };
  };
  const drag = useRef<Drag | null>(null);
  // the polygon being drawn (issue 447): its points so far, its colour, the content box when it began, the pointer's last place
  // `dots`: the points clicked (a lasso's outline has none). `last`: when and where (client px) the last point was clicked,
  // to tell a double-click's second press. `press`: the button is down (issue 729): its pointer, where its outline took its
  // last point (client px), whether the press began the polygon and whether it moved (a drag: a lasso)
  type Poly = {
    pts: number[]; dots: number[]; color: MediaShape['color']; box: DOMRect; at?: Pt; last?: { t: number; x: number; y: number };
    press?: { id: number; x: number; y: number; fresh: boolean; moved: boolean };
  };
  const poly = useRef<Poly | null>(null);
  const toolRef = useRef(draft);
  toolRef.current = draft;
  const relOf = (e: { clientX: number; clientY: number }, b: DOMRect) => toRel(e.clientX, e.clientY, b);
  // the live pen grows point by point through SVGPointList (O(1) per sample; rewriting `points` is O(n) per move, O(n²)
  // per stroke); without one (jsdom) the whole string is set
  const pens = () => [livePen.current, livePenHalo.current];
  const appendable = () => typeof svg.current?.createSVGPoint === 'function'
    && pens().every((el) => typeof el?.points?.appendItem === 'function');
  const appendPen = (d: Drag, pts: Pt[]) => {
    if (!appendable()) {
      for (const p of pts) d.ptsText += ` ${p.x},${p.y}`;
      for (const el of pens()) el?.setAttribute('points', d.ptsText);
      return;
    }
    for (const el of pens()) {
      for (const p of pts) {
        const sp = svg.current!.createSVGPoint(); // one per list: an item belongs to one list
        sp.x = p.x;
        sp.y = p.y;
        el!.points.appendItem(sp);
      }
    }
  };
  const showLive = (d: Drag) => { // a box tool or the arrow: one path, recomputed from the two ends
    const s = shapeOf(d.tool, d.color, d.a, d.b, d.pen);
    const path = s ? shapePath(s, nat[0], nat[1]) : '';
    live.current?.setAttribute('d', path);
    liveHalo.current?.setAttribute('d', path);
  };
  /** The polygon being drawn: its points, the line on to the pointer, and a dot at each point. */
  const showPoly = () => {
    const p = poly.current;
    let d = '';
    if (p) {
      for (let i = 0; i + 1 < p.pts.length; i += 2) d += `${i ? 'L' : 'M'}${p.pts[i]} ${p.pts[i + 1]}`;
      if (p.at && p.pts.length) d += `L${p.at.x} ${p.at.y}`;
      livePoly.current?.setAttribute('stroke', p.color);
      livePolyDots.current?.setAttribute('stroke', p.color);
    }
    livePoly.current?.setAttribute('d', d);
    livePolyHalo.current?.setAttribute('d', d);
    livePolyDots.current?.setAttribute('d', p ? dotsPath(p.dots) : '');
  };
  /** The polygon being drawn loses its last point (Backspace, Cmd/Ctrl+Z); none left: it is gone. */
  const popPoint = () => {
    const p = poly.current;
    if (!p) return;
    const [x, y] = p.pts.splice(-2, 2);
    if (p.dots.at(-2) === x && p.dots.at(-1) === y) p.dots.splice(-2, 2);
    p.last = undefined;
    if (!p.pts.length) poly.current = null;
    showPoly();
  };
  /** Undo: a point of the polygon being drawn, else the last step of the drawing (a shape, or a polygon's drag). */
  const undoStep = () => (poly.current ? popPoint() : void dispatch(undo(tabId)));
  /** The polygon being drawn becomes a shape, from 3 points; a long lasso's outline thinned to POLYGON_MAX_POINTS. */
  const closePoly = () => {
    const p = poly.current;
    if (!p || p.pts.length < 6) return;
    poly.current = null;
    showPoly();
    let points = p.pts;
    for (let eps = 0.001; points.length > 2 * POLYGON_MAX_POINTS; eps *= 2) points = simplify(p.pts, eps);
    dispatch(addShape(tabId, { kind: 'polygon', color: p.color, points }));
  };
  /**
   * Drops the shape in progress, if any (a drag of any tool, or a polygon being drawn), and clears its live elements.
   * The drawn shapes stay. Returns whether there was one. Also run when the mode goes off or the layer goes, so a
   * half-drawn shape (its start point) never outlives the mode: the svg that would get its pointerup is gone then.
   */
  const dropInProgress = useCallback((): boolean => {
    const had = !!drag.current || !!poly.current;
    const d = drag.current;
    drag.current = null;
    poly.current = null;
    if (d) {
      try { svg.current?.querySelector('rect')?.releasePointerCapture?.(d.id); } catch { /* not captured */ }
    }
    for (const el of [live.current, liveHalo.current, livePoly.current, livePolyHalo.current, livePolyDots.current]) el?.setAttribute('d', '');
    for (const el of [livePen.current, livePenHalo.current]) el?.setAttribute('points', '');
    return had;
  }, []);
  useLayoutEffect(() => {
    if (!on) return;
    syncNat();
    // focus off the toggle (gone now) or a text field, so R/E/P/A, Enter and Esc reach the mode at once
    svg.current?.focus({ preventScroll: true });
    const onScroll = () => {
      if (drag.current) drag.current.box = box();
      if (poly.current) poly.current.box = box();
    };
    pane?.addEventListener('scroll', onScroll, { passive: true });
    return () => pane?.removeEventListener('scroll', onScroll);
  }, [on, pane, box, syncNat]);
  // the mode went off (Esc, ✕, a clear) or the layer goes: no half-drawn shape comes back with it (the svg that would
  // have had its pointerup is gone, so nothing else ends it)
  useLayoutEffect(() => (on ? () => void dropInProgress() : undefined), [on, dropInProgress]);
  // another tool: a polygon being drawn is dropped (its points are not a shape yet)
  useEffect(() => {
    if (draft.tool !== 'polygon' && poly.current) dropInProgress();
  }, [draft.tool, dropInProgress]);
  const onPolyDown = (e: RPointerEvent<SVGSVGElement>, at: DOMRect, a: Pt, color: MediaShape['color']) => {
    const tolX = HIT_PX / Math.max(1, at.width), tolY = HIT_PX / Math.max(1, at.height);
    const near = (x: number, y: number) => Math.abs(x - a.x) <= tolX && Math.abs(y - a.y) <= tolY;
    const p = poly.current;
    const now = performance.now();
    const press = (fresh: boolean) => {
      (e.target as Element).setPointerCapture?.(e.pointerId); // a drag from here is a stretch of outline
      return { id: e.pointerId, x: e.clientX, y: e.clientY, fresh, moved: false };
    };
    if (p) {
      const n = p.pts.length / 2;
      if (near(p.pts[0], p.pts[1])) return n >= 3 ? closePoly() : undefined; // the first point closes, from 3 points
      // a double-click's second press (its dblclick closes the shape), even when the pointer moved a little
      const l = p.last;
      if (e.detail >= 2 || (l && now - l.t < DBL_MS && Math.hypot(e.clientX - l.x, e.clientY - l.y) <= DBL_PX)) return;
      const [lx, ly] = [p.pts[2 * n - 2] * at.width, p.pts[2 * n - 1] * at.height];
      if (Math.hypot(a.x * at.width - lx, a.y * at.height - ly) > JITTER_PX) { // a jitter adds no double point
        p.pts.push(a.x, a.y);
        p.dots.push(a.x, a.y);
        p.last = { t: now, x: e.clientX, y: e.clientY };
      }
      p.at = a;
      p.press = press(false);
      return showPoly();
    }
    // Alt: always a new polygon, also inside a drawn one (which a press would move)
    const hit = e.altKey ? null : hitPolygon(shapes, a, tolX, tolY);
    if (hit) { // a drawn polygon: drag its point, or move it
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const s = shapes[hit.index] as Extract<MediaShape, { kind: 'polygon' }>;
      drag.current = { id: e.pointerId, a, b: a, pen: [], ptsText: '', box: at, tool: 'polygon', color: s.color, edit: { index: hit.index, vertex: hit.vertex, points: s.points } };
      return;
    }
    poly.current = { pts: [a.x, a.y], dots: [a.x, a.y], color, box: at, last: { t: now, x: e.clientX, y: e.clientY }, press: press(true) };
    showPoly();
  };
  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || drag.current || saving) return;
    e.preventDefault(); // no text selection, no image drag
    svg.current?.focus({ preventScroll: true }); // the mode's keys work again after a click in the composer
    const { tool, color } = toolRef.current;
    if (tool === 'polygon') {
      const at = poly.current?.box ?? box();
      return onPolyDown(e, at, relOf(e, at), color);
    }
    (e.target as Element).setPointerCapture?.(e.pointerId); // the hit rect: the svg itself takes no pointer events
    const at = box();
    const a = relOf(e, at);
    const d: Drag = { id: e.pointerId, a, b: a, pen: [a.x, a.y], ptsText: `${a.x},${a.y}`, box: at, tool, color };
    drag.current = d;
    (tool === 'pen' ? livePen : live).current?.setAttribute('stroke', color);
    if (tool === 'pen') for (const el of pens()) el?.setAttribute('points', d.ptsText);
    else showLive(d);
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    const p = poly.current;
    if (!d && p) { // the line from the last point follows the pointer; with the button down, the outline does (a lasso)
      const q = p.press;
      if (q && e.pointerId === q.id) {
        const native = e.nativeEvent;
        for (const c of typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length ? native.getCoalescedEvents() : [native]) {
          if (Math.hypot(c.clientX - q.x, c.clientY - q.y) < (q.moved ? STEP_PX : DRAG_PX)) continue;
          q.moved = true;
          q.x = c.clientX;
          q.y = c.clientY;
          const r = relOf(c, p.box);
          p.pts.push(r.x, r.y);
        }
      }
      p.at = relOf(e, p.box);
      return showPoly();
    }
    if (!d || e.pointerId !== d.id) return;
    if (d.edit) { // a drawn polygon follows the pointer (a few points: the store takes each step)
      const r = relOf(e, d.box);
      const { index, vertex, points } = d.edit;
      const next = vertex === null ? movePoints(points, r.x - d.a.x, r.y - d.a.y) : setVertex(points, vertex, r.x, r.y);
      dispatch(replaceShape(tabId, index, { kind: 'polygon', color: d.color, points: next }));
      return;
    }
    // every input sample since the last frame, for a stroke as smooth as the pointer (pen only; a box needs the last)
    const native = e.nativeEvent;
    const samples = d.tool === 'pen' && typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const added: Pt[] = [];
    for (const p of samples.length ? samples : [native]) {
      const r = relOf(p, d.box);
      d.b = r;
      if (d.tool === 'pen') {
        d.pen.push(r.x, r.y);
        added.push(r);
      }
    }
    if (d.tool === 'pen') appendPen(d, added);
    else showLive(d);
  };
  const finish = (e: RPointerEvent<SVGSVGElement>) => {
    const p = poly.current;
    if (p?.press && e.pointerId === p.press.id) { // the button is up: a lasso begun by this press closes
      const { fresh, moved } = p.press;
      p.press = undefined;
      if (moved) p.last = undefined; // the next press is a click of its own, never a double-click's second
      if (moved && fresh) closePoly();
      return;
    }
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (d.edit) { // one drag, one undo step back to the points before it
      const s = shapes[d.edit.index];
      if (s?.kind === 'polygon' && s.points.some((v, i) => v !== d.edit!.points[i])) {
        dispatch(commitEdit(tabId, d.edit.index, { kind: 'polygon', color: d.color, points: d.edit.points }));
      }
      return;
    }
    if (e.type === 'pointerup') d.b = relOf(e, d.box);
    for (const el of [live.current, liveHalo.current]) el?.setAttribute('d', '');
    for (const el of [livePen.current, livePenHalo.current]) el?.setAttribute('points', '');
    const s = shapeOf(d.tool, d.color, d.a, d.b, d.pen);
    if (s) dispatch(addShape(tabId, s));
  };

  // ---- entering / leaving ----
  const enter = () => {
    if (media instanceof HTMLVideoElement && !media.paused) media.pause(); // one still frame
    dispatch(setMode(tabId, true));
  };
  const shapes = draft.shapes;
  const leave = useCallback(() => (shapes.length ? setAsking(true) : void dispatch(setMode(tabId, false))), [shapes, dispatch, tabId]);
  const comment = useCallback(() => {
    if (!shapes.length || saving) return;
    const b = box();
    const s = shapesBounds(shapes);
    const at = rectBox(b.x + s.x * b.width, b.y + s.y * b.height, s.w * b.width, s.h * b.height);
    // visible = inside the pane's box and the window
    const v = pane?.getBoundingClientRect();
    const seen = at.right >= Math.max(0, v?.left ?? 0) && at.left <= Math.min(window.innerWidth, v?.right ?? Infinity)
      && at.bottom >= Math.max(0, v?.top ?? 0) && at.top <= Math.min(window.innerHeight, v?.bottom ?? Infinity);
    // the toolbar itself, not its pane-wide wrapper
    const bar = toolbar.current?.firstElementChild;
    onAdd(shapes, seen || !bar ? at : bar.getBoundingClientRect());
  }, [shapes, onAdd, box, pane, saving]);

  // ---- keys: only while on, in the visible tab, with focus on nothing (body) or in this tab's pane or toolbar; never in
  // a text field. Focus in the feed keeps Esc for the agent and Enter for a link. Capture + preventDefault (Esc protocol).
  useEffect(() => {
    if (!on || asking || held || saving) return;
    const onKey = (e: KeyboardEvent) => {
      if (!keysInScope(e, media, (f) => !!pane?.contains(f) || !!toolbar.current?.contains(f))) return;
      const mod = e.metaKey || e.ctrlKey;
      // e.code, not e.key: R/E/P/A and the digits work on any keyboard layout
      if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyZ') {
        e.preventDefault();
        undoStep();
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!dropInProgress()) leave(); // a shape in progress goes alone, with no question; else the mode is left
      } else if (e.key === 'Enter' && poly.current) {
        e.preventDefault();
        closePoly(); // fewer than 3 points: nothing yet
      } else if (e.key === 'Backspace' && poly.current) {
        e.preventDefault();
        popPoint();
      } else if (e.key === 'Enter') {
        if ((e.target as Element | null)?.closest?.('button') || !shapes.length) return; // a focused button takes its own Enter
        e.preventDefault();
        comment();
      } else if (!e.shiftKey && TOOL_KEYS[e.code] && (mask || TOOL_KEYS[e.code] !== 'polygon')) {
        e.preventDefault();
        dispatch(setTool(tabId, TOOL_KEYS[e.code]));
      } else if (!e.shiftKey && /^(Digit|Numpad)[1-5]$/.test(e.code)) {
        e.preventDefault();
        dispatch(setColor(tabId, MARK_COLORS[Number(e.code.slice(-1)) - 1]));
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [on, asking, held, saving, media, dispatch, tabId, leave, comment, shapes, mask, dropInProgress]);

  const drawn = useMemo(() => shapeEls(shapes, nat[0], nat[1]), [shapes, nat]);
  // with the Mask tool, the drawn polygons' points show as dots: they can be dragged (not a lasso's: too dense to grab)
  const handles = useMemo(() => {
    if (draft.tool !== 'polygon') return [];
    const at = box();
    const tolX = HIT_PX / Math.max(1, at.width), tolY = HIT_PX / Math.max(1, at.height);
    return shapes.flatMap((s, i) => (s.kind !== 'polygon' || dense(s.points, tolX, tolY) ? [] : [
      <path key={i} data-handles d={dotsPath(s.points)} stroke={s.color} strokeWidth={DOT_PX} vectorEffect="non-scaling-stroke" />,
    ]));
  }, [shapes, draft.tool, box]);

  if (!offered && !on) return null;
  return (
    <>
      {/* spans the pane (left-3 too): a narrow pane wraps the toolbar's rows instead of pushing it off the left edge */}
      <div ref={toolbar} data-anchor-skip className="pointer-events-none absolute top-2 right-3 left-3 z-20 flex justify-end">
        <MarkupToolbar
          draft={draft}
          disabled={saving}
          mask={mask}
          onEnter={enter}
          onTool={(tool) => dispatch(setTool(tabId, tool))}
          onColor={(c) => dispatch(setColor(tabId, c))}
          onUndo={undoStep}
          onComment={comment}
          onLeave={leave}
        />
      </div>
      {on && pane && createPortal(
        <svg
          ref={svg}
          data-markup-layer
          tabIndex={-1}
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          fill="none"
          strokeWidth={STROKE_PX}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute z-10 cursor-crosshair touch-none overflow-visible outline-none select-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
          onDoubleClick={closePoly}
        >
          {/* the hit area: the svg itself takes no pointer events; while marking the player bar is gone */}
          <rect x="0" y="0" width="1" height="1" fill="transparent" stroke="none" className="pointer-events-auto" />
          {drawn}
          <path ref={liveHalo} d="" stroke={HALO} strokeWidth={HALO_PX} vectorEffect="non-scaling-stroke" />
          <path ref={live} data-live d="" vectorEffect="non-scaling-stroke" />
          <polyline ref={livePenHalo} points="" stroke={HALO} strokeWidth={HALO_PX} vectorEffect="non-scaling-stroke" />
          <polyline ref={livePen} data-live points="" vectorEffect="non-scaling-stroke" />
          {handles}
          <path ref={livePolyHalo} d="" stroke={HALO} strokeWidth={HALO_PX} vectorEffect="non-scaling-stroke" />
          <path ref={livePoly} data-live data-live-poly d="" vectorEffect="non-scaling-stroke" />
          <path ref={livePolyDots} data-live data-live-dots d="" strokeWidth={DOT_PX} vectorEffect="non-scaling-stroke" />
        </svg>,
        pane,
      )}
      {asking && (
        <ConfirmDialog
          title={t('markDiscardTitle')}
          body={t('markDiscardBody', shapes.length)}
          confirm={t('markDiscard')}
          onConfirm={() => { setAsking(false); dispatch(clear(tabId)); }}
          onCancel={() => setAsking(false)}
        />
      )}
    </>
  );
}

