// The project switcher in the header (phase 1 of the one-tab design): the project's name opens a list of every running
// window of every provider with its agent's state, the recent folders, and the starter. Choosing a window moves this tab
// there, logged in (api.ts enterProject); a recent folder is opened in a window of its last agent.
import { useState, useSyncExternalStore } from 'react';
import { useT } from '@/i18n/index.ts';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { shortWinHome } from '@/lib/paths.ts';
import { toast } from '@/shell/toast.ts';
import { withKey } from '@/shell/keymap.ts';
import { enterProject, openFolder, reasonText, openStarter, PROVIDER_LABEL, projectsMenu, useProjects, type ProjectState, type RecentRow, type RunningRow } from './api.ts';

const folderOf = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;
const short = (d: string) => shortWinHome(d).replace(/^\/Users\/[^/]+/, '~');
const DOT: Record<ProjectState, string> = {
  working: 'bg-primary', waiting: 'bg-warn', idle: 'bg-success', restarting: 'bg-muted-foreground/30', silent: 'bg-destructive/60',
};
const STATE_KEY = { working: 'projWorking', waiting: 'projWaiting', idle: 'projIdle', restarting: 'projRestarting', silent: 'projSilent' } as const;
const LIVE = new Set<ProjectState>(['working', 'waiting', 'idle']);
const RECENT_SHOWN = 10;
const rowCls = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs';

export function ProjectSwitcher({ project }: { project: string }) {
  const t = useT();
  const open = useSyncExternalStore(projectsMenu.subscribe, projectsMenu.get);
  const { data } = useProjects(open);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const running = data?.running ?? [];
  const waiting = running.filter((r) => r.state === 'waiting' && !r.current).length;
  const needle = q.trim().toLowerCase();
  const hit = (...s: (string | null)[]) => !needle || s.some((x) => x?.toLowerCase().includes(needle));
  const shown = running.filter((r) => hit(r.root, r.title));
  const recent = (data?.recent ?? []).filter((e) => !e.running && hit(e.root)).slice(0, RECENT_SHOWN);
  const onOpenChange = (o: boolean) => { if (o) projectsMenu.open(); else { projectsMenu.close(); setQ(''); } };
  const detail = (r: RunningRow) => `${folderOf(r.root)} · ${PROVIDER_LABEL[r.provider]} · ${t(STATE_KEY[r.state])}`;
  const openRecent = async (e: RecentRow) => {
    setBusy(true);
    const why = await openFolder(e.root, e.provider);
    setBusy(false);
    if (why) toast(why === 'still starting' ? reasonText(why) : t('startFailed', reasonText(why)), e.root);
  };
  const starter = (mode: 'open' | 'new') => { projectsMenu.close(); openStarter(mode); };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" title={withKey(t('projSwitchTip'), 'hk_projects')}
          className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted">
          <b id="proj" className="truncate text-[0.9375rem] font-semibold tracking-[-0.01em] text-foreground">{project}</b>
          <span aria-hidden className="text-[0.625rem] text-muted-foreground">▾</span>
          {waiting > 0 && (
            <span title={t('projWaitingTip', waiting)} className="rounded-full bg-warn px-1.5 text-[0.625rem] font-semibold leading-4 text-background">{waiting}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-[min(70vh,560px)] w-[420px] flex-col"
        onOpenAutoFocus={(e) => { e.preventDefault(); (document.getElementById('projSearch') as HTMLInputElement | null)?.focus(); }}>
        <input id="projSearch" aria-label={t('projSearch')} placeholder={t('projSearch')} value={q} onChange={(e) => setQ(e.target.value)}
          className="m-1 flex-none rounded-md border border-border-soft bg-transparent px-2 py-1.5 text-xs text-foreground outline-none focus-visible:border-input-focus focus-visible:ring-2 focus-visible:ring-input-ring" />
        <div className="min-h-0 overflow-auto">
          {shown.length > 0 && (
            <div role="group" aria-label={t('projRunning')} className="py-0.5">
              <div className="px-2.5 pt-1.5 pb-0.5 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{t('projRunning')}</div>
              {shown.map((r) => {
                // a window is named by its session; the folder, agent and state go below
                const body = (
                  <>
                    <span aria-hidden className={`mt-1.5 size-2 flex-none self-start rounded-full ${DOT[r.state]}`} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[0.8125rem] text-foreground">{r.title || folderOf(r.root)}</span>{' '}
                      <span className="truncate text-[0.6875rem] text-muted-foreground" title={short(r.root)}>{detail(r)}</span>
                    </span>
                    {r.current && <span className="self-start text-muted-foreground">{t('projThis')}</span>}
                  </>
                );
                return !r.current && LIVE.has(r.state)
                  ? <button key={`${r.provider}${r.port}`} type="button" onClick={() => { projectsMenu.close(); void enterProject(r); }} className={`${rowCls} cursor-pointer hover:bg-muted`}>{body}</button>
                  : <div key={`${r.provider}${r.port}`} className={`${rowCls} ${r.current ? '' : 'opacity-60'}`}>{body}</div>;
              })}
            </div>
          )}
          {recent.length > 0 && (
            <div role="group" aria-label={t('projRecent')} className="py-0.5">
              <div className="px-2.5 pt-1.5 pb-0.5 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{t('projRecent')}</div>
              {recent.map((e) => (
                <button key={`${e.provider} ${e.root}`} type="button" disabled={busy} onClick={() => void openRecent(e)} className={`${rowCls} cursor-pointer hover:bg-muted disabled:opacity-50`}>
                  <span className="text-[0.8125rem] text-foreground">{folderOf(e.root)}</span>
                  <span className="flex-1 truncate font-mono text-[0.65625rem] text-muted-foreground">{short(e.root)}</span>
                  <span className="text-muted-foreground">{PROVIDER_LABEL[e.provider]}</span>
                </button>
              ))}
            </div>
          )}
          {data && shown.length === 0 && recent.length === 0 && <div className="px-2.5 py-2 text-xs text-muted-foreground">{t('projNone')}</div>}
        </div>
        <div className="mt-1 flex-none border-t border-border-soft pt-1">
          <button type="button" onClick={() => starter('open')} className={`${rowCls} cursor-pointer text-link hover:bg-muted`}>{t('projOpenFolder')}</button>
          <button type="button" onClick={() => starter('new')} className={`${rowCls} cursor-pointer text-link hover:bg-muted`}>{t('projNew')}</button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
