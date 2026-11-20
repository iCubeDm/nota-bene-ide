import { useEffect, useRef, useState } from 'react';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { has, isCutAnchor, isMediaAnchor, isPageAnchor } from '@nota-bene/shared';
import { isCutPath } from '@nota-bene/shared/cut';
import { CutBody } from '@/cut/CutBody.tsx';
import { editable as isEditable, revealRangeSideways, scrollRangeIntoView, rangeForAnchor, useT, withKey, useAppDispatch, useAppSelector } from '@/sdk';
import { flashRange } from '@/comments/HighlightLayer.tsx';
import { selectComments } from '@/comments/slice.ts';
import { seekAndPause } from '@/media/mediaController.ts';
import { selectDraft } from '@/media/markup/slice.ts';
import { fileTabId } from '@/tabs/slice.ts';
import { fileUrl, HTML, kindOf } from './kinds.ts';
import { tmpImageUrl, isTmpTabPath } from './tmpImages.ts';
import { isFixed, sourcesKnown, useSources } from './sources.ts';
import { SourceChip } from './SourcePicker.tsx';
import { clearJump, selectJump } from './slice.ts';
import { HIGHLIGHT_MAX } from './view/CodeText.tsx';
import { FileEditor, hasDraft } from './view/FileEditor.tsx';
import { HtmlBody } from './view/HtmlBody.tsx';
import { MediaBody } from './view/MediaBody.tsx';
import { TextBody } from './view/TextBody.tsx';
import { useFileLoad } from './view/useFileLoad.ts';
import { useTmpImage } from './view/useTmpImage.ts';
import { useWrapLines, wrapLines } from './wrap.ts';
import { useMediaMarkup } from './view/useMediaMarkup.ts';

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/**
 * One open file. `src`/`refName`: another source (a worktree or a branch; M3-16), shown read-only with a chip. A branch
 * view does not reload after a turn (it only changes with a commit); a worktree view does, like this folder's.
 */
export function FileView({ path, active, src = 'here', refName }: { path: string; active: boolean; src?: string; refName?: string }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const kind = kindOf(path);
  // not text: no text load
  const media = kind !== 'md' && kind !== 'text';
  const markableKind = kind === 'image' || kind === 'video';
  const tabId = fileTabId(path, src);
  // an absolute path is an image of a temp folder (see tmpImages.ts): another route, fetched with the key into a blob
  const tmp = src === 'here' && kind === 'image' && isTmpTabPath(path);
  const url = tmp ? tmpImageUrl(path) : fileUrl(path, undefined, src);
  const ref = src === 'here' ? undefined : refName;
  const sources = useSources();
  const fixed = isFixed(src, sources);
  // the tab stays (nothing is dropped or rewritten); its view says the source is gone
  const srcGone = src !== 'here' && sourcesKnown() && !sources.some((x) => x.id === src);
  const [natural, setNatural] = useState(false);
  const marking = useAppSelector((s) => selectDraft(s, tabId).on);
  const markingRef = useRef(marking);
  markingRef.current = marking;
  const load = useFileLoad({ path, src, ref, url, kind, media, hasVersion: markableKind, active, fixed, marking, markingRef });
  const { data, rev, loadedRev, resumeAt } = load;
  const blob = useTmpImage(tmp ? load.mediaUrl : null);
  // until the blob arrives the image shows a 1x1 pixel, not a broken one
  const mediaUrl = tmp ? (blob.s === 'ok' ? blob.url : PIXEL) : load.mediaUrl;
  const failed = load.failed || (tmp && (blob.s === 'gone' || blob.s === 'error' || blob.s === 'big'));
  const note = tmp && blob.s === 'big' ? t('tmpImageBig') : undefined;
  const markup = useMediaMarkup({ tabId, path, ref, active, marking, mediaUrl: tmp ? load.mediaUrl : mediaUrl, mediaEl: load.mediaEl });
  const { markable } = markup;
  const wrap = useWrapLines();
  // by hand: text of this checkout; a draft left by a closed tab or a reload opens again
  const editable = src === 'here' && !fixed && !tmp && (kind === 'md' || kind === 'text');
  const [editing, setEditing] = useState(() => editable && hasDraft(path));
  // an .html file opens as the page, an edit (`*.nbcut.json`) as its timeline; ‹Source› shows its text like any other file
  const html = kind === 'text' && HTML.test(path);
  const cut = kind === 'text' && isCutPath(path);
  const [pageView, setPageView] = useState(true);
  const page = html && pageView && !editing && data?.s === 'text';
  const timeline = cut && pageView && !editing && data?.s === 'text';
  const [pageMarking, setPageMarking] = useState(false);
  const [scripts, setScripts] = useState(false);
  // an older server would refuse a comment on an element (`pageAnchors`): marking is offered from it on
  const canMark = useAppSelector((s) => has(s.controls.protocol, 'pageAnchors'));
  const marksPage = page && canMark && pageMarking;
  useEffect(() => { if (!page) setPageMarking(false); }, [page]);
  const pageMarkingNow = useRef(pageMarking);
  pageMarkingNow.current = pageMarking;
  // N marks, Esc leaves (an open comment popup takes its own Esc first)
  useEffect(() => {
    if (!active || !page || !canMark) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
      if (e.code === 'KeyN' && !e.shiftKey) {
        e.preventDefault();
        setPageMarking((v) => !v);
      } else if (e.key === 'Escape' && pageMarkingNow.current) {
        e.preventDefault();
        setPageMarking(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, page, canMark]);

  // "jump to source" (CommentCard): once this view shows fresh text and is visible, scroll to the fragment and flash it
  const jump = useAppSelector(selectJump);
  const comments = useAppSelector(selectComments);
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (jump?.path !== path || jump.src !== src || !active || !data) return;
    // a rendered page takes its own jump once it is on screen (HtmlBody); a place on the page shows the page
    if (page) return;
    const target = comments.find((x) => x.id === jump.id);
    // a comment on an edit's timeline (issue 430) is the timeline's (CutBody); any other on an edit is on its text
    if (cut && target && isCutAnchor(target.anchor)) return void (pageView || setPageView(true));
    if (timeline) return void setPageView(false);
    if (html && target && isPageAnchor(target.anchor)) return void setPageView(true);
    const fresh = loadedRev.current?.path === path && loadedRev.current.rev === rev;
    if (!fresh) return; // a stale view reloads on activation: wait for that load
    dispatch(clearJump());
    const c = comments.find((x) => x.id === jump.id);
    const el = pane.current;
    if (!c || !el || data.s !== 'text') return;
    const range = rangeForAnchor(el, c.anchor);
    if (!range) return; // orphaned: the tab is open, nothing to point at
    revealRangeSideways(range, el);
    scrollRangeIntoView(range, el);
    flashRange(el, range);
  }, [kind, jump, active, data, rev, path, src, comments, dispatch, loadedRev, page, html, timeline, cut, pageView]);

  // "jump to source" on a media tab: the tab is open and active; a video also seeks to the comment's time and pauses
  // (not while marking: the drawing belongs to the frame on screen)
  useEffect(() => {
    if (!markableKind || jump?.path !== path || jump.src !== src || !active || !markable) return;
    dispatch(clearJump());
    const c = comments.find((x) => x.id === jump.id);
    if (!c || !isMediaAnchor(c.anchor) || c.anchor.time === undefined || !(markable instanceof HTMLVideoElement) || markingRef.current) return;
    resumeAt.current = 0; // the jump's time wins over a reload's resume point
    seekAndPause(markable, c.anchor.time);
  }, [markableKind, jump, active, markable, path, src, comments, dispatch, resumeAt]);

  const large = !page && data?.s === 'text' && kind === 'text' && data.text.length > HIGHLIGHT_MAX;

  return (
    <div data-file-view hidden={!active} className="min-h-0 flex-1 flex-col [&:not([hidden])]:flex">
      <div data-anchor-skip className="flex h-8 flex-none items-center gap-2 border-b border-border-soft bg-chrome px-3 font-mono text-[0.71875rem] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{path}</span>
        {ref && <SourceChip name={ref} />}
        {large && <span>{t('noHighlight')}</span>}
        {page && scripts && <span title={t('pageScriptsOffTip')}>{t('pageScriptsOff')}</span>}
        {(html || cut) && !editing && (
          <span role="group" aria-label={t(cut ? 'cutViewTip' : 'pageViewTip')} className="flex overflow-hidden rounded border border-border-soft">
            {([true, false] as const).map((v) => (
              <button key={String(v)} type="button" aria-pressed={pageView === v}
                // the timeline saves as it edits: its JSON is read again
                onClick={() => { if (cut && !v && pageView) load.reloadClick(); setPageView(v); }}
                className={`px-1.5 hover:text-foreground ${pageView === v ? 'bg-muted text-foreground' : ''}`}>{t(v ? (cut ? 'cutTimeline' : 'pageView') : 'sourceView')}</button>
            ))}
          </span>
        )}
        {page && canMark && (
          <button type="button" aria-pressed={pageMarking} title={t('pageMarkTip')} onClick={() => setPageMarking((v) => !v)}
            className={`rounded px-1.5 hover:bg-muted hover:text-foreground ${pageMarking ? 'bg-muted text-foreground' : ''}`}>{t('pageMark')}</button>
        )}
        {kind === 'text' && !page && !timeline && (
          <button type="button" aria-label={t('wrapLines')} aria-pressed={wrap} title={withKey(t('wrapLines'), 'hk_wrap')} onClick={wrapLines.toggle}
            className={`rounded px-1.5 hover:bg-muted hover:text-foreground ${wrap ? 'text-foreground' : ''}`}>↩</button>
        )}
        {editable && !editing && data?.s === 'text' && (
          <button type="button" aria-label={t('editFile')} title={t('editFile')} onClick={() => setEditing(true)} className="rounded px-1.5 hover:bg-muted hover:text-foreground">✎</button>
        )}
        <button type="button" aria-label={t('reload')} title={t('reload')} onClick={load.reloadClick} className="rounded px-1.5 hover:bg-muted hover:text-foreground">↻</button>
        <a href={tmp ? (blob.s === 'ok' ? blob.url : undefined) : url} target="_blank" rel="noopener noreferrer" className="hover:text-foreground" aria-label={t('openRaw')} title={t('openRawTip')}><Svg size={14}>{ICONS.external}</Svg></a>
      </div>
      {media ? (
        <MediaBody
          kind={kind} path={path} fileRef={ref} tabId={tabId} active={active} marking={marking} natural={natural}
          onToggleNatural={() => setNatural((v) => !v)} mediaUrl={mediaUrl} failed={failed} srcGone={srcGone}
          onError={load.onError} note={note} onMediaMeta={load.onMediaMeta} markup={markup} mediaEl={load.mediaEl}
        />
      ) : page && data?.s === 'text' ? (
        <HtmlBody html={data.text} path={path} src={src} fileRef={ref} tabId={tabId} active={active} paneRef={pane} marking={marksPage} onScripts={setScripts} />
      ) : timeline && data?.s === 'text' ? (
        <CutBody text={data.text} src={src} path={src === 'here' ? path : undefined} tabId={tabId} active={active} />
      ) : editing ? (
        <FileEditor path={path} onClose={(saved) => { setEditing(false); if (saved) load.reloadClick(); }} />
      ) : (
        <TextBody data={data} kind={kind} path={path} src={src} fileRef={ref} tabId={tabId} active={active} url={url} paneRef={pane} />
      )}
    </div>
  );
}
