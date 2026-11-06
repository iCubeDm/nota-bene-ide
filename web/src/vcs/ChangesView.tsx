import { useMemo } from 'react';
import type { VcsFile } from '@nota-bene/shared';
import { HighlightLayer } from '@/comments/HighlightLayer.tsx';
import { refOf } from '@/files/sources.ts';
import { useT } from '@/i18n/index.ts';
import { FileDiff, type DiffFile } from './DiffBody.tsx';
import { parsePatch } from './parse.ts';
import { currentFile, focusFile, setSplit, usePatch, useVcsUi, type RepoDiff } from './store.ts';
import { useLiveDiff } from './useLiveDiff.ts';

export function SplitToggle({ split }: { split: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-none overflow-hidden rounded-md border border-border-soft text-[0.6875rem]">
      <button type="button" aria-pressed={!split} onClick={() => setSplit(false)} className={`px-2 py-0.5 ${split ? 'text-muted-foreground' : 'bg-primary/15 text-link'}`}>{t('vcsOneColumn')}</button>
      <button type="button" aria-pressed={split} onClick={() => setSplit(true)} className={`px-2 py-0.5 ${split ? 'bg-primary/15 text-link' : 'text-muted-foreground'}`}>{t('vcsTwoColumns')}</button>
    </div>
  );
}

function baseLine(d: RepoDiff, t: ReturnType<typeof useT>): string {
  const name = d.branch ?? 'HEAD';
  if (d.uncommitted) return t('vcsOnlyUncommitted', name);
  if (!d.base) return name;
  return [`${name} ${t('vcsAgainst', d.base)}`, ...(d.mergeBase ? [t('vcsFrom', d.mergeBase)] : [])].join(' · ');
}

/** The row with its parsed patch; the row, not the patch, names the file. */
export const viewOf = (row: VcsFile, patch: string): DiffFile => {
  const p = parsePatch(patch);
  return { ...row, ...p, binary: row.binary || p.binary };
};

const arrow = 'grid size-6 place-items-center rounded border border-border-soft text-muted-foreground enabled:hover:bg-muted disabled:opacity-40';

/** The current diff, ONE file at a time: the panel picks it, and a large diff stays as light as a small one. */
export function ChangesView({ active }: { active: boolean }) {
  const t = useT();
  const { src, base, data } = useLiveDiff(active);
  const ui = useVcsUi();
  const repo = data?.repo ? data : null;
  const files = repo?.files ?? [];
  const cur = currentFile(files, ui.focus?.path);
  const at = cur ? files.indexOf(cur) : -1;
  const url = cur ? `/vcs-file?${new URLSearchParams({ src, path: cur.path, ...(base ? { base } : {}), ...(cur.old ? { old: cur.old } : {}) })}` : null;
  const got = usePatch(url, active);
  const view = useMemo(() => (cur && got && (got.patch || !got.failed) ? viewOf(cur, got.patch) : null), [cur?.path, got]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = refOf(src);
  const mark = useMemo(() => (view ? { path: view.path, ...(ref ? { ref } : {}) } : null), [view?.path, ref]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div data-pane="changes" data-file-ref={ref} hidden={!active} className="grid-pane relative min-h-0 flex-1 overflow-auto">
      <div className="flex h-9 items-center gap-3 px-4 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono text-[0.71875rem]">{repo ? baseLine(repo, t) : data && t('vcsNoRepo')}</span>
        <span className="flex-1" />
        {files.length > 1 && (
          <span className="flex flex-none items-center gap-1.5 font-mono text-[0.6875rem]">
            <button type="button" aria-label={t('vcsPrevFile')} className={arrow} disabled={at <= 0} onClick={() => focusFile(files[at - 1]!.path)}>‹</button>
            {t('vcsNofM', at + 1, files.length)}
            <button type="button" aria-label={t('vcsNextFile')} className={arrow} disabled={at >= files.length - 1} onClick={() => focusFile(files[at + 1]!.path)}>›</button>
          </span>
        )}
        <SplitToggle split={ui.split} />
      </div>
      <div className="px-4 pb-6">
        {(ui.failed || got?.failed) && <p role="alert" className="mb-2 text-xs text-warn">{t('vcsFailed')}</p>}
        {repo?.unrelated && repo.base && <p role="alert" className="mb-2 text-xs text-warn">{t('vcsUnrelated', repo.base)}</p>}
        {repo && !files.length && !repo.unrelated && <div className="nb-card m-0! p-6 text-center text-sm text-muted-foreground">{t('vcsNoChanges')}</div>}
        {repo?.truncated && <p role="alert" className="mb-2 text-xs text-warn">{t('vcsCut', files.length)}</p>}
        {got?.truncated && <p role="alert" className="mb-2 text-xs text-warn">{t('vcsTooBig')}</p>}
        {view && <FileDiff key={view.path} f={view} split={ui.split} src={src} gitRef={ref} canOpen />}
      </div>
      <HighlightLayer pane="changes" diff={mark} content={got} />
    </div>
  );
}
