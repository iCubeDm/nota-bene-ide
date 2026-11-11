import { useMemo, useState } from 'react';
import { isAttachmentAnchor } from '@nota-bene/shared';
import { removeComment, selectComments } from '@/comments/slice.ts';
import { addImage, markAttachment, removeImage, selectImages, selectMarking } from '@/composer/slice.ts';
import { ConfirmDialog } from '@/controls/ConfirmDialog.tsx';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { AttachmentMarkup } from './AttachmentMarkup.tsx';
import { Attachments, type PendingThumb } from './Attachments.tsx';

/** The protocol that has attachment anchors: below it the pen is not offered (the server would drop the comment). */
export const ATTACHMENT_MARKUP_PROTOCOL = 17;

/**
 * The composer's thumbnail strip: remove, and (protocol 17) a pen with the count of pending comments on each image, which
 * opens the markup overlay. Removing an image that has pending comments asks first and takes them along.
 */
export function ComposerAttachments({ pending }: { pending: PendingThumb[] }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const images = useAppSelector(selectImages);
  const all = useAppSelector(selectComments);
  const offered = useAppSelector((s) => s.controls.protocol >= ATTACHMENT_MARKUP_PROTOCOL);
  const marking = useAppSelector(selectMarking);
  const [asking, setAsking] = useState<string | null>(null);
  // pending only: a comment already sent belongs to the message it went with
  const onImage = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const c of all) if (c.status === 'pending' && isAttachmentAnchor(c.anchor)) (m[c.anchor.image] ??= []).push(c.id);
    return m;
  }, [all]);
  const counts = useMemo(() => Object.fromEntries(Object.entries(onImage).map(([k, v]) => [k, v.length])), [onImage]);
  const remove = (id: string) => {
    for (const cid of onImage[id] ?? []) dispatch(removeComment(cid));
    dispatch(removeImage(id));
  };
  // the overlay belongs to an image still in the composer
  const open = marking !== null && images.some((i) => i.id === marking) ? marking : null;
  // closing hands the focus back to the image's pen (the composer's field when the image is gone)
  const closeMarkup = (id: string) => {
    dispatch(markAttachment(null));
    requestAnimationFrame(() => {
      const pen = [...document.querySelectorAll<HTMLElement>('[data-mark-for]')].find((e) => e.dataset.markFor === id);
      (pen ?? document.getElementById('composer-input'))?.focus();
    });
  };
  return (
    <>
      <Attachments
        data-testid="composer-thumbs"
        ids={images.map((i) => i.id)}
        pending={pending}
        onRemove={(id) => (onImage[id]?.length ? setAsking(id) : void dispatch(removeImage(id)))}
        onMark={offered ? (id) => void dispatch(markAttachment(id)) : undefined}
        counts={counts}
      />
      {open && <AttachmentMarkup key={open} id={open} onClose={() => closeMarkup(open)} />}
      {asking && (
        <ConfirmDialog
          title={t('attachRemoveTitle')}
          body={t('attachRemoveWithComments', onImage[asking]?.length ?? 0)}
          confirm={t('remove')}
          onConfirm={() => { remove(asking); setAsking(null); }}
          onCancel={() => setAsking(null)}
        />
      )}
    </>
  );
}
