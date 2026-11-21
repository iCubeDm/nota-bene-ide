import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isMediaAnchor } from '@nota-bene/shared';
import { useT, useAppDispatch, useAppSelector, clearJump, selectJump, seekAndPause, type MediaFileView, useComments } from '@/sdk';
import { applyPlayerKey, usePlayerKeys } from './playerKeys.ts';
import { PlayerBar } from './PlayerBar.tsx';
import { PlayerFlash } from './PlayerFlash.tsx';
import { MarkupLayer } from './markup/MarkupLayer.tsx';
import { MediaMarks } from './markup/MediaMarks.tsx';
import { selectDraft } from './markup/slice.ts';
import { useMediaMarkup } from './useMediaMarkup.ts';

/** The pane of an image, video or audio file (or its "gone" note), with the markup layers over an image or video. */
export const MediaBody: MediaFileView['render'] = ({ kind, path, src, fileRef, tabId, active, media: load }) => {
  const { CommentPopup, selectComments } = useComments();
  const t = useT();
  const dispatch = useAppDispatch();
  const { url: mediaUrl, failed, srcGone, note, onError, onMeta: onMediaMeta, el: mediaEl, resumeAt } = load;
  const [natural, setNatural] = useState(false);
  const onToggleNatural = () => setNatural((v) => !v);
  const marking = useAppSelector((s) => selectDraft(s, tabId).on);
  const markingRef = useRef(marking);
  markingRef.current = marking;
  const markup = useMediaMarkup({ tabId, path, ref: fileRef, active, marking, mediaUrl: load.head, mediaEl });
  const { markable, player, mediaRef, imgRef, markPopup } = markup;

  // "jump to source": the tab is open and active; a video also seeks to the comment's time and pauses (not while
  // marking: the drawing belongs to the frame on screen)
  const jump = useAppSelector(selectJump);
  const comments = useAppSelector(selectComments);
  const markableKind = kind === 'image' || kind === 'video';
  useEffect(() => {
    if (!markableKind || jump?.path !== path || jump.src !== src || !active || !markable) return;
    dispatch(clearJump());
    const c = comments.find((x) => x.id === jump.id);
    if (!c || !isMediaAnchor(c.anchor) || c.anchor.time === undefined || !(markable instanceof HTMLVideoElement) || markingRef.current) return;
    resumeAt.current = 0; // the jump's time wins over a reload's resume point
    seekAndPause(markable, c.anchor.time);
  }, [markableKind, jump, active, markable, path, src, comments, dispatch, resumeAt]);

  // the player container: what F fullscreens, so the marks and the bar come along
  const box = useRef<HTMLDivElement>(null);
  const flash = usePlayerKeys({ tabId, active, marking, media: mediaEl, image: kind === 'image' ? markable as HTMLImageElement | null : null, box });
  const unit = t('unitSec');
  let body;
  if (failed || srcGone) {
    body = (
      <div data-pane={tabId} hidden={!active} className="grid-pane relative min-h-0 flex-1 overflow-auto">
        {srcGone
          ? <p data-source-gone className="p-4 text-sm text-muted-foreground">{t('sourceGone')}</p>
          : <p className="p-4 text-sm text-muted-foreground">{note ?? t('fileGone')}</p>}
      </div>
    );
  } else if (kind === 'image') {
    body = (
      // M3-13 relies on data-pane as the pane's scroll container; data-file-path (text/md only) marks the text root
      <div data-pane={tabId} hidden={!active} className={`grid-pane nb-media-pane relative min-h-0 flex-1 overflow-auto${natural ? ' nb-natural' : ''}`}>
        <img
          ref={imgRef}
          src={mediaUrl}
          alt={path}
          onError={onError}
          onClick={() => marking || onToggleNatural()}
          className={`nb-fit ${marking ? '' : natural ? 'cursor-zoom-out' : 'cursor-zoom-in'}`}
        />
      </div>
    );
  } else {
    body = (
      <div data-pane={tabId} hidden={!active} className={`grid-pane nb-media-pane relative min-h-0 flex-1 overflow-auto`}>
        {/* no native controls (PlayerBar is ours); while marking up the bar is gone too: the frame stays still */}
        {kind === 'video' ? (
          <video
            ref={mediaRef} preload="metadata" src={mediaUrl} onError={onError} onLoadedMetadata={onMediaMeta} data-media-tab={tabId} className="nb-fit"
            // a click on a mark never gets here (the mark is another element and stops its own click)
            onClick={(e) => marking || applyPlayerKey(e.currentTarget, 'KeyK', unit)}
            onDoubleClick={(e) => marking || applyPlayerKey(e.currentTarget, 'KeyF', unit, box.current)}
          />
        ) : (
          <>
            <audio ref={mediaRef} preload="metadata" src={mediaUrl} onError={onError} onLoadedMetadata={onMediaMeta} data-media-tab={tabId} />
            {player && <PlayerBar media={player} box={box} tabId={tabId} path={path} refName={fileRef} flash={flash} />}
          </>
        )}
      </div>
    );
  }
  if (!((kind === 'image' || kind === 'video') && !failed && !srcGone)) {
    return kind === 'audio' && !failed && !srcGone ? <div ref={box} className="relative flex min-h-0 flex-1 flex-col">{body}<PlayerFlash flash={flash} /></div> : body;
  }
  const fit = kind === 'image' && natural ? 'natural' : 'contain';
  return (
    // the toolbar sits over the pane but outside its scroll, so it stays in the corner in natural size
    <div ref={box} className="relative flex min-h-0 flex-1 flex-col bg-background">
      {body}
      <PlayerFlash flash={flash} />
      {markable && <MediaMarks tabId={tabId} media={markable} fit={fit} path={path} refName={fileRef} />}
      {markable && <MarkupLayer tabId={tabId} media={markable} fit={fit} onAdd={markup.onMarkAdd} held={!!markPopup} saving={markup.saving} />}
      {kind === 'video' && player && !marking && <PlayerBar media={player} box={box} tabId={tabId} path={path} refName={fileRef} flash={flash} />}
      {/* portalled with its own layer: above the markup toolbar, which it may open next to */}
      {markPopup && createPortal(
        <div className="relative z-30" hidden={!active}>
          {/* keyed: a new drawing's popup is a new popup, never the old one (and its save) re-rendered */}
          <CommentPopup
            key={markPopup.id}
            pending={markPopup}
            onClose={markup.closeMarkPopup}
            onAdded={() => markup.markAdded(isMediaAnchor(markPopup.anchor) ? markPopup.anchor.shapes : [])}
            onBusy={markup.onPopupBusy}
            hidden={!active}
          />
        </div>,
        document.body,
      )}
    </div>
  );
};
