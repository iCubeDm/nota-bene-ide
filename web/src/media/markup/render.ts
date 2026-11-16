import { MARK_MAX_BYTES, type MediaShape } from '@nota-bene/shared';
import { encode } from '../../attachments/image';

export { MARK_MAX_BYTES };

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const HEAD_ANGLE = (25 * Math.PI) / 180;

/** How opaque a polygon's fill is, over the frame and in the overlays (issue 447). */
export const POLYGON_FILL_OPACITY = 0.3;

/** The stroke width of shapes drawn on a w×h picture. */
export const strokeWidth = (w: number, h: number): number => Math.max(3, Math.round(Math.min(w, h) / 250));

/** Draws shapes on a 2D context sized w×h (relative → px). Stroke width `strokeWidth(w, h)` unless given. */
export function drawShapes(ctx: Ctx, shapes: MediaShape[], w: number, h: number, lineWidth = strokeWidth(w, h)): void {
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of shapes) {
    ctx.strokeStyle = s.color;
    switch (s.kind) {
      case 'rect':
        ctx.strokeRect(s.x * w, s.y * h, s.w * w, s.h * h);
        break;
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse((s.x + s.w / 2) * w, (s.y + s.h / 2) * h, (s.w / 2) * w, (s.h / 2) * h, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'arrow': {
        const x1 = s.x1 * w, y1 = s.y1 * h, x2 = s.x2 * w, y2 = s.y2 * h;
        const back = Math.atan2(y1 - y2, x1 - x2); // from the tip back along the shaft
        const len = Math.max(12, 4 * lineWidth);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        for (const a of [back + HEAD_ANGLE, back - HEAD_ANGLE]) {
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 + len * Math.cos(a), y2 + len * Math.sin(a));
        }
        ctx.stroke();
        break;
      }
      case 'polygon': { // issue 447: filled semi-transparent, with its outline
        const p = s.points;
        if (p.length < 6) break;
        ctx.beginPath();
        ctx.moveTo(p[0] * w, p[1] * h);
        for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i] * w, p[i + 1] * h);
        ctx.closePath();
        const alpha = ctx.globalAlpha;
        ctx.fillStyle = s.color;
        ctx.globalAlpha = alpha * POLYGON_FILL_OPACITY;
        ctx.fill('nonzero');
        ctx.globalAlpha = alpha;
        ctx.stroke();
        break;
      }
      case 'pen': {
        const p = s.points;
        if (p.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(p[0] * w, p[1] * h);
        for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i] * w, p[i + 1] * h);
        ctx.stroke();
        break;
      }
    }
  }
}

/**
 * `mask.png`'s picture (issue 447): black, and white inside any polygon of `shapes`. Each polygon is filled on its own
 * (nonzero within it), so the mask is their union: in one shared path two overlapping polygons of opposite orientation
 * would cancel out and leave a hole.
 */
export function drawMask(ctx: Ctx, shapes: MediaShape[], w: number, h: number): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  for (const s of shapes) {
    if (s.kind !== 'polygon' || s.points.length < 6) continue;
    const p = s.points;
    ctx.beginPath();
    ctx.moveTo(p[0] * w, p[1] * h);
    for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i] * w, p[i + 1] * h);
    ctx.closePath();
    ctx.fill('nonzero');
  }
}

/** Antialiased edges are grey: every pixel becomes pure black or white, so the mask is a clean 0/255 (a context without
 *  pixel access, as in tests, is left as drawn). */
function binarize(ctx: Ctx, w: number, h: number): void {
  if (typeof ctx.getImageData !== 'function') return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] >= 128 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function makeCanvas(w: number, h: number): { c: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx } {
  let c: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
  else {
    c = document.createElement('canvas');
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d') as Ctx | null;
  if (!ctx) throw new Error('no 2d canvas');
  return { c, ctx };
}

/**
 * `frame.jpg` (q 0.9, the source drawn first) and `layer.png` (shapes only, transparent), both natural size; `scale` < 1
 * only when a file exceeded MARK_MAX_BYTES. With a polygon among the shapes also `mask` (issue 447): `mask.png`, the
 * frame's size, white inside the polygons, black elsewhere.
 */
export async function renderMarks(
  source: CanvasImageSource, w: number, h: number, shapes: MediaShape[],
): Promise<{ frame: Blob; layer: Blob; mask?: Blob; scale: number }> {
  const masked = shapes.some((s) => s.kind === 'polygon');
  let scale = 1;
  for (;;) {
    const pw = Math.max(1, Math.round(w * scale)), ph = Math.max(1, Math.round(h * scale));
    const f = makeCanvas(pw, ph);
    // JPEG has no alpha: a transparent pixel of the source would encode black; white under it, as a viewer shows it
    f.ctx.fillStyle = '#ffffff';
    f.ctx.fillRect(0, 0, pw, ph);
    f.ctx.drawImage(source, 0, 0, pw, ph);
    drawShapes(f.ctx, shapes, pw, ph);
    const l = makeCanvas(pw, ph);
    drawShapes(l.ctx, shapes, pw, ph);
    let m: ReturnType<typeof makeCanvas> | null = null;
    if (masked) {
      m = makeCanvas(pw, ph);
      drawMask(m.ctx, shapes, pw, ph);
      binarize(m.ctx, pw, ph);
    }
    const [frame, layer, mask] = await Promise.all([
      encode(f.c, 'image/jpeg', 0.9), encode(l.c, 'image/png'), m ? encode(m.c, 'image/png') : Promise.resolve(undefined),
    ]);
    const fits = frame.size <= MARK_MAX_BYTES && layer.size <= MARK_MAX_BYTES && (!mask || mask.size <= MARK_MAX_BYTES);
    if (fits || (pw === 1 && ph === 1)) return mask ? { frame, layer, mask, scale } : { frame, layer, scale };
    scale *= 0.75;
  }
}
