import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isAttachmentAnchor, type AttachmentAnchor, type MediaShape } from '@nota-bene/shared';
import { CommentPopup } from '@/comments/CommentPopup.tsx';
import { selectComments } from '@/comments/slice.ts';
import { useMarkPopup } from '@/files/view/useMediaMarkup.ts';
import { useT } from '@/i18n/index.ts';
import { prepareAttachmentComment } from '@/media/markup/createMediaComment.ts';
import { MarkupLayer } from '@/media/markup/MarkupLayer.tsx';
import { shapeEls, useOverlayPlacement } from '@/media/markup/overlay.tsx';
import { clear, selectDraft, setMode } from '@/media/markup/slice.ts';
import { toast } from '@/shell/toast.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';

/** The markup tab id of an attached image (the drawing's draft lives in the markup slice under it). */
export const attachTabId = (imageId: string): string => `attach:${imageId}`;

/** The marks of the image's comments made so far, dimmed under the drawing; they take no clicks. */
function Marks({ image, media }: { image: string; media: HTMLImageElement }) {
  const all = useAppSelector(selectComments);
  const mine = useMemo(() => all.flatMap((c) => (c.status === 'pending' && isAttachmentAnchor(c.anchor) && c.anchor.image === image ? [c.anchor] : [])), [all, image]);
  const svg = useRef<SVGSVGElement>(null);
  const pane = media.parentElement;
  useOverlayPlacement(svg, media, 'contain', mine.length > 0 && !!pane);
  if (!mine.length || !pane) return null;
  return createPortal(
    <svg
      ref={svg}
      data-anchor-skip
      aria-hidden="true"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      fill="none"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute z-[5] overflow-visible opacity-60 select-none"
    >
      {mine.map((a, i) => <g key={i} data-attach-mark>{shapeEls(a.shapes, a.width, a.height)}</g>)}
    </svg>,
    pane,
  );
}

/**
 * Full-window markup of an image attached to the unsent message (protocol 17), opened over the composer: the same drawing
 * layer and comment popup a media tab has, on the attachment's own bytes. An Add renders the image with its shapes as one
 * JPEG, uploads it to /attach (the comment's `images[0]`) and adds a comment anchored to the attachment (nothing is written
 * to /marks). Leaving the mode (Esc, ✕; a drawing asks first) closes it.
 */
export function AttachmentMarkup({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const tabId = attachTabId(id);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const on = useAppSelector((s) => selectDraft(s, tabId).on);
  const wasOn = useRef(false);
  useEffect(() => {
    dispatch(setMode(tabId, true));
    return () => void dispatch(clear(tabId));
  }, [dispatch, tabId]);
  useEffect(() => {
    if (on) wasOn.current = true;
    else if (wasOn.current) onClose();
  }, [on, onClose]);
  const { markPopup, setMarkPopup, closeMarkPopup, markAdded, saving, onPopupBusy } = useMarkPopup({ tabId, active: true, marking: on });
  const onAdd = useCallback((shapes: MediaShape[], at: DOMRect) => {
    if (!img) return;
    const [width, height] = [img.naturalWidth, img.naturalHeight];
    if (!width || !height) return toast(t('markNoSize'), '');
    const anchor: AttachmentAnchor = { kind: 'attachment', image: id, width, height, shapes };
    setMarkPopup({ anchor, rect: at, prepare: () => prepareAttachmentComment(img, anchor) });
  }, [img, id, t, setMarkPopup]);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t('markAttachment')} data-anchor-skip className="fixed inset-0 z-50 grid place-items-center bg-scrim/80">
      <div className="relative h-[92vh] w-[92vw]">
        <div data-pane={tabId} className="absolute inset-0 grid place-items-center overflow-auto">
          <img ref={setImg} src={`/attach/${id}`} alt="" draggable={false} className="relative max-h-full max-w-full rounded-lg object-contain" />
        </div>
        {img && <Marks image={id} media={img} />}
        {img && <MarkupLayer tabId={tabId} media={img} fit="contain" onAdd={onAdd} held={!!markPopup} saving={saving} />}
      </div>
      {markPopup && createPortal(
        <div className="relative z-[60]">
          <CommentPopup key="attachment" pending={markPopup} onClose={closeMarkPopup} onAdded={() => markAdded(isAttachmentAnchor(markPopup.anchor) ? markPopup.anchor.shapes : [])} onBusy={onPopupBusy} />
        </div>,
        document.body,
      )}
    </div>,
    document.body,
  );
}
