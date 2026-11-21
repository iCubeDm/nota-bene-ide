import { expect, it } from 'vitest';
import { contentBox, hitPolygon, insidePolygon, movePoints, rectFrom, round4, setVertex, shapePath, shapesBounds, simplify, toRel } from './geometry.ts';
import { describeShape, mediaTime } from '@/core/anchors/quote.ts';
import type { MediaShape } from '@nota-bene/shared';

const R = (x: number, y: number, w: number, h: number) =>
  ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h }) as DOMRect;

it('contain letterboxes horizontally', () => {
  const b = contentBox(R(0, 0, 1000, 500), 1000, 1000, 'contain');
  expect([b.x, b.y, b.width, b.height]).toEqual([250, 0, 500, 500]);
});
it('contain letterboxes vertically', () => {
  const b = contentBox(R(0, 0, 500, 1000), 1000, 500, 'contain');
  expect([b.x, b.y, b.width, b.height]).toEqual([0, 375, 500, 250]);
});
it('natural uses the element box as is', () => {
  const b = contentBox(R(-300, 20, 800, 600), 800, 600, 'natural');
  expect([b.x, b.y, b.width, b.height]).toEqual([-300, 20, 800, 600]);
});
it('toRel maps corners exactly and clamps outside', () => {
  const box = R(100, 50, 400, 200);
  expect(toRel(100, 50, box)).toEqual({ x: 0, y: 0 });
  expect(toRel(500, 250, box)).toEqual({ x: 1, y: 1 });
  expect(toRel(700, 0, box)).toEqual({ x: 1, y: 0 });
  expect(toRel(200, 100, box)).toEqual({ x: 0.25, y: 0.25 });
  expect(toRel(133, 50, box).x).toBe(0.0825);
});
it('round4 rounds to 4 decimals', () => {
  expect(round4(0.123456)).toBe(0.1235);
});
it('rectFrom normalises any drag direction', () => {
  const want = { x: 0.2, y: 0.1, w: 0.3, h: 0.4 };
  expect(rectFrom({ x: 0.2, y: 0.1 }, { x: 0.5, y: 0.5 })).toEqual(want);
  expect(rectFrom({ x: 0.5, y: 0.5 }, { x: 0.2, y: 0.1 })).toEqual(want);
  expect(rectFrom({ x: 0.5, y: 0.1 }, { x: 0.2, y: 0.5 })).toEqual(want);
});
it('simplify keeps first/last, drops near duplicates, never empties a 2-point stroke', () => {
  expect(simplify([0.1, 0.1, 0.1001, 0.1001, 0.1002, 0.1, 0.5, 0.5])).toEqual([0.1, 0.1, 0.5, 0.5]);
  expect(simplify([0.1, 0.1, 0.1001, 0.1001])).toEqual([0.1, 0.1, 0.1001, 0.1001]);
  expect(simplify([0.2, 0.2])).toEqual([0.2, 0.2]);
  expect(simplify([0, 0, 0.1, 0.1, 0.2, 0.2])).toEqual([0, 0, 0.1, 0.1, 0.2, 0.2]);
});
const C = '#ff3b30' as const;
it('describeShape rect', () => {
  expect(describeShape({ kind: 'rect', color: C, x: 0.42, y: 0.4, w: 0.16, h: 0.24 }, 1920, 1080))
    .toBe('rect x=0.42 y=0.4 w=0.16 h=0.24 (px 806,432 307×259)');
});
it('describeShape ellipse', () => {
  expect(describeShape({ kind: 'ellipse', color: C, x: 0.4, y: 0.3, w: 0.2, h: 0.4 }, 1920, 1080))
    .toBe('ellipse cx=0.5 cy=0.5 rx=0.1 ry=0.2 (px 960,540 r 192×216)');
});
it('describeShape arrow', () => {
  expect(describeShape({ kind: 'arrow', color: C, x1: 0.3, y1: 0.55, x2: 0.41, y2: 0.5 }, 1920, 1080))
    .toBe('arrow (0.3,0.55)→(0.41,0.5) (px 576,594→787,540)');
});
it('describeShape pen', () => {
  const points: number[] = [];
  for (let i = 0; i < 38; i++) points.push(0.1 + i * 0.01, i === 5 ? 0.2 : 0.3);
  expect(describeShape({ kind: 'pen', color: C, points }, 1000, 1000))
    .toBe('pen 38 pts, bbox x=0.1 y=0.2 w=0.37 h=0.1 (px 100,200 370×100)');
});

it('shapePath draws in the 0..1 viewBox; the arrow head is sized in natural px like the rendered frame', () => {
  expect(shapePath({ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 1000, 500)).toBe('M0.1 0.2H0.4V0.6H0.1Z');
  expect(shapePath({ kind: 'ellipse', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.2, h: 0.4 }, 1000, 500))
    .toBe('M0.1 0.4A0.1 0.2 0 1 0 0.3 0.4A0.1 0.2 0 1 0 0.1 0.4Z');
  expect(shapePath({ kind: 'pen', color: '#ff3b30', points: [0.1, 0.1, 0.2, 0.3] }, 1000, 500)).toBe('M0.1 0.1L0.2 0.3');
  // 1000×500: line width max(3, round(500/250)) = 3, head 12 px; a horizontal arrow's barbs go back 12·cos25° ≈ 10.88 px
  const d = shapePath({ kind: 'arrow', color: '#ff3b30', x1: 0.1, y1: 0.5, x2: 0.5, y2: 0.5 }, 1000, 500);
  const nums = d.match(/-?[\d.]+/g)!.map(Number);
  expect(nums.slice(0, 4)).toEqual([0.1, 0.5, 0.5, 0.5]);
  expect(nums[6]).toBeCloseTo(0.5 - 10.876 / 1000, 4); // barb x
  expect(nums[7]).toBeCloseTo(0.5 - 5.071 / 500, 4); // barb y: px → relative by height, not width
});

it('shapesBounds: the relative box around every shape (arrow ends, pen points)', () => {
  expect(shapesBounds([
    { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
    { kind: 'arrow', color: '#ff3b30', x1: 0.9, y1: 0.05, x2: 0.5, y2: 0.5 },
    { kind: 'pen', color: '#ff3b30', points: [0.2, 0.7, 0.3, 0.8] },
  ])).toEqual({ x: 0.1, y: 0.05, w: 0.8, h: 0.75 });
});

it('mediaTime: m:ss.mmm, the batch and the popup quote alike', () => {
  expect(mediaTime(4.24)).toBe('0:04.240');
  expect(mediaTime(0)).toBe('0:00.000');
  expect(mediaTime(125.0006)).toBe('2:05.001');
  expect(mediaTime(59.9996)).toBe('1:00.000'); // rounding carries into the minute
});

// ---- polygons (issue 447) ----
const square: MediaShape = { kind: 'polygon', color: '#ff3b30', points: [0.2, 0.2, 0.6, 0.2, 0.6, 0.6, 0.2, 0.6] };
it('a polygon is described with every point in px of the natural size', () => {
  expect(describeShape(square, 1000, 500)).toBe('polygon 4 pts (px 200,100 600,100 600,300 200,300)');
});
it('a polygon path is closed', () => {
  expect(shapePath(square, 1000, 500)).toBe('M0.2 0.2L0.6 0.2L0.6 0.6L0.2 0.6Z');
});
it('shapesBounds takes a polygon by its points', () => {
  expect(shapesBounds([square])).toEqual({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
});
it('insidePolygon: nonzero winding, a self-crossing shape counts its overlap as inside', () => {
  const pts = (square as { points: number[] }).points;
  expect(insidePolygon(pts, 0.4, 0.4)).toBe(true);
  expect(insidePolygon(pts, 0.1, 0.4)).toBe(false);
  expect(insidePolygon(pts, 0.7, 0.7)).toBe(false);
  // a star drawn as one pentagram: its centre is inside under nonzero (even-odd would call it outside)
  const star: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    star.push(0.5 + 0.4 * Math.cos(a), 0.5 + 0.4 * Math.sin(a));
  }
  expect(insidePolygon(star, 0.5, 0.5)).toBe(true);
});
it('hitPolygon finds a vertex first, then the inside, topmost polygon first; other shapes are skipped', () => {
  const other: MediaShape = { kind: 'polygon', color: '#0a84ff', points: [0.5, 0.5, 0.9, 0.5, 0.9, 0.9] };
  const shapes: MediaShape[] = [square, { kind: 'rect', color: '#ff3b30', x: 0, y: 0, w: 1, h: 1 }, other];
  expect(hitPolygon(shapes, { x: 0.601, y: 0.199 }, 0.01, 0.01)).toEqual({ index: 0, vertex: 1 });
  expect(hitPolygon(shapes, { x: 0.3, y: 0.3 }, 0.01, 0.01)).toEqual({ index: 0, vertex: null });
  expect(hitPolygon(shapes, { x: 0.58, y: 0.55 }, 0.01, 0.01)).toEqual({ index: 2, vertex: null }); // the later one is on top
  expect(hitPolygon(shapes, { x: 0.05, y: 0.95 }, 0.01, 0.01)).toBeNull();
});
it('setVertex moves one point (clamped, 4 decimals); movePoints shifts all, kept inside the media', () => {
  const pts = (square as { points: number[] }).points;
  expect(setVertex(pts, 2, 0.712345, 1.3)).toEqual([0.2, 0.2, 0.6, 0.2, 0.7123, 1, 0.2, 0.6]);
  expect(movePoints(pts, 0.1, -0.05)).toEqual([0.3, 0.15, 0.7, 0.15, 0.7, 0.55, 0.3, 0.55]);
  expect(movePoints(pts, 0.9, -0.9)).toEqual([0.6, 0, 1, 0, 1, 0.4, 0.6, 0.4]); // stops at the edges
  expect(pts).toEqual([0.2, 0.2, 0.6, 0.2, 0.6, 0.6, 0.2, 0.6]); // not mutated
});
