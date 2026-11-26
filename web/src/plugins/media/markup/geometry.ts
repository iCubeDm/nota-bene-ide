import { POLYGON_MAX_POINTS, type MediaShape } from '@nota-bene/shared';

export const round4 = (v: number): number => Math.round(v * 10000) / 10000;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** A DOMRect-shaped plain object (jsdom has no DOMRect constructor). */
export function box(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() { return this; } } as DOMRect;
}

/** The rendered media's content box in client px: object-fit: contain inside `el`'s box, or the element box at natural size. */
export function contentBox(elRect: DOMRect, natW: number, natH: number, fit: 'contain' | 'natural'): DOMRect {
  if (fit === 'natural' || natW <= 0 || natH <= 0) return box(elRect.x, elRect.y, elRect.width, elRect.height);
  const scale = Math.min(elRect.width / natW, elRect.height / natH);
  const w = natW * scale;
  const h = natH * scale;
  return box(elRect.x + (elRect.width - w) / 2, elRect.y + (elRect.height - h) / 2, w, h);
}

/** Pointer → relative [0,1]², clamped, 4 decimals. */
export function toRel(clientX: number, clientY: number, b: DOMRect): { x: number; y: number } {
  return {
    x: b.width > 0 ? round4(clamp01((clientX - b.x) / b.width)) : 0,
    y: b.height > 0 ? round4(clamp01((clientY - b.y) / b.height)) : 0,
  };
}

/** Drop pen points closer than `eps` (relative) to the previous kept one; always keeps the first and last. */
export function simplify(points: number[], eps = 0.0015): number[] {
  const n = points.length / 2;
  if (n <= 2) return points.slice();
  const out = [points[0], points[1]];
  for (let i = 1; i < n - 1; i++) {
    const x = points[2 * i], y = points[2 * i + 1];
    if (Math.hypot(x - out[out.length - 2], y - out[out.length - 1]) >= eps) out.push(x, y);
  }
  out.push(points[2 * n - 2], points[2 * n - 1]);
  return out;
}

/** Normalised rect from a drag's two corners (any direction). */
export function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
  return {
    x: round4(Math.min(a.x, b.x)), y: round4(Math.min(a.y, b.y)),
    w: round4(Math.abs(a.x - b.x)), h: round4(Math.abs(a.y - b.y)),
  };
}

const HEAD_ANGLE = (25 * Math.PI) / 180;
const f5 = (v: number): string => String(Math.round(v * 1e5) / 1e5);

/**
 * SVG path data of a shape in a `viewBox="0 0 1 1"` stretched over the content box. The arrow head is sized in the
 * media's natural px (W×H) exactly as `drawShapes` sizes it, so the overlay and the rendered frame agree.
 */
export function shapePath(s: MediaShape, natW: number, natH: number): string {
  switch (s.kind) {
    case 'rect':
      return `M${f5(s.x)} ${f5(s.y)}H${f5(s.x + s.w)}V${f5(s.y + s.h)}H${f5(s.x)}Z`;
    case 'ellipse': {
      const rx = f5(s.w / 2), ry = f5(s.h / 2), cy = f5(s.y + s.h / 2);
      return `M${f5(s.x)} ${cy}A${rx} ${ry} 0 1 0 ${f5(s.x + s.w)} ${cy}A${rx} ${ry} 0 1 0 ${f5(s.x)} ${cy}Z`;
    }
    case 'pen':
    case 'polygon': {
      let d = `M${f5(s.points[0])} ${f5(s.points[1])}`;
      for (let i = 2; i + 1 < s.points.length; i += 2) d += `L${f5(s.points[i])} ${f5(s.points[i + 1])}`;
      return s.kind === 'polygon' ? d + 'Z' : d;
    }
    case 'arrow': {
      const W = natW > 0 ? natW : 1000, H = natH > 0 ? natH : 1000;
      const lw = Math.max(3, Math.round(Math.min(W, H) / 250));
      const len = Math.max(12, 4 * lw);
      const back = Math.atan2((s.y1 - s.y2) * H, (s.x1 - s.x2) * W);
      const tip = `M${f5(s.x2)} ${f5(s.y2)}`;
      let d = `M${f5(s.x1)} ${f5(s.y1)}L${f5(s.x2)} ${f5(s.y2)}`;
      for (const a of [back + HEAD_ANGLE, back - HEAD_ANGLE]) d += `${tip}L${f5(s.x2 + (len * Math.cos(a)) / W)} ${f5(s.y2 + (len * Math.sin(a)) / H)}`;
      return d;
    }
  }
}

/** The relative box around all shapes (rect/ellipse boxes, arrow ends, pen points). */
export function shapesBounds(shapes: MediaShape[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const at = (x: number, y: number) => {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  };
  for (const s of shapes) {
    if (s.kind === 'pen' || s.kind === 'polygon') for (let i = 0; i + 1 < s.points.length; i += 2) at(s.points[i], s.points[i + 1]);
    else if (s.kind === 'arrow') { at(s.x1, s.y1); at(s.x2, s.y2); }
    else { at(s.x, s.y); at(s.x + s.w, s.y + s.h); }
  }
  if (x0 > x1) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: round4(x0), y: round4(y0), w: round4(x1 - x0), h: round4(y1 - y0) };
}

/** Whether (x, y) is inside the polygon of `points` (x, y pairs) by the nonzero winding rule, as the mask is filled (issue 447). */
export function insidePolygon(points: number[], x: number, y: number): boolean {
  let wind = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const x0 = points[2 * i], y0 = points[2 * i + 1];
    const j = (i + 1) % n;
    const x1 = points[2 * j], y1 = points[2 * j + 1];
    const side = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0); // > 0: the point is left of the edge
    if (y0 <= y) {
      if (y1 > y && side > 0) wind++;
    } else if (y1 <= y && side < 0) wind--;
  }
  return wind !== 0;
}

/**
 * Whether a polygon's points sit too close to grab one (a lasso's outline, issue 729): its sides average under two
 * reaches (`tolX`/`tolY`: a reach, relative). Such a polygon shows no points and moves only as a whole.
 */
export function dense(points: number[], tolX: number, tolY: number): boolean {
  const n = points.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += Math.hypot((points[2 * j] - points[2 * i]) / tolX, (points[2 * j + 1] - points[2 * i + 1]) / tolY);
  }
  return sum / n < 2;
}

/** Whether `p` is within a reach (`tolX`/`tolY`) of the segment a–b. */
function nearSegment(ax: number, ay: number, bx: number, by: number, p: { x: number; y: number }, tolX: number, tolY: number): boolean {
  const dx = (bx - ax) / tolX, dy = (by - ay) / tolY;
  const px = (p.x - ax) / tolX, py = (p.y - ay) / tolY;
  const t = Math.min(1, Math.max(0, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - t * dx, py - t * dy) <= 1;
}

/** Whether `p` is within a reach of the line through `points` (closed: back to the first), and which side if so. */
function nearSide(points: number[], closed: boolean, p: { x: number; y: number }, tolX: number, tolY: number): number | null {
  const n = points.length / 2;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    if (nearSegment(points[2 * i], points[2 * i + 1], points[2 * j], points[2 * j + 1], p, tolX, tolY)) return i;
  }
  return null;
}

/**
 * The topmost (last drawn) shape under a point (relative), by index (issue 729): inside a polygon, rect or ellipse, or
 * within a reach (`tolX`/`tolY`, relative) of any shape's line.
 */
export function hitShape(shapes: MediaShape[], p: { x: number; y: number }, tolX: number, tolY: number): number | null {
  for (let k = shapes.length - 1; k >= 0; k--) {
    const s = shapes[k];
    const hit = s.kind === 'polygon' ? insidePolygon(s.points, p.x, p.y) || nearSide(s.points, true, p, tolX, tolY) !== null
      : s.kind === 'pen' ? nearSide(s.points, false, p, tolX, tolY) !== null
        : s.kind === 'arrow' ? nearSegment(s.x1, s.y1, s.x2, s.y2, p, tolX, tolY)
          : s.kind === 'rect' ? p.x >= s.x - tolX && p.x <= s.x + s.w + tolX && p.y >= s.y - tolY && p.y <= s.y + s.h + tolY
            : ((p.x - s.x - s.w / 2) / (s.w / 2 + tolX)) ** 2 + ((p.y - s.y - s.h / 2) / (s.h / 2 + tolY)) ** 2 <= 1;
    if (hit) return k;
  }
  return null;
}

/** A part of a drawn shape that a drag reshapes: a point (`vertex`) or a polygon's side (`edge` i: from point i on). */
export type Grip = { vertex: number } | { edge: number };

/**
 * A shape's points that can be dragged (x, y pairs): a polygon's own (none on a dense one), a rect's or an ellipse's
 * box corners (clockwise from the top left), an arrow's ends; a pen stroke has none.
 */
export function gripsOf(s: MediaShape, tolX: number, tolY: number): number[] {
  switch (s.kind) {
    case 'polygon': return dense(s.points, tolX, tolY) ? [] : s.points;
    case 'rect':
    case 'ellipse': return [s.x, s.y, s.x + s.w, s.y, s.x + s.w, s.y + s.h, s.x, s.y + s.h].map(round4);
    case 'arrow': return [s.x1, s.y1, s.x2, s.y2];
    case 'pen': return [];
  }
}

/** The grip of a shape under a point: one of its points, else a polygon's side (not of a dense one). */
export function hitGrip(s: MediaShape, p: { x: number; y: number }, tolX: number, tolY: number): Grip | null {
  const g = gripsOf(s, tolX, tolY);
  for (let i = 0; i + 1 < g.length; i += 2) {
    if (Math.abs(g[i] - p.x) <= tolX && Math.abs(g[i + 1] - p.y) <= tolY) return { vertex: i / 2 };
  }
  const edge = s.kind === 'polygon' && g.length ? nearSide(s.points, true, p, tolX, tolY) : null;
  return edge === null ? null : { edge };
}

/**
 * `s` with its grip dragged to (x, y): a polygon's point moved or side bent, a box's corner moved (the opposite one
 * stays; a box of no extent leaves the shape as it was), an arrow's end moved. Clamped to the media, 4 decimals.
 */
export function reshape(s: MediaShape, grip: Grip, x: number, y: number, tolX: number, tolY: number): MediaShape {
  if (s.kind === 'polygon') return { ...s, points: 'edge' in grip ? bendEdge(s.points, grip.edge, x, y, tolX, tolY) : setVertex(s.points, grip.vertex, x, y) };
  if (!('vertex' in grip)) return s;
  const at = { x: round4(clamp01(x)), y: round4(clamp01(y)) };
  if (s.kind === 'arrow') return grip.vertex ? { ...s, x2: at.x, y2: at.y } : { ...s, x1: at.x, y1: at.y };
  if (s.kind === 'pen') return s;
  const c = gripsOf(s, tolX, tolY);
  const o = (grip.vertex + 2) % 4;
  const r = rectFrom({ x: c[2 * o], y: c[2 * o + 1] }, at);
  return r.w > 0 && r.h > 0 ? { ...s, ...r } : s;
}

/** `s` shifted by (dx, dy), the shift cut so that the whole shape stays inside the media; 4 decimals. */
export function moveShape(s: MediaShape, dx: number, dy: number): MediaShape {
  const b = shapesBounds([s]);
  const cx = Math.min(1 - b.x - b.w, Math.max(-b.x, dx)), cy = Math.min(1 - b.y - b.h, Math.max(-b.y, dy));
  const mx = (v: number) => round4(clamp01(v + cx)), my = (v: number) => round4(clamp01(v + cy));
  switch (s.kind) {
    case 'polygon':
    case 'pen': return { ...s, points: movePoints(s.points, cx, cy) };
    case 'arrow': return { ...s, x1: mx(s.x1), y1: my(s.y1), x2: mx(s.x2), y2: my(s.y2) };
    default: return { ...s, x: mx(s.x), y: my(s.y) };
  }
}

/** `points` with vertex `i` at (x, y), clamped to the media, 4 decimals. */
export function setVertex(points: number[], i: number, x: number, y: number): number[] {
  const out = points.slice();
  out[2 * i] = round4(clamp01(x));
  out[2 * i + 1] = round4(clamp01(y));
  return out;
}

/**
 * `points` with side `edge` bowed into an arc through (x, y) (issue 729): a quadratic curve whose middle is there, as
 * points about 2.5 reaches (`tolX`/`tolY`) apart, so each can still be grabbed and the arc's sides bent again; an even
 * count of pieces, so (x, y) is one of them. Never past POLYGON_MAX_POINTS; 4 decimals, clamped to the media.
 */
export function bendEdge(points: number[], edge: number, x: number, y: number, tolX: number, tolY: number): number[] {
  const n = points.length / 2;
  const j = (edge + 1) % n;
  const ax = points[2 * edge], ay = points[2 * edge + 1], bx = points[2 * j], by = points[2 * j + 1];
  const cx = 2 * x - (ax + bx) / 2, cy = 2 * y - (ay + by) / 2; // the control point of a curve through (x, y) at its middle
  const len = Math.hypot((x - ax) / tolX, (y - ay) / tolY) + Math.hypot((bx - x) / tolX, (by - y) / tolY);
  const pieces = Math.min(Math.max(2, 2 * Math.round(len / 5)), POLYGON_MAX_POINTS - n + 1);
  const arc: number[] = [];
  for (let k = 1; k < pieces; k++) {
    const t = k / pieces, u = 1 - t;
    arc.push(round4(clamp01(u * u * ax + 2 * t * u * cx + t * t * bx)), round4(clamp01(u * u * ay + 2 * t * u * cy + t * t * by)));
  }
  return [...points.slice(0, 2 * edge + 2), ...arc, ...points.slice(2 * edge + 2)];
}

/** `points` shifted by (dx, dy), the shift cut so that every point stays inside the media; 4 decimals. */
export function movePoints(points: number[], dx: number, dy: number): number[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]);
  }
  const cx = Math.min(1 - maxX, Math.max(-minX, dx)), cy = Math.min(1 - maxY, Math.max(-minY, dy));
  return points.map((v, i) => round4(clamp01(v + (i % 2 ? cy : cx))));
}
