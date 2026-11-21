import type { AttachmentAnchor, Comment, MediaAnchor } from '@nota-bene/shared';
import { prepareImage, uploadImage } from '@/attachments/image.ts';
import { t, connections, routes, type MediaAnchorPatch } from '@/sdk';
import { drawShapes, renderMarks, strokeWidth } from './render.ts';
import { drawBadges } from './badges.ts';

async function putMark(id: string, name: 'frame.jpg' | 'layer.png' | 'mask.png', b: Blob): Promise<void> {
  const type = name === 'frame.jpg' ? 'image/jpeg' : 'image/png';
  const r = await connections.current().fetch(routes.marks(id, name), { method: 'POST', headers: { 'content-type': type }, body: b });
  if (!r.ok) throw new Error(`${name} ${r.status}`);
}

/**
 * Drops `/marks/<id>` (the comment never came to be). Never throws: a 409 means the comment is already sent and keeps
 * its files; a network error leaves an orphan folder, which is logged, not shown (the server's sweep is later work).
 */
export async function deleteMarks(id: string): Promise<void> {
  try {
    const r = await connections.current().fetch(routes.marks(id), { method: 'DELETE' });
    if (!r.ok && r.status !== 409) console.warn(`DELETE /marks/${id}: ${r.status}`);
  } catch (e) {
    console.warn(`DELETE /marks/${id}:`, e);
  }
}

/** A HEAD that never answers must not hold Add forever: no version then. */
const VERSION_WAIT_MS = 5000;
/** How long a video may take to have its current frame (loading, or mid-seek) before Add gives up with an error. */
const FRAME_WAIT_MS = 5000;

/** Resolves once the video has the frame at its current time (not seeking, readyState >= HAVE_CURRENT_DATA). */
function frameReady(v: HTMLVideoElement): Promise<void> {
  const ready = () => v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !v.seeking;
  if (ready()) return Promise.resolve();
  const events = ['loadeddata', 'seeked', 'canplay', 'timeupdate'] as const;
  return new Promise((resolve, reject) => {
    const done = (e?: Error) => {
      clearTimeout(timer);
      for (const n of events) v.removeEventListener(n, check);
      if (e) reject(e);
      else resolve();
    };
    const check = () => void (ready() && done());
    const timer = setTimeout(() => done(new Error(t('markNoFrame'))), FRAME_WAIT_MS);
    for (const n of events) v.addEventListener(n, check);
  });
}

/**
 * Renders, uploads the natural-size files to /marks/<id>/… (frame.jpg, layer.png and, with polygons, mask.png), uploads the downscaled frame (not layer.png: the shapes are in the text) to /attach; returns its id and the anchor patch. On any failure deletes /marks/<id> and rejects. Sequential on purpose: a DELETE
 * after a failure must not overtake a write still in flight.
 * - A video is paused, waited for until it has the current frame (FRAME_WAIT_MS, then an error), and its time read
 *   right before the frame is drawn (an OS media key may have resumed it).
 * - `version`: the media's ETag request, made when the mode was entered; awaited here, after the frame is captured.
 * - `scale`: only when the files had to be downscaled to fit (< 1).
 */
export async function prepareMediaComment(
  id: string, source: CanvasImageSource, anchor: MediaAnchor, o: { version?: Promise<string | undefined> } = {},
): Promise<{ images: string[]; anchor: MediaAnchorPatch }> {
  try {
    const patch: MediaAnchorPatch = {};
    if (source instanceof HTMLVideoElement) {
      source.pause();
      await frameReady(source); // an empty or mid-seek video would draw a blank (or a stale) frame
      source.pause(); // again: a media key may have resumed it during the wait
      patch.time = Math.round(source.currentTime * 1000) / 1000;
    }
    // no await between the time and the call: renderMarks draws the frame before its first await
    const { frame, layer, mask, scale } = await renderMarks(source, anchor.width, anchor.height, anchor.shapes);
    if (scale < 1) patch.scale = scale;
    await putMark(id, 'frame.jpg', frame);
    await putMark(id, 'layer.png', layer);
    if (mask) await putMark(id, 'mask.png', mask); // a drawing with polygons (issue 447)
    const f = await uploadImage(await prepareImage(frame));
    if (o.version) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const version = await Promise.race([
        o.version.catch(() => undefined),
        new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), VERSION_WAIT_MS))),
      ]);
      clearTimeout(timer);
      if (version !== undefined) patch.version = version;
    }
    return { images: [f.id], anchor: patch };
  } catch (e) {
    await deleteMarks(id);
    throw e;
  }
}

/**
 * A comment on an image attached to the unsent message (protocol 17): the image with its shapes, as one JPEG, uploaded to
 * /attach (images[0] of the comment). Nothing goes to /marks: the marks live in the anchor and the batch text. `scale` only
 * when the render had to shrink to fit MARK_MAX_BYTES.
 */
export async function prepareAttachmentComment(
  source: CanvasImageSource, anchor: AttachmentAnchor,
): Promise<{ images: string[]; anchor: MediaAnchorPatch }> {
  const { frame, scale } = await renderMarks(source, anchor.width, anchor.height, anchor.shapes);
  const f = await uploadImage(await prepareImage(frame));
  return { images: [f.id], anchor: scale < 1 ? { scale } : {} };
}

/**
 * One frame for several comments of a send marking it (`AnchorView.composite`), uploaded: the first comment's attached
 * frame (its shapes drawn) plus the others' shapes, then a numbered badge per comment. Built from the already downscaled
 * attachment (no reload or video seek; the badges are sized for the final pixels).
 */
export async function composite(members: { n: number; comment: Comment }[]): Promise<string> {
  const ms = members.map(({ n, comment }) => ({ n, a: comment.anchor as MediaAnchor }));
  const r = await fetch(connections.current().url(routes.attach(members[0].comment.images![0])));
  if (!r.ok) throw new Error(`attach ${r.status}`);
  const bmp = await createImageBitmap(await r.blob());
  try {
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas');
    ctx.drawImage(bmp, 0, 0);
    // the first comment's shapes were drawn at the natural size and shrunk with the upload: the others get the same stroke width
    const a0 = ms[0].a, nat = a0.scale ?? 1;
    const lw = Math.max(1, strokeWidth(Math.round(a0.width * nat), Math.round(a0.height * nat)) * (c.width / (a0.width * nat)));
    for (const m of ms.slice(1)) drawShapes(ctx, m.a.shapes, c.width, c.height, lw);
    drawBadges(ctx, ms.map((m) => ({ n: m.n, shapes: m.a.shapes })), c.width, c.height);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
    if (!blob) throw new Error('could not encode the image');
    return (await uploadImage(await prepareImage(blob))).id;
  } finally {
    bmp.close();
  }
}
