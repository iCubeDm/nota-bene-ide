import { isMediaAnchor } from '@nota-bene/shared';
import { connections, routes, mediaTime, type AnchorView } from '@/sdk';

/** A mark on a picture or a video frame, on its comment's card: the frame it was drawn on, the file and the time. */
export const MediaCard: NonNullable<AnchorView['Card']> = ({ comment: c, jump }) => {
  if (!isMediaAnchor(c.anchor)) return null;
  const media = c.anchor;
  return (
    <div
      data-media-thumb
      onClick={jump}
      className={`flex items-end gap-2 border-l-2 border-nb-accent pl-2 text-xs text-muted-foreground ${jump ? 'cursor-pointer' : ''}`}
    >
      {c.images?.[0] && <img src={connections.current().url(routes.attach(c.images[0]))} alt="" loading="lazy" draggable={false} className="max-h-24 max-w-[60%] flex-none rounded border border-border-soft object-contain" />}
      <span className="min-w-0 truncate font-mono text-[0.6875rem]">
        {media.source.path.slice(media.source.path.lastIndexOf('/') + 1)}{media.time !== undefined ? ` @ ${mediaTime(media.time)}` : ''}
      </span>
    </div>
  );
};
