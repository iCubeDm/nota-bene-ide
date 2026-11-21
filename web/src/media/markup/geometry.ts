import type { MediaShape } from '@nota-bene/shared';

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
 * The polygon under a point (relative), topmost (last drawn) first: a vertex within `tolX`/`tolY` of it, else its inside.
 * Other kinds of shape are not hit (only polygons are edited after drawing).
 */
export function hitPolygon(shapes: MediaShape[], p: { x: number; y: number }, tolX: number, tolY: number): { index: number; vertex: number | null } | null {
  for (let k = shapes.length - 1; k >= 0; k--) {
    const s = shapes[k];
    if (s.kind !== 'polygon') continue;
    for (let i = 0; i + 1 < s.points.length; i += 2) {
      if (Math.abs(s.points[i] - p.x) <= tolX && Math.abs(s.points[i + 1] - p.y) <= tolY) return { index: k, vertex: i / 2 };
    }
  }
  for (let k = shapes.length - 1; k >= 0; k--) {
    const s = shapes[k];
    if (s.kind === 'polygon' && insidePolygon(s.points, p.x, p.y)) return { index: k, vertex: null };
  }
  return null;
}

/** `points` with vertex `i` at (x, y), clamped to the media, 4 decimals. */
export function setVertex(points: number[], i: number, x: number, y: number): number[] {
  const out = points.slice();
  out[2 * i] = round4(clamp01(x));
  out[2 * i + 1] = round4(clamp01(y));
  return out;
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
