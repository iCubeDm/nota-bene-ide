import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT, connections, routes, type PendingThumb, type UserPart } from '@/sdk';

/** Full-size view. Esc / click closes; this Esc is consumed here (preventDefault + stop), so nothing else acts on it. */
function Lightbox({ id, onClose }: { id: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation(); // window capture: before any popup / composer / card handler
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      data-anchor-skip
      data-lightbox
      onClick={onClose}
      className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-scrim/80"
    >
      <img src={connections.current().url(routes.attach(id))} alt="" className="max-h-[92vh] max-w-[92vw] rounded-lg object-contain" />
    </div>,
    document.body,
  );
}

/**
 * A strip of thumbnails. `ids` are the uploaded images (lazy `/attach/<id>`), `pending` are uploads in flight (object URLs,
 * dimmed). With `onRemove` each uploaded thumbnail has a ×. The strip is not anchor text.
 */
export function Attachments({ ids, pending = [], onRemove, onMark, onCancel, counts, ...rest }: {
  ids: string[];
  pending?: PendingThumb[];
  /** with it each file upload in flight has a × that cancels it (issue 461) */
  onCancel?: (key: string) => void;
  onRemove?: (id: string) => void;
  /** with it each uploaded thumbnail has a pen that opens its markup; `counts`: the pending comments on each image (a badge) */
  onMark?: (id: string) => void;
  counts?: Record<string, number>;
} & React.HTMLAttributes<HTMLDivElement>) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  if (!ids.length && !pending.length) return null;
  return (
    <div data-anchor-skip className="flex flex-wrap gap-1.5 pt-1.5" {...rest}>
      {ids.map((id) => (
        <div key={id} className="relative">
          <img
            src={connections.current().url(routes.attach(id))}
            loading="lazy"
            alt=""
            onClick={() => setOpen(id)}
            className="size-14 cursor-zoom-in rounded-md border border-border-soft object-cover"
          />
          {onRemove && (
            <button
              type="button"
              title={t('remove')}
              aria-label={t('remove')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(id);
              }}
              className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-background text-[0.625rem] leading-none text-muted-foreground ring-1 ring-border hover:text-destructive"
            >
              ×
            </button>
          )}
          {onMark && (
            <button
              type="button"
              data-mark-for={id}
              title={t('markAttachmentN', counts?.[id] ?? 0)}
              aria-label={t('markAttachmentN', counts?.[id] ?? 0)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onMark(id);
              }}
              className="absolute -right-1.5 -bottom-1.5 flex h-4 min-w-4 items-center justify-center gap-px rounded-full bg-background px-0.5 text-[0.625rem] leading-none text-muted-foreground ring-1 ring-border hover:text-nb-accent"
            >
              <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width={9} height={9}><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
              {!!counts?.[id] && <span data-count>{counts[id]}</span>}
            </button>
          )}
        </div>
      ))}
      {pending.map((p) => (p.url !== undefined
        ? <img key={p.key} src={p.url} alt="" data-pending className="size-14 animate-pulse rounded-md border border-border-soft object-cover opacity-50" />
        : (
          <div key={p.key} data-pending-file className="relative">
            <span title={p.name} className="flex h-14 max-w-48 animate-pulse items-center truncate rounded-md border border-border-soft px-2 text-xs text-muted-foreground">{p.name}</span>
            {onCancel && (
              <button
                type="button"
                title={t('uploadCancel', p.name ?? '')}
                aria-label={t('uploadCancel', p.name ?? '')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.stopPropagation(); onCancel(p.key); }}
                className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-background text-[0.625rem] leading-none text-muted-foreground ring-1 ring-border hover:text-destructive"
              >
                ×
              </button>
            )}
          </div>
        )
      ))}
      {open && <Lightbox id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** The images a user message carried (issue 511). */
export function ImagesPart({ item }: Parameters<UserPart['render']>[0]) {
  return item.images ? <Attachments ids={item.images.map((i) => i.id)} /> : null;
}
