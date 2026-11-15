// The project switcher in the header: a list of chats, one row per folder over the windows of every agent in it, with what
// happened last and one badge (`!` when it waits for the person, else the replies they have not seen). A row expands to its
// sessions (ProjectSessions); choosing another project moves this tab to its newest window, logged in (api.ts enterProject).
// Another project's windows are stopped from its row (⏻, after a confirm); this one's from the header's Stop Nota Bene.
// Recent folders come from the launcher's list and from this window's session history; one opens in a window of its agent.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useT } from '@/i18n/index.ts';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { ConfirmDialog } from '@/controls/ConfirmDialog.tsx';
import { ago } from '@/controls/SessionPicker.tsx';
import { shortWinHome } from '@/lib/paths.ts';
import { apiFetch } from '@/net/auth.ts';
import { toast } from '@/shell/toast.ts';
import { withKey } from '@/shell/keymap.ts';
import { selectSession, useAppSelector } from '@/store/store.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { enterProject, openFolder, reasonText, openStarter, PROVIDER_LABEL, projectsMenu, stopProject, useProjects, type Provider, type ProjectState } from './api.ts';
import { ProjectSessions, type LocalSession } from './ProjectSessions.tsx';
import { badgeOf, foldRows, titlePrefix, type Badge, type ProjectRow } from './rows.ts';

export const folderOf = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;
const short = (d: string) => shortWinHome(d).replace(/^\/Users\/[^/]+/, '~');
const DOT: Record<ProjectState, string> = {
  working: 'bg-primary', waiting: 'bg-warn', idle: 'bg-success', restarting: 'bg-muted-foreground/30', silent: 'bg-destructive/60',
};
const STATE_KEY = { working: 'projWorking', waiting: 'projWaiting', idle: 'projIdle', restarting: 'projRestarting', silent: 'projSilent' } as const;
const LIVE = new Set<ProjectState>(['working', 'waiting', 'idle']);
const RECENT_SHOWN = 10;
const sectionCls = 'px-2.5 pt-1.5 pb-0.5 text-[0.6875rem] uppercase tracking-wide text-muted-foreground';

// the theme's accents, tinted: readable in every theme
const TILES = ['bg-accent-agent/20 text-accent-agent', 'bg-accent-model/20 text-accent-model', 'bg-accent-sessions/20 text-accent-sessions',
  'bg-accent-usage/20 text-accent-usage', 'bg-primary/20 text-primary', 'bg-success/20 text-success', 'bg-warn/20 text-warn'];

/** Two letters of the folder on a colour picked by its path: the same project looks the same everywhere. */
function Tile({ root, state }: { root: string; state?: ProjectState }) {
  let h = 0;
  for (const c of root) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const letters = (folderOf(root).match(/[\p{L}\p{N}]/gu) ?? ['?']).slice(0, 2).join('').toUpperCase();
  return (
    <span aria-hidden className={`relative flex size-8 flex-none items-center justify-center rounded-lg text-[0.6875rem] font-bold ${TILES[h % TILES.length]}`}>
      {letters}
      {state && <span className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-popover ${DOT[state]}`} />}
    </span>
  );
}

function BadgeView({ b }: { b: Badge }) {
  if (b === null) return null;
  return <span className={`min-w-4 rounded-full px-1.5 text-center text-[0.625rem] font-semibold leading-4 ${b === '!' ? 'bg-warn text-background' : 'bg-primary text-primary-foreground'}`}>{b}</span>;
}

function Chevron({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} aria-expanded={open} onClick={onClick}
      className="flex size-6 flex-none cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className={open ? 'rotate-180' : ''}><path d="m6 9 6 6 6-6" /></svg>
    </button>
  );
}

type RecentItem = { root: string; provider: Provider; at: number };

export function ProjectSwitcher({ project, windowTitle }: { project: string; windowTitle: string }) {
  const t = useT();
  const open = useSyncExternalStore(projectsMenu.subscribe, projectsMenu.get);
  const { data, reload } = useProjects(open);
  const session = useAppSelector(selectSession);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [local, setLocal] = useState<LocalSession[]>([]);
  const [stopAsk, setStopAsk] = useState<ProjectRow | null>(null);
  const running = data?.running ?? [];
  const badge = badgeOf(running);
  useEffect(() => { document.title = titlePrefix(badge) + windowTitle; }, [badge, windowTitle]);
  const own = running.find((r) => r.current);
  const myProvider: Provider = own?.provider ?? 'claude';

  // this window's sessions (every folder of its agent): this project's list, and the Recent folders its history knows
  useEffect(() => {
    if (!open) return;
    setExpanded(new Set(session?.root ? [session.root] : []));
    let gone = false;
    apiFetch('/sessions').then((r) => (r.ok ? r.json() : null)).then((v: { sessions?: LocalSession[] } | null) => {
      if (!gone && v && Array.isArray(v.sessions)) setLocal(v.sessions.filter((x) => typeof x?.cwd === 'string' && typeof x.id === 'string'));
    }).catch(() => {});
    return () => { gone = true; };
  }, [open, session?.root]);

  const needle = q.trim().toLowerCase();
  const hit = (...s: (string | null | undefined)[]) => !needle || s.some((x) => x?.toLowerCase().includes(needle));
  const rows = foldRows(running).filter((r) => hit(r.root, ...r.windows.map((w) => w.title)));
  const runningRoots = new Set(running.map((r) => r.root));
  const recentAll = new Map<string, RecentItem>();
  for (const e of data?.recent ?? []) if (!e.running && !runningRoots.has(e.root) && !recentAll.has(e.root)) recentAll.set(e.root, e);
  for (const s of [...local].sort((a, b) => b.at - a.at)) {
    if (!runningRoots.has(s.cwd) && !recentAll.has(s.cwd)) recentAll.set(s.cwd, { root: s.cwd, provider: myProvider, at: s.at });
  }
  const recent = [...recentAll.values()].filter((e) => hit(e.root, ...local.filter((s) => s.cwd === e.root).map((s) => s.title))).slice(0, RECENT_SHOWN);
  const onOpenChange = (o: boolean) => { if (o) projectsMenu.open(); else { projectsMenu.close(); setQ(''); } };
  const toggle = (root: string) => setExpanded((s) => { const n = new Set(s); if (n.has(root)) n.delete(root); else n.add(root); return n; });
  const openRecent = async (e: RecentItem, sessionId?: string) => {
    setBusy(true);
    const why = await openFolder(e.root, e.provider, undefined, sessionId);
    setBusy(false);
    if (why) toast(why === 'still starting' ? reasonText(why) : t('startFailed', reasonText(why)), e.root);
  };
  const goTo = (r: ProjectRow) => {
    if (r.current) return toggle(r.root);
    const w = r.windows.find((x) => LIVE.has(x.state));
    if (!w) return;
    projectsMenu.close();
    void enterProject(w);
  };
  const stopRow = async (r: ProjectRow) => {
    setStopAsk(null);
    for (const w of r.windows.filter((x) => LIVE.has(x.state))) {
      const why = await stopProject(w);
      if (why) toast(t('projStopFail', reasonText(why)), r.root);
    }
    reload();
  };
  const starter = (mode: 'open' | 'new') => { projectsMenu.close(); openStarter(mode); };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" title={withKey(t('projSwitchTip'), 'hk_projects')}
          className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1 hover:bg-muted">
          <b id="proj" className="truncate text-[0.9375rem] font-semibold leading-5 tracking-[-0.01em] text-foreground">{project}</b>
          {/* the badge sits right of the ▾ on the same line, out of the flow: nothing moves when it comes, goes or grows */}
          <span className="relative flex flex-none items-center">
            <span aria-hidden className="text-[0.625rem] text-muted-foreground">▾</span>
            {badge !== null && (
              <span data-badge-over title={badge === '!' ? t('projWaitTip') : t('projUnseenTip', badge)} className="absolute top-1/2 left-full ml-1 flex -translate-y-1/2">
                <BadgeView b={badge} />
              </span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-[min(75vh,640px)] w-[460px] flex-col"
        onOpenAutoFocus={(e) => { e.preventDefault(); (document.getElementById('projSearch') as HTMLInputElement | null)?.focus(); }}>
        <input id="projSearch" aria-label={t('projSearch')} placeholder={t('projSearch')} value={q} onChange={(e) => setQ(e.target.value)}
          className="m-1 flex-none rounded-md border border-border-soft bg-transparent px-2 py-1.5 text-xs text-foreground outline-none focus-visible:border-input-focus focus-visible:ring-2 focus-visible:ring-input-ring" />
        <div className="min-h-0 overflow-auto">
          {rows.length > 0 && (
            <div role="group" aria-label={t('projProjects')} className="py-0.5">
              <div className={sectionCls}>{t('projProjects')}</div>
              {rows.map((r) => {
                const top = r.windows[0]!;
                const folder = folderOf(r.root);
                const detail = [top.title || (top.session ? t('untitled') : null), PROVIDER_LABEL[top.provider], r.state === 'idle' ? null : t(STATE_KEY[r.state]), r.current ? t('projThis') : null].filter(Boolean).join(' · ');
                const b: Badge = r.state === 'waiting' ? '!' : r.unseen > 0 ? r.unseen : null;
                const isOpen = expanded.has(r.root);
                return (
                  <div key={r.root}>
                    <div className={`group/proj flex items-center gap-1 rounded-md pr-1 ${r.current ? 'bg-primary/10' : ''}`}>
                      <button type="button" aria-label={`${folder} · ${detail}`} title={short(r.root)} onClick={() => goTo(r)}
                        className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted ${!r.current && !r.windows.some((w) => LIVE.has(w.state)) ? 'opacity-60' : ''}`}>
                        <Tile root={r.root} state={r.state} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex items-baseline gap-2">
                            <span className="truncate text-[0.8125rem] font-semibold text-foreground">{folder}</span>
                            {r.last?.at && <span className="ml-auto flex-none text-[0.6875rem] text-muted-foreground">{ago(r.last.at)}</span>}
                          </span>
                          {r.last && <span className="truncate text-xs text-muted-foreground">{r.last.text}</span>}
                          <span className="truncate text-[0.6875rem] text-muted-foreground/80">{detail}</span>
                        </span>
                        <BadgeView b={b} />
                      </button>
                      {!r.current && r.windows.some((w) => LIVE.has(w.state)) && (
                        <button type="button" aria-label={t('projStop', folder)} title={t('projStop', folder)} onClick={() => setStopAsk(r)}
                          className="grid size-6 flex-none cursor-pointer place-items-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover/proj:opacity-100">
                          <Svg size={13}>{ICONS.power}</Svg>
                        </button>
                      )}
                      <Chevron open={isOpen} label={t('projExpand', folder)} onClick={() => toggle(r.root)} />
                    </div>
                    {isOpen && <ProjectSessions root={r.root} windows={r.windows} local={local} setLocal={setLocal} onDone={() => projectsMenu.close()} />}
                  </div>
                );
              })}
            </div>
          )}
          {recent.length > 0 && (
            <div role="group" aria-label={t('projRecent')} className="py-0.5">
              <div className={sectionCls}>{t('projRecent')}</div>
              {recent.map((e) => {
                const folder = folderOf(e.root);
                const isOpen = expanded.has(e.root);
                const mine = local.some((s) => s.cwd === e.root);
                return (
                  <div key={e.root}>
                    <div className="flex items-center gap-1 pr-1">
                      <button type="button" aria-label={`${folder} · ${short(e.root)} · ${PROVIDER_LABEL[e.provider]}`} disabled={busy} onClick={() => void openRecent(e)}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-left opacity-80 hover:bg-muted disabled:opacity-50">
                        <Tile root={e.root} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex items-baseline gap-2">
                            <span className="truncate text-[0.8125rem] text-foreground">{folder}</span>
                            {e.at > 0 && <span className="ml-auto flex-none text-[0.6875rem] text-muted-foreground">{ago(e.at)}</span>}
                          </span>
                          <span className="truncate font-mono text-[0.65625rem] text-muted-foreground">{short(e.root)} · {PROVIDER_LABEL[e.provider]}</span>
                        </span>
                      </button>
                      {mine && <Chevron open={isOpen} label={t('projExpand', folder)} onClick={() => toggle(e.root)} />}
                    </div>
                    {isOpen && mine && (
                      <div role="group" aria-label={t('projSessionsOf', folder)} className="pb-1 pl-12">
                        {local.filter((s) => s.cwd === e.root).sort((a, b) => b.at - a.at).map((s) => (
                          <button key={s.id} type="button" disabled={busy} onClick={() => void openRecent({ ...e, provider: myProvider }, s.id)}
                            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted disabled:opacity-50">
                            <span className="min-w-0 flex-1 truncate text-foreground">{s.title || t('untitled')} · {PROVIDER_LABEL[myProvider]}</span>
                            <span className="flex-none text-[0.6875rem] text-muted-foreground">{ago(s.at)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {data && rows.length === 0 && recent.length === 0 && <div className="px-2.5 py-2 text-xs text-muted-foreground">{t('projNone')}</div>}
        </div>
        <div className="mt-1 flex-none border-t border-border-soft pt-1">
          <button type="button" onClick={() => starter('open')} className="block w-full cursor-pointer rounded-md px-2.5 py-1 text-left text-xs text-link hover:bg-muted">{t('projOpenFolder')}</button>
          <button type="button" onClick={() => starter('new')} className="block w-full cursor-pointer rounded-md px-2.5 py-1 text-left text-xs text-link hover:bg-muted">{t('projNew')}</button>
        </div>
        {stopAsk && (
          <ConfirmDialog
            title={t('projStopQ', folderOf(stopAsk.root))}
            body={[t('projStopBody', stopAsk.windows.filter((w) => LIVE.has(w.state)).map((w) => PROVIDER_LABEL[w.provider]).join(', ')),
              ...(stopAsk.windows.some((w) => w.state === 'working') ? [t('stopWindowBusy')] : [])].join('\n')}
            confirm={t('winStop')}
            onConfirm={() => void stopRow(stopAsk)}
            onCancel={() => setStopAsk(null)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
