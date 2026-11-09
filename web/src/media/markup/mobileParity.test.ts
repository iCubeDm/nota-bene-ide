// The phone draws and describes media marks with its own port (mobile/app/lib/media/shapes.dart): this writes and
// checks the desktop's results for a fixed set of inputs, which the app's shapes_test compares with its own.
// UPDATE_FIXTURES=1 rewrites the JSON after a deliberate change of either side.
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { MediaShape } from '@nota-bene/shared';
import { describeShape, mediaTime, rectFrom, simplify } from './geometry.ts';

const shapes: MediaShape[] = [
  { kind: 'rect', color: '#ff3b30', x: 0.42, y: 0.4, w: 0.16, h: 0.24 },
  { kind: 'rect', color: '#ffffff', x: 0, y: 0, w: 1, h: 1 },
  { kind: 'ellipse', color: '#ffcc00', x: 0.1, y: 0.2, w: 0.3333, h: 0.5 },
  { kind: 'arrow', color: '#34c759', x1: 0.9, y1: 0.1, x2: 0.5, y2: 0.55 },
  { kind: 'arrow', color: '#0a84ff', x1: 0, y1: 1, x2: 1, y2: 0 },
  { kind: 'pen', color: '#ff3b30', points: [0.1, 0.1, 0.12345, 0.2, 0.3, 0.25, 0.31, 0.9] },
  { kind: 'pen', color: '#ffffff', points: [0.5, 0.5, 0.5, 0.5] },
];
const sizes: [number, number][] = [[1920, 1080], [7, 3]];
const times = [0, 0.0004, 0.0005, 1, 61.5, 3599.999, 3600];
const pens = [
  [0, 0, 0.001, 0, 0.002, 0, 0.003, 0, 1, 1],
  [0.1, 0.1, 0.2, 0.2],
  Array.from({ length: 40 }, (_, i) => (i % 2 ? Math.sin(i / 7) * 0.5 + 0.5 : i / 40)),
];
const corners: [{ x: number; y: number }, { x: number; y: number }][] = [
  [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.9 }],
  [{ x: 0.123456, y: 0.000049 }, { x: 0.99995, y: 0.5 }],
];

it('the desktop side of the media fixtures', () => {
  const data = {
    shapes,
    describe: sizes.map(([w, h]) => ({ w, h, lines: shapes.map((s) => describeShape(s, w, h)) })),
    times: times.map((t) => ({ t, text: mediaTime(t) })),
    simplify: pens.map((points) => ({ points, eps: [0.0015, 0.003, 0.2].map((e) => ({ e, out: simplify(points, e) })) })),
    rectFrom: corners.map(([a, b]) => ({ a, b, r: rectFrom(a, b) })),
  };
  const out = path.resolve(__dirname, '../../../../mobile/app/test/fixtures/media/shapes.json');
  const json = JSON.stringify(data, null, 1) + '\n';
  if (process.env.UPDATE_FIXTURES) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
  }
  expect(json).toBe(fs.readFileSync(out, 'utf8'));
});
