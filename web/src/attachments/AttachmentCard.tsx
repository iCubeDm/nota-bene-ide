import { isAttachmentAnchor } from '@nota-bene/shared';
import { connections, routes, useAppDispatch, useAppSelector, useT, type AnchorView } from '@/sdk';
import { addImage, markAttachment, selectImages } from '@/composer/slice.ts';
import { mediaTypeOf } from './image.ts';

/**
 * A mark on an attached image (protocol 17), on its comment's card: the image, and while it is no longer in the composer
 * (detached: the comment stays pending and is never sent) a way to attach it again. Only an attached one is shown.
 */
export const AttachmentCard: NonNullable<AnchorView['Card']> = ({ comment: c, jump }) => {
  const t = useT();
  const dispatch = useAppDispatch();
  const a = isAttachmentAnchor(c.anchor) ? c.anchor : null;
  const attached = useAppSelector((s) => !!a && selectImages(s).some((im) => im.id === a.image));
  if (!a) return null;
  const go = attached ? jump : undefined;
  return (
    <div
      data-media-thumb
      onClick={go}
      className={`flex items-end gap-2 border-l-2 border-nb-accent pl-2 text-xs text-muted-foreground ${go ? 'cursor-pointer' : ''}`}
    >
      {c.images?.[0] && <img src={connections.current().url(routes.attach(c.images[0]))} alt="" loading="lazy" draggable={false} className="max-h-24 max-w-[60%] flex-none rounded border border-border-soft object-contain" />}
      {c.status !== 'sent' && !attached && (
        <span className="flex min-w-0 flex-col items-start gap-1">
          <span data-detached className="rounded bg-warn/15 px-1 text-[0.6875rem] text-warn">{t('attachDetached')}</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); dispatch(addImage({ id: a.image, mediaType: mediaTypeOf(a.image) })); }}
            className="rounded px-1 text-[0.6875rem] text-nb-accent hover:bg-muted"
          >
            {t('attachReattach')}
          </button>
        </span>
      )}
    </div>
  );
};

/** The markup of its image, while the image is in the composer. */
export const revealAttachment: NonNullable<AnchorView['reveal']> = (c) => (d, getState) => {
  const a = c.anchor;
  if (isAttachmentAnchor(a) && selectImages(getState()).some((im) => im.id === a.image)) d(markAttachment(a.image));
};
