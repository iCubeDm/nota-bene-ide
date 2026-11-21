import { useEffect, useMemo, useState } from 'react';
import type { VcsCommitDetail, VcsLog } from '@nota-bene/shared';
import { HighlightLayer } from '@/comments/HighlightLayer.tsx';
import { useT, defineResource, routes, useResource, useAppDispatch, useAppSelector } from '@/sdk';
import { PanelResizer, usePanelWidth } from '@/sdk/ui';
import { pickSource, selectRefreshSeq, selectTree } from '@/files/treeSlice.ts';
import { useSources } from '@/files/sources.ts';
import { FileDiff, StatusMark } from './DiffBody.tsx';
import { SplitToggle, viewOf } from './ChangesView.tsx';
import { layout, COLORS, STEP, ROW } from './graph.ts';
import { currentFile, usePatch, useVcsUi } from './store.ts';

const when = (s: number) => new Date(s * 1000).toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const refName = (r: string) => r.replace('HEAD -> ', '').replace('tag: ', '');

const logResource = defineResource<{ src: string; all: boolean }, VcsLog>({ key: (a) => `${a.src}\0${a.all}`, route: (a) => routes.vcsLog(a.src, a.all), every: 6_000 });
const commitResource = defineResource<string, VcsCommitDetail>({ key: (sha) => sha, route: routes.vcsCommit });

function Lanes({ r, width }: { r: ReturnType<typeof layout>[number]; width: number }) {
  const x = (i: number) => i * STEP + STEP / 2;
  const mid = ROW / 2;
  return (
    <svg width={width} height={ROW} className="flex-none">
      {r.up.map(([a, b], i) => <path key={`u${i}`} d={`M${x(a)} 0 C${x(a)} ${mid / 2} ${x(b)} ${mid / 2} ${x(b)} ${mid}`} fill="none" style={{ stroke: COLORS[a % COLORS.length] }} strokeWidth="1.5" />)}
      {r.down.map(([a, b], i) => <path key={`d${i}`} d={`M${x(a)} ${mid} C${x(a)} ${mid * 1.5} ${x(b)} ${mid * 1.5} ${x(b)} ${ROW}`} fill="none" style={{ stroke: COLORS[b % COLORS.length] }} strokeWidth="1.5" />)}
      <circle cx={x(r.col)} cy={mid} r="3.5" style={{ fill: COLORS[r.col % COLORS.length] }} />
    </svg>
  );
}

/** The commit graph on top, the picked commit's diff under it. */
export function LogView({ active }: { active: boolean }) {
  const t = useT();
  const d = useAppDispatch();
  const { src } = useAppSelector(selectTree);
  const turn = useAppSelector(selectRefreshSeq);
  const { split, commit } = useVcsUi();
  const sources = useSources();
  const [all, setAll] = useState(true);
  const [sha, setSha] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [pick, setPick] = useState<string | undefined>();
  // another source's graph is never shown under this one's name
  const logGot = useResource(logResource, { src, all }, { on: active, refreshOn: turn });
  const commitGot = useResource(commitResource, sha);
  const log = logGot.data;
  const detail = commitGot.data;
  const failed = logGot.failed || commitGot.failed;
  // a comment on a commit asked for it
  useEffect(() => {
    if (!commit) return;
    setSha(commit.sha);
    setPick(commit.path);
  }, [commit]);
  const q = filter.trim().toLowerCase();
  const rows = useMemo(() => layout(log?.commits ?? []), [log]);
  const width = Math.max(...rows.map((r) => r.width), 1) * STEP;
  const side = usePanelWidth('panel:commit:width', 256, 180);
  const files = detail?.files ?? [];
  const cur = currentFile(files, pick);
  const url = detail && cur ? routes.vcsCommitFile(detail.sha, cur.path, cur.old) : null;
  const got = usePatch(url, active, 0);
  const view = useMemo(() => (cur && got && (got.patch || !got.failed) ? viewOf(cur, got.patch) : null), [cur?.path, got]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = detail?.sha.slice(0, 7);
  const mark = useMemo(() => (view && ref ? { path: view.path, ref } : null), [view?.path, ref]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickCommit = (next: string | null) => { setPick(undefined); setSha(next); };
  const picked = (s: string) => !!sha && s.startsWith(sha);
  const srcOfRef = (name: string) => sources.find((s) => s.ref === name || (s.id === 'here' && s.ref === name))?.id;
  return (
    <div data-pane="log" data-file-ref={ref} hidden={!active} className="grid-pane relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-9 flex-none items-center gap-3 px-4 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t('vcsAllBranches')}</label>
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('vcsFilterCommits')} aria-label={t('vcsFilterCommitsLabel')} className="h-[26px] w-56 rounded-md border border-transparent bg-muted/50 px-2 text-[0.75rem] text-foreground outline-0 focus:border-input-focus-soft focus:ring-2 focus:ring-input-ring" />
        {log?.more && <span>{t('vcsLogCut', log.commits.length)}</span>}
        {(failed || got?.failed) && <span role="alert" className="text-warn">{t('vcsFailed')}</span>}
        <span className="flex-1" />
        <SplitToggle split={split} />
      </div>
      <div className={`nb-card mx-4! mt-0! mb-3! ${sha ? 'h-[45%] flex-none' : 'flex-1'} nb-thin min-h-0 overflow-auto px-2`}>
        {log && !log.repo && <p className="p-3 text-xs text-muted-foreground">{t('vcsNoRepo')}</p>}
        {log?.repo && !log.commits.length && <p className="p-3 text-xs text-muted-foreground">{t('vcsNoCommits')}</p>}
        {log?.commits.map((c, i) => {
          const hit = !q || c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.sha.startsWith(q);
          return (
            <button key={c.sha} type="button" onClick={() => pickCommit(picked(c.sha) ? null : c.sha)} className={`flex w-full items-center gap-2 pr-2 text-left text-[0.78125rem] hover:bg-muted ${picked(c.sha) ? 'bg-primary/15' : ''} ${hit ? '' : 'opacity-25'}`} style={{ height: ROW }}>
              <Lanes r={rows[i]!} width={width} />
              {c.refs.filter((x) => !x.endsWith('/HEAD')).map((x) => {
                const id = srcOfRef(refName(x));
                return <span key={x} role={id ? 'link' : undefined} title={id ? undefined : x} onClick={id ? (e) => { e.stopPropagation(); d(pickSource(id)); } : undefined} className={`flex-none rounded px-1 font-mono text-[0.65625rem] leading-4 ${x.startsWith('HEAD') ? 'bg-nb-accent/20 text-nb-accent' : x.startsWith('tag:') ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-link'}`}>{refName(x)}</span>;
              })}
              <span className={`min-w-0 flex-1 truncate ${c.sha === log.tip ? 'font-semibold text-foreground' : 'text-foreground/85'}`}>{c.subject}</span>
              <span className="flex-none text-[0.6875rem] text-muted-foreground">{c.author}</span>
              <span className="flex-none font-mono text-[0.6875rem] text-muted-foreground">{when(c.at)}</span>
              <span className="w-[52px] flex-none font-mono text-[0.6875rem] text-muted-foreground">{c.sha.slice(0, 7)}</span>
            </button>
          );
        })}
      </div>
      {sha && detail && (
        <div className="mx-4 mb-3 flex min-h-0 flex-1 gap-3">
          <div style={{ width: side.width }} className="relative flex-none">
          <div className="nb-card m-0! flex h-full w-full flex-col overflow-hidden p-2 text-xs text-muted-foreground">
            <div className="nb-thin max-h-[40%] flex-none overflow-auto whitespace-pre-wrap text-[0.78125rem] text-foreground">{detail.message}</div>
            <div className="mt-1 mb-1.5 flex-none font-mono text-[0.6875rem]">{detail.sha.slice(0, 7)} · {detail.author} · {when(detail.at)}</div>
            <div className="nb-thin min-h-0 flex-1 overflow-auto">
              {files.map((f) => (
                <button key={f.path} type="button" title={f.path} onClick={() => setPick(f.path)} className={`flex h-6 w-full items-center gap-1.5 rounded px-1 text-left text-[0.75rem] hover:bg-muted ${cur === f ? 'bg-primary/15' : ''}`}>
                  <StatusMark s={f.status} />
                  <span className="min-w-0 truncate text-foreground">{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
                </button>
              ))}
            </div>
          </div>
          <PanelResizer edge="right" width={side.width} onWidth={side.set} onReset={side.reset} min={180} label={t('vcsCommitWidth')} />
          </div>
          <div className="nb-thin relative min-w-0 flex-1 overflow-auto">
            {got?.truncated && <p role="alert" className="mb-2 text-xs text-warn">{t('vcsTooBig')}</p>}
            {view && <FileDiff key={view.path} f={view} split={split} src={src} gitRef={ref} canOpen={false} />}
            <HighlightLayer pane="log" diff={mark} content={got} />
          </div>
        </div>
      )}
    </div>
  );
}
