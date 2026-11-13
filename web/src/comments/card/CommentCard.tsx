import { generatedImages, isAttachmentAnchor, isMediaAnchor, isPageAnchor, isTextAnchor } from '@nota-bene/shared';
import { pageQuote } from '@/page/quote.ts';
import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent } from 'react';
import { Attachments } from '@/attachments/Attachments.tsx';
import { mediaTypeOf } from '@/attachments/image.ts';
import { addImage } from '@/composer/slice.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { selectSwitching } from '@/controls/slice.ts';
import { Markdown } from '@/feed/Markdown.tsx';
import { getLang, useT } from '@/i18n/index.ts';
import { mediaTime } from '@/media/markup/geometry.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { ClipRow } from '@/voice/ClipRow.tsx';
import { CardActions } from './CardActions.tsx';
import { useCommentSource } from './useCommentSource.ts';
import { labelText, QUICK_LABELS } from '../labels.ts';
import { LabelTip } from '../LabelTip.tsx';
import { editComment, removeComment, selectComments } from '../slice.ts';

/**
 * One comment: number, where, quote (click = jump to source), text with inline edit, label chip.
 * Used in the side panel and in the popover over a mark (`popover`: the quote does not jump; `handle`: props that make
 * the number line a drag handle).
 */
export function CommentCard({ id, index, popover = false, handle }: { id: string; index: number; popover?: boolean; handle?: HTMLAttributes<HTMLElement> }) {
  const t = useT();
  const dispatch = useAppDispatch();
  // the comment set belongs to the session being left: edit and delete wait for the new one
  const switching = useAppSelector(selectSwitching);
  const c = useAppSelector(selectComments).find((x) => x.id === id);
  const { where, orphan, beforeCompact, version, attached, jump } = useCommentSource(c);
  const [editing, setEditing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const live = useRef(false); // true while an edit is open; guards double finish (✓ then blur)

  useEffect(() => {
    if (!editing || !body.current) return;
    const el = body.current;
    el.focus();
    const sel = window.getSelection();
    sel?.selectAllChildren(el);
    sel?.collapseToEnd();
  }, [editing]);

  if (!c) return null;
  const sent = c.status === 'sent';
  const media = isMediaAnchor(c.anchor) ? c.anchor : null;
  const onImage = isAttachmentAnchor(c.anchor) ? c.anchor : null;
  const changed = !!media?.version && version !== undefined && version !== media.version;
  // a media comment's leading images are generated (the frame with the shapes = the thumbnail, in old comments also the layer);
  // only the pasted ones after them go to the strip
  const strip = c.images?.slice(generatedImages(c));
  const label = c.label && QUICK_LABELS.find((l) => l.id === c.label);

  const finish = (save: boolean) => {
    if (!live.current) return;
    live.current = false;
    const next = (body.current?.textContent ?? '').trim();
    setEditing(false); // remounts the body (key), which also restores the stored text on revert
    if (save && next && next !== c.text) dispatch(editComment(c.id, next));
  };
  const start = () => {
    live.current = true;
    setEditing(true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      // handled here: neither the popover nor the document hotkeys may see this Esc
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  };
  return (
    <div
      data-comment-id={c.id}
      data-editing={editing || undefined}
      className={`rounded-[10px] border px-3 py-2.5 text-[0.8125rem] ${popover ? 'bg-popover' : 'bg-card/50'} ${editing ? 'border-primary' : 'border-border-soft hover:border-border'}`}
    >
      <div {...handle} className={`mb-1 flex items-center justify-between gap-2 font-mono text-[0.625rem] text-muted-foreground ${handle?.className ?? ''}`}>
        {/* a path has no spaces: it breaks anywhere, or the card would be as wide as the whole path (issue 367) */}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {[index >= 0 ? String(index + 1) : '', where].filter(Boolean).join(' · ')}{sent ? ` · ${t('sentTag')}` : ''}
        </span>
        {!sent && <CardActions editing={editing} switching={switching} start={start} finish={finish} remove={() => dispatch(removeComment(c.id))} />}
      </div>
      {media ? (
        <div
          data-media-thumb
          onClick={popover ? undefined : jump}
          className={`flex items-end gap-2 border-l-2 border-nb-accent pl-2 text-xs text-muted-foreground ${popover ? '' : 'cursor-pointer'}`}
        >
          {c.images?.[0] && <img src={`/attach/${c.images[0]}`} alt="" loading="lazy" draggable={false} className="max-h-24 max-w-[60%] flex-none rounded border border-border-soft object-contain" />}
          <span className="min-w-0 truncate font-mono text-[0.6875rem]">
            {media.source.path.slice(media.source.path.lastIndexOf('/') + 1)}{media.time !== undefined ? ` @ ${mediaTime(media.time)}` : ''}
          </span>
        </div>
      ) : onImage ? (
        <div
          data-media-thumb
          onClick={popover || !attached ? undefined : jump}
          className={`flex items-end gap-2 border-l-2 border-nb-accent pl-2 text-xs text-muted-foreground ${popover || !attached ? '' : 'cursor-pointer'}`}
        >
          {c.images?.[0] && <img src={`/attach/${c.images[0]}`} alt="" loading="lazy" draggable={false} className="max-h-24 max-w-[60%] flex-none rounded border border-border-soft object-contain" />}
          {!sent && !attached && (
            <span className="flex min-w-0 flex-col items-start gap-1">
              <span data-detached className="rounded bg-warn/15 px-1 text-[0.6875rem] text-warn">{t('attachDetached')}</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); dispatch(addImage({ id: onImage.image, mediaType: mediaTypeOf(onImage.image) })); }}
                className="rounded px-1 text-[0.6875rem] text-nb-accent hover:bg-muted"
              >
                {t('attachReattach')}
              </button>
            </span>
          )}
        </div>
      ) : (
        <div
          onClick={popover || beforeCompact ? undefined : jump}
          className={`line-clamp-3 border-l-2 border-nb-accent pl-2 text-xs text-muted-foreground ${popover || beforeCompact ? '' : 'cursor-pointer'}`}
        >
          {isMediaAnchor(c.anchor) || isAttachmentAnchor(c.anchor) ? null : isPageAnchor(c.anchor) ? pageQuote(c.anchor, getLang()) : isTextAnchor(c.anchor) ? c.anchor.quote : null}
        </div>
      )}
      {orphan && <div className="mt-1 text-[0.6875rem] text-destructive">({t('orphaned')})</div>}
      {changed && <div className="mt-1 text-[0.6875rem] text-warn">{t('fileChanged')}</div>}
      <div
        key={String(editing)}
        ref={body}
        contentEditable={editing ? 'plaintext-only' : undefined}
        suppressContentEditableWarning
        onKeyDown={editing ? onKeyDown : undefined}
        onBlur={editing ? () => finish(true) : undefined}
        className={`-ml-1 mt-1.5 rounded px-1 py-0.5 outline-none focus:bg-muted ${editing ? 'whitespace-pre-wrap' : 'md-tight'}`}
      >
        {/* editing shows the raw markdown source as plain text; otherwise it is rendered (not final: no refs, no mermaid) */}
        {editing ? c.text : <Markdown text={c.text} final={false} breaks noHtml />}
      </div>
      {c.voice?.length ? <div className="mt-1.5 flex flex-col gap-1">{c.voice.map((v) => <ClipRow key={v.id} voice={v} text={v.text} />)}</div> : null}
      {strip?.length ? <Attachments ids={strip} /> : null}
      {label && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              tabIndex={0}
              aria-label={labelText(label.id)}
              className="mt-1.5 inline-flex min-h-7 min-w-7 cursor-default items-center justify-center rounded-full border border-border-soft px-1.5 text-sm leading-none"
            >
              {label.emoji}
            </span>
          </TooltipTrigger>
          <LabelTip id={label.id} />
        </Tooltip>
      )}
    </div>
  );
}
