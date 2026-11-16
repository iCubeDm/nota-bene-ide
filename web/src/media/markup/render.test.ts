import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaShape } from '@nota-bene/shared';
import { drawMask, drawShapes, renderMarks } from './render';

function fakeCtx() {
  const calls: Array<[string, ...number[]]> = [];
  const ctx: Record<string, unknown> = { strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '' };
  for (const m of ['beginPath', 'moveTo', 'lineTo', 'stroke', 'strokeRect', 'ellipse', 'save', 'restore', 'closePath', 'fill', 'fillRect'])
    ctx[m] = (...a: number[]) => { calls.push([m, ...a]); };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, raw: ctx, calls };
}
const W = 1920, H = 1080;

describe('drawShapes', () => {
  it('rect → strokeRect in px, colour and width set', () => {
    const { ctx, raw, calls } = fakeCtx();
    drawShapes(ctx, [{ kind: 'rect', x: 0.42, y: 0.4, w: 0.16, h: 0.24, color: '#ff3b30' } satisfies MediaShape], W, H);
    expect(calls).toContainEqual(['strokeRect', 806.4, 432, 307.2, 259.2]);
    expect(raw.strokeStyle).toBe('#ff3b30');
    expect(raw.lineWidth).toBe(4);
    expect(raw.lineCap).toBe('round');
  });
  it('ellipse → ellipse(cx, cy, rx, ry, …)', () => {
    const { ctx, calls } = fakeCtx();
    drawShapes(ctx, [{ kind: 'ellipse', x: 0.25, y: 0.25, w: 0.5, h: 0.5, color: '#0a84ff' } satisfies MediaShape], W, H);
    const e = calls.find((c) => c[0] === 'ellipse')!;
    expect(e.slice(1, 5)).toEqual([960, 540, 480, 270]);
  });
  it('arrow → shaft plus a 2-segment head', () => {
    const { ctx, calls } = fakeCtx();
    drawShapes(ctx, [{ kind: 'arrow', x1: 0.1, y1: 0.5, x2: 0.5, y2: 0.5, color: '#34c759' } satisfies MediaShape], W, H);
    expect(calls.filter((c) => c[0] === 'moveTo').length).toBe(1 + 2);
    expect(calls.filter((c) => c[0] === 'lineTo').length).toBe(1 + 2);
    const head = calls.filter((c) => c[0] === 'lineTo').slice(1);
    for (const h of head) expect(h[1]).toBeLessThan(960); // head points back from the tip
  });
  it('pen → moveTo + lineTo per point', () => {
    const { ctx, calls } = fakeCtx();
    drawShapes(ctx, [{ kind: 'pen', points: [0, 0, 0.5, 0.5, 1, 1], color: '#ffffff' } satisfies MediaShape], W, H);
    expect(calls.filter((c) => c[0] === 'moveTo')).toEqual([['moveTo', 0, 0]]);
    expect(calls.filter((c) => c[0] === 'lineTo')).toEqual([['lineTo', 960, 540], ['lineTo', 1920, 1080]]);
  });
});

describe('polygons (issue 447)', () => {
  const poly: MediaShape = { kind: 'polygon', color: '#34c759', points: [0, 0, 0.5, 0, 0.5, 0.5] };
  it('drawShapes fills a polygon semi-transparent in its colour, then strokes its closed outline', () => {
    const { ctx, raw, calls } = fakeCtx();
    const alphas: unknown[] = [];
    raw.globalAlpha = 1;
    raw.fill = () => { calls.push(['fill']); alphas.push(raw.globalAlpha); };
    drawShapes(ctx, [poly], W, H);
    const names = calls.map((c) => c[0]);
    expect(calls.filter((c) => c[0] === 'lineTo')).toEqual([['lineTo', 960, 0], ['lineTo', 960, 540]]);
    expect(names).toContain('closePath');
    expect(names.indexOf('fill')).toBeLessThan(names.lastIndexOf('stroke'));
    expect(alphas[0]).toBeGreaterThan(0);
    expect(alphas[0]).toBeLessThan(1);
    expect(raw.globalAlpha).toBe(1); // restored for the next shape
    expect(raw.fillStyle).toBe('#34c759');
  });
  it('drawMask: black everywhere, then each polygon filled white on its own (nonzero); other shapes are not in it', () => {
    const { ctx, raw, calls } = fakeCtx();
    const fills: unknown[] = [];
    raw.fill = (rule: unknown) => { calls.push(['fill']); fills.push([raw.fillStyle, rule]); };
    raw.fillRect = (...a: number[]) => { calls.push(['fillRect', ...a]); fills.push([raw.fillStyle, 'rect']); };
    drawMask(ctx, [{ kind: 'rect', color: '#ff3b30', x: 0, y: 0, w: 1, h: 1 }, poly, { ...poly, points: [0.5, 0.5, 1, 0.5, 1, 1] }], 40, 30);
    expect(calls[0]).toEqual(['fillRect', 0, 0, 40, 30]);
    expect(fills).toEqual([['#000000', 'rect'], ['#ffffff', 'nonzero'], ['#ffffff', 'nonzero']]);
    expect(calls.filter((c) => c[0] === 'moveTo')).toEqual([['moveTo', 0, 0], ['moveTo', 20, 15]]);
    expect(calls.map((c) => c[0])).not.toContain('strokeRect');
  });
  it('drawMask: two overlapping polygons of opposite orientation are a union, no hole where they overlap', () => {
    // a context that rasterizes as a canvas does: each fill() paints the current path (all its subpaths) by nonzero winding
    const W2 = 10, H2 = 10;
    const px: string[] = new Array(W2 * H2).fill('');
    let subs: number[][] = [];
    const st = { fillStyle: '' as unknown };
    const wind = (x: number, y: number) => {
      let w = 0;
      for (const p of subs) {
        for (let i = 0; i < p.length; i += 2) {
          const x0 = p[i], y0 = p[i + 1], x1 = p[(i + 2) % p.length], y1 = p[(i + 3) % p.length];
          const side = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
          if (y0 <= y) { if (y1 > y && side > 0) w++; } else if (y1 <= y && side < 0) w--;
        }
      }
      return w;
    };
    const ctx = {
      set fillStyle(v: unknown) { st.fillStyle = v; }, get fillStyle() { return st.fillStyle; },
      fillRect: () => void px.fill(String(st.fillStyle)),
      beginPath: () => void (subs = []),
      moveTo: (x: number, y: number) => void subs.push([x, y]),
      lineTo: (x: number, y: number) => void subs.at(-1)!.push(x, y),
      closePath: () => {},
      fill: () => {
        for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) if (wind(x + 0.5, y + 0.5) !== 0) px[y * W2 + x] = String(st.fillStyle);
      },
    } as unknown as CanvasRenderingContext2D;
    const cw: MediaShape = { kind: 'polygon', color: '#ff3b30', points: [0.1, 0.1, 0.6, 0.1, 0.6, 0.6, 0.1, 0.6] };
    const ccw: MediaShape = { kind: 'polygon', color: '#ff3b30', points: [0.4, 0.4, 0.4, 0.9, 0.9, 0.9, 0.9, 0.4] };
    drawMask(ctx, [cw, ccw], W2, H2);
    const at = (x: number, y: number) => px[y * W2 + x];
    expect(at(5, 5)).toBe('#ffffff'); // in both: inside the union
    expect(at(2, 2)).toBe('#ffffff');
    expect(at(8, 8)).toBe('#ffffff');
    expect(at(0, 9)).toBe('#000000');
    expect(at(8, 1)).toBe('#000000');
  });
});

describe('renderMarks', () => {
  afterEach(() => void vi.unstubAllGlobals());
  it('the frame is filled white before the source is drawn (an alpha source must not turn black in the JPEG); the layer stays transparent', async () => {
    const canvases: Array<{ calls: Array<[string, ...unknown[]]>; fill: unknown[] }> = [];
    class FakeCanvas {
      width: number; height: number;
      rec: { calls: Array<[string, ...unknown[]]>; fill: unknown[] } = { calls: [], fill: [] };
      constructor(w: number, h: number) { this.width = w; this.height = h; canvases.push(this.rec); }
      getContext() {
        const rec = this.rec;
        const ctx: Record<string, unknown> = { lineWidth: 0, strokeStyle: '' };
        let fillStyle: unknown = '#000000';
        Object.defineProperty(ctx, 'fillStyle', { get: () => fillStyle, set: (v) => void (fillStyle = v) });
        for (const m of ['beginPath', 'moveTo', 'lineTo', 'stroke', 'strokeRect', 'ellipse', 'drawImage', 'fillRect', 'save', 'restore'])
          ctx[m] = (...a: unknown[]) => {
            rec.calls.push([m, ...a.filter((x) => typeof x === 'number')]);
            if (m === 'fillRect') rec.fill.push(fillStyle);
          };
        return ctx;
      }
      convertToBlob() { return Promise.resolve(new Blob(['x'])); }
    }
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const src = {} as CanvasImageSource;
    await renderMarks(src, 40, 30, [{ kind: 'rect', x: 0.1, y: 0.1, w: 0.5, h: 0.5, color: '#ff3b30' }]);
    const [frame, layer] = canvases;
    const names = frame!.calls.map((c) => c[0]);
    expect(names.indexOf('fillRect')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('fillRect')).toBeLessThan(names.indexOf('drawImage'));
    expect(frame!.calls.find((c) => c[0] === 'fillRect')).toEqual(['fillRect', 0, 0, 40, 30]);
    expect(frame!.fill).toEqual(['#ffffff']);
    expect(layer!.calls.map((c) => c[0])).not.toContain('fillRect');
    expect(layer!.calls.map((c) => c[0])).not.toContain('drawImage');
  });
});

describe('renderMarks: mask.png (issue 447)', () => {
  afterEach(() => void vi.unstubAllGlobals());
  const sizes: number[][] = [];
  class Canvas {
    width: number; height: number;
    constructor(w: number, h: number) { this.width = w; this.height = h; sizes.push([w, h]); }
    getContext() {
      const ctx: Record<string, unknown> = {};
      for (const m of ['beginPath', 'moveTo', 'lineTo', 'stroke', 'strokeRect', 'ellipse', 'drawImage', 'fillRect', 'save', 'restore', 'closePath', 'fill'])
        ctx[m] = () => {};
      return ctx;
    }
    convertToBlob(o?: { type?: string }) { return Promise.resolve(new Blob(['x'], { type: o?.type ?? 'image/png' })); }
  }
  it('a drawing with a polygon has a mask the size of the frame; one without has none', async () => {
    vi.stubGlobal('OffscreenCanvas', Canvas);
    sizes.length = 0;
    const out = await renderMarks({} as CanvasImageSource, 40, 30, [{ kind: 'polygon', color: '#ff3b30', points: [0, 0, 1, 0, 1, 1] }]);
    expect(out.mask).toBeInstanceOf(Blob);
    expect(sizes).toEqual([[40, 30], [40, 30], [40, 30]]);
    const none = await renderMarks({} as CanvasImageSource, 40, 30, [{ kind: 'rect', color: '#ff3b30', x: 0, y: 0, w: 1, h: 1 }]);
    expect(none.mask).toBeUndefined();
  });
});
