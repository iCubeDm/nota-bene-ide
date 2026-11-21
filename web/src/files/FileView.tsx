import { ICONS, Svg } from '@/sdk/ui';
import { useEffect, useRef, useState } from 'react';
import { isTextAnchor } from '@nota-bene/shared';
import { revealRangeSideways, scrollRangeIntoView, rangeForAnchor, useT, withKey, useAppDispatch, useAppSelector, useRegistry, clearJump, selectJump, fileTabId, type TabView, fileUrl, kindOf, tmpImageUrl, isTmpTabPath, fileKey, isFixed, sourcesKnown, useSources } from '@/sdk';
import { flashRange } from '@/comments/HighlightLayer.tsx';
import { selectComments, selectPendingCountByPath } from '@/comments/slice.ts';
import { FileIcon } from './FileIcon.tsx';
import { selectFileLabels } from './fileLabels.ts';
import { SourceChip } from './SourcePicker.tsx';
import { HIGHLIGHT_MAX } from './view/CodeText.tsx';
import { FileEditor, hasDraft } from './view/FileEditor.tsx';
import { TextBody } from './view/TextBody.tsx';
import { useFileLoad } from './view/useFileLoad.ts';
import { useTmpImage } from './view/useTmpImage.ts';
import { useWrapLines, wrapLines } from './wrap.ts';

const basename = (p: string) => p.split('/').pop() || p;
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Its pending comments' count, on its tab. */
function FileBadge({ path, fileRef }: { path: string; fileRef?: string }) {
  const n = useAppSelector((s) => selectPendingCountByPath(s)[fileKey(path, fileRef)] ?? 0);
  return n > 0 ? <span data-badge className="rounded-full bg-nb-accent/[.18] px-1.5 text-[0.625rem] font-semibold leading-4 text-nb-accent">{n}</span> : null;
}

/** A file's tab: named as IntelliJ names it (fileLabels), its source's chip, its pending comments; another root, another view. */
export const fileTab: TabView<'file'> = {
  kind: 'file',
  label: (tab, _t, s) => selectFileLabels(s).get(tab.path) ?? basename(tab.path),
  Icon: ({ tab }) => <FileIcon path={tab.path} />,
  Extra: ({ tab }) => (
    <>
      {tab.ref && <SourceChip name={tab.ref} />}
      <FileBadge path={tab.path} fileRef={tab.ref} />
    </>
  ),
  detail: (tab) => `${dirOf(tab.path)}${tab.ref ? ` @ ${tab.ref}` : ''}`,
  render: ({ tab, active, rootGen }) => <FileView key={rootGen} path={tab.path} src={tab.src} refName={tab.ref} active={active} />,
};

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/**
 * One open file, shown by the first file view that matches it (issue 511), or as its text. `src`/`refName`: another
 * source (a worktree or a branch; M3-16), shown read-only with a chip. A branch view does not reload after a turn (it
 * only changes with a commit); a worktree view does, like this folder's.
 */
export function FileView({ path, active, src = 'here', refName }: { path: string; active: boolean; src?: string; refName?: string }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const kind = kindOf(path);
  const { fileViews, commands } = useRegistry();
  const view = fileViews.find((v) => v.match(path, kind));
  // a media view loads no text; a text view (a page, an edit's timeline) shows beside the text, its ‹Source›
  const media = view?.media ? view : undefined;
  const textView = view && !view.media ? view : undefined;
  const tabId = fileTabId(path, src);
  // an absolute path is an image of a temp folder (see tmpImages.ts): another route, fetched with the key into a blob
  const tmp = src === 'here' && kind === 'image' && isTmpTabPath(path);
  const url = tmp ? tmpImageUrl(path) : fileUrl(path, undefined, src);
  const ref = src === 'here' ? undefined : refName;
  const sources = useSources();
  const fixed = isFixed(src, sources);
  // the tab stays (nothing is dropped or rewritten); its view says the source is gone
  const srcGone = src !== 'here' && sourcesKnown() && !sources.some((x) => x.id === src);
  const marking = useAppSelector((s) => media?.holds?.(s, tabId) ?? false);
  const markingRef = useRef(marking);
  markingRef.current = marking;
  const load = useFileLoad({ path, src, ref, url, kind, media: !!media, hasVersion: !!media, active, fixed, marking, markingRef });
  const { data, rev, loadedRev } = load;
  const blob = useTmpImage(tmp ? load.mediaUrl : null);
  const wrap = useWrapLines();
  // by hand: text of this checkout; a draft left by a closed tab or a reload opens again
  const editable = src === 'here' && !fixed && !tmp && (kind === 'md' || kind === 'text');
  const [editing, setEditing] = useState(() => editable && hasDraft(path));
  // ‹View | Source›: the view by default; ‹Source› shows its text like any other file's
  const [pageView, setPageView] = useState(true);
  const shown = textView && pageView && !editing && data?.s === 'text' ? textView : undefined;
  // where the text view's own controls go in the header (a portal target each: state, so the view renders once they exist)
  const [before, setBefore] = useState<HTMLElement | null>(null);
  const [after, setAfter] = useState<HTMLElement | null>(null);

  // "jump to source" (CommentCard): once this view shows fresh text and is visible, scroll to the fragment and flash it.
  // A view on screen takes its own jumps; one it does not show is on the text. A comment only the view shows shows it.
  const jump = useAppSelector(selectJump);
  const comments = useAppSelector(selectComments);
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (media || jump?.path !== path || jump.src !== src || !active || !data) return;
    const target = comments.find((x) => x.id === jump.id);
    if (shown) return void (target && !shown.jump?.(target) && setPageView(false));
    if (textView && target && textView.jump?.(target) && !isTextAnchor(target.anchor)) return void (pageView || setPageView(true));
    const fresh = loadedRev.current?.path === path && loadedRev.current.rev === rev;
    if (!fresh) return; // a stale view reloads on activation: wait for that load
    dispatch(clearJump());
    const el = pane.current;
    if (!target || !el || data.s !== 'text') return;
    const range = rangeForAnchor(el, target.anchor);
    if (!range) return; // orphaned: the tab is open, nothing to point at
    revealRangeSideways(range, el);
    scrollRangeIntoView(range, el);
    flashRange(el, range);
  }, [media, jump, active, data, rev, path, src, comments, dispatch, loadedRev, shown, textView, pageView]);

  const large = !shown && data?.s === 'text' && kind === 'text' && data.text.length > HIGHLIGHT_MAX;

  return (
    <div data-file-view hidden={!active} className="min-h-0 flex-1 flex-col [&:not([hidden])]:flex">
      <div data-anchor-skip className="flex h-8 flex-none items-center gap-2 border-b border-border-soft bg-chrome px-3 font-mono text-[0.71875rem] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{path}</span>
        {ref && <SourceChip name={ref} />}
        {large && <span>{t('noHighlight')}</span>}
        {textView && <span ref={setBefore} className="contents" />}
        {textView && !editing && (
          <span role="group" aria-label={t(textView.tip)} className="flex overflow-hidden rounded border border-border-soft">
            {([true, false] as const).map((v) => (
              <button key={String(v)} type="button" aria-pressed={pageView === v}
                // a view that saves as it edits: its text is read again
                onClick={() => { if (textView.writes && !v && pageView) load.reloadClick(); setPageView(v); }}
                className={`px-1.5 hover:text-foreground ${pageView === v ? 'bg-muted text-foreground' : ''}`}>{t(v ? textView.label : 'sourceView')}</button>
            ))}
          </span>
        )}
        {textView && <span ref={setAfter} className="contents" />}
        {kind === 'text' && !shown && (
          <button type="button" aria-label={t('wrapLines')} aria-pressed={wrap} title={withKey(commands, t('wrapLines'), 'hk_wrap')} onClick={wrapLines.toggle}
            className={`rounded px-1.5 hover:bg-muted hover:text-foreground ${wrap ? 'text-foreground' : ''}`}>↩</button>
        )}
        {editable && !editing && data?.s === 'text' && (
          <button type="button" aria-label={t('editFile')} title={t('editFile')} onClick={() => setEditing(true)} className="rounded px-1.5 hover:bg-muted hover:text-foreground">✎</button>
        )}
        <button type="button" aria-label={t('reload')} title={t('reload')} onClick={load.reloadClick} className="rounded px-1.5 hover:bg-muted hover:text-foreground">↻</button>
        <a href={tmp ? (blob.s === 'ok' ? blob.url : undefined) : url} target="_blank" rel="noopener noreferrer" className="hover:text-foreground" aria-label={t('openRaw')} title={t('openRawTip')}><Svg size={14}>{ICONS.external}</Svg></a>
      </div>
      {media ? (
        <media.render
          kind={kind} path={path} src={src} fileRef={ref} tabId={tabId} active={active}
          media={{
            // until a temp image's blob arrives it shows a 1x1 pixel, not a broken one
            url: tmp ? (blob.s === 'ok' ? blob.url : PIXEL) : load.mediaUrl, head: load.mediaUrl,
            failed: load.failed || (tmp && (blob.s === 'gone' || blob.s === 'error' || blob.s === 'big')), srcGone,
            note: tmp && blob.s === 'big' ? t('tmpImageBig') : undefined,
            onError: load.onError, onMeta: load.onMediaMeta, el: load.mediaEl, resumeAt: load.resumeAt,
          }}
        />
      ) : shown && data?.s === 'text' ? (
        <shown.render path={path} src={src} fileRef={ref} tabId={tabId} active={active} text={data.text} bar={{ before, after }} />
      ) : editing ? (
        <FileEditor path={path} onClose={(saved) => { setEditing(false); if (saved) load.reloadClick(); }} />
      ) : (
        <TextBody data={data} kind={kind} path={path} src={src} fileRef={ref} tabId={tabId} active={active} url={url} paneRef={pane} />
      )}
    </div>
  );
}
