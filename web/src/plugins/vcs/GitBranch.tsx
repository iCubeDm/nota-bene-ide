import { useEffect, useRef, useState } from 'react';
import type { GitSwitchAnswer, Source, VcsBranch } from '@nota-bene/shared';
import { useT, selectSession, selectTurnSeq, useAppDispatch, useAppSelector, routes, defineResource, useResource, loadSources, useSources, connection, useService, send } from '@/sdk';
import { Popover, PopoverContent, PopoverTrigger, ICONS, Svg } from '@/sdk/ui';
import { setHasRepo } from './store.ts';

type GitStatus = { branch: string | null; detached: boolean; dirty: boolean };
const THROTTLE = 3_000;

const isStatus = (v: unknown): v is GitStatus => {
  const s = v as GitStatus;
  return !!s && typeof s.dirty === 'boolean' && typeof s.detached === 'boolean' && (s.branch === null || typeof s.branch === 'string');
};

const NO_BRANCHES: VcsBranch[] = [];
export const branchesResource = defineResource<string, VcsBranch[]>({ id: 'vcs.branches', key: (root) => root, route: routes.vcsBranches });

/**
 * GET /git-status for the current root: on load, on a root change, after each live turn and on window focus, at most
 * one request per 3 s (a request inside the window is deferred to its end, not dropped); a branch switch (`diskSeq`)
 * asks at once. null: not a repo / no answer.
 */
function useGitStatus(root: string | undefined, turnSeq: number, diskSeq: number): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useRef<() => void>(() => {});
  const gen = useRef(0); // a root change drops the answer of the previous root
  useEffect(() => {
    if (!root) { setStatus(null); return; }
    const mine = ++gen.current;
    setStatus(null);
    const fetchNow = async () => {
      last.current = Date.now();
      try {
        const r = await connection.fetch(routes.gitStatus());
        if (!r.ok) return; // git timed out (503): keep what is shown
        const v: unknown = await r.json();
        if (mine === gen.current) setStatus(isStatus(v) ? v : null);
      } catch {
        // offline: keep what is shown
      }
    };
    run.current = () => {
      if (timer.current) return; // one is already scheduled
      const wait = last.current + THROTTLE - Date.now();
      if (wait <= 0) void fetchNow();
      else timer.current = setTimeout(() => { timer.current = null; void fetchNow(); }, wait);
    };
    last.current = 0; // a new root is asked at once
    run.current();
    const onFocus = () => run.current();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      gen.current++;
    };
  }, [root]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    run.current();
  }, [turnSeq]);
  const firstDisk = useRef(true);
  useEffect(() => {
    if (firstDisk.current) { firstDisk.current = false; return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    last.current = 0;
    run.current();
  }, [diskSeq]);
  return status;
}

type Refusal = { lead: string; detail?: string };

/** The menu's line for a refused switch: the server's code translated, git's own words under their lead. */
function refusal(t: ReturnType<typeof useT>, v: GitSwitchAnswer | null): Refusal {
  const e = v && 'error' in v ? v : null;
  if (e?.error === 'busy') return { lead: t('vcsSwitchBusy') };
  if (e?.error === 'git') return { lead: t('vcsSwitchGit'), ...(e.detail ? { detail: e.detail } : {}) };
  if (e?.error === 'unknown-branch') return { lead: t('vcsSwitchGone') };
  if (e?.error === 'timeout') return { lead: t('vcsSwitchTimeout') };
  return { lead: t('vcsSwitchFailed') };
}

/**
 * The branch button: picking changes what the window shows, the checkout and the agent stay where they are. Only a
 * branch row's Switch, once confirmed, moves this folder to that branch (POST /git-switch).
 */
export function GitBranch() {
  const t = useT();
  const d = useAppDispatch();
  const root = useAppSelector(selectSession)?.root;
  const files = useService('files');
  const projects = useService('projects');
  const src = useAppSelector(files.selectSource);
  const diskSeq = useAppSelector(files.selectDiskSeq);
  const st = useGitStatus(root, useAppSelector(selectTurnSeq), diskSeq);
  const sources = useSources();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [ask, setAsk] = useState<string | null>(null); // the branch row asking "switch?"
  const [going, setGoing] = useState(false);
  const [err, setErr] = useState<Refusal | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const provider = useAppSelector((x) => x.controls.capabilities?.provider) ?? 'claude';
  const viewing = src !== 'here';
  // the branch list of this project (an id of another project may mean another branch here): while the menu is open,
  // else only for the mark of the source shown
  const branches = useResource(branchesResource, root ?? '', { on: open || viewing, every: open ? 5_000 : 30_000 });
  const info = branches.data ?? NO_BRANCHES;
  // opening reads at once (a source already shown is watched, so it is asked again; otherwise the watch's first read)
  useEffect(() => {
    if (!open) return;
    void loadSources(true);
    if (viewing) branches.refresh();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void d(setHasRepo(!!st)), [d, st]);
  if (!st) return null;
  const here = st.detached ? t('gitDetached') : st.branch;
  const cur = sources.find((s) => s.id === src);
  const shown = viewing ? cur?.label ?? src : here;
  const dirty = viewing ? info.find((i) => i.id === src)?.dirty : st.dirty; // undefined: not known yet, no mark
  const f = q.trim().toLowerCase();
  const match = (s: Source) => !f || s.label.toLowerCase().includes(f);
  const confirm = (id: string | null) => { setAsk(id); setErr(null); };
  const openTree = async (s: Source) => {
    if (!s.dir) return;
    setGoing(true);
    setOpenErr(null);
    const why = await projects.openFolder(s.dir, provider);
    setGoing(false);
    if (why) setOpenErr(why);
  };
  const switchTo = async (s: Source) => {
    setGoing(true);
    setErr(null);
    try {
      const r = await send(routes.gitSwitch(), { branch: s.ref });
      const v = await r.json().catch(() => null) as GitSwitchAnswer | null;
      if (!r.ok) return setErr(refusal(t, v));
      // the folder is now that branch: show it, and reload what a finished turn reloads (status, tree, tabs, Changes, log)
      setOpen(false);
      confirm(null);
      d(files.pickSource('here'));
      d(files.diskChanged());
      void loadSources(true);
    } catch {
      setErr(refusal(t, null));
    } finally {
      setGoing(false);
    }
  };
  const row = (s: Source, wide = true) => {
    const i = info.find((x) => x.id === s.id);
    return (
      <button key={s.id} type="button" onClick={() => { d(files.pickSource(s.id)); setOpen(false); }} className={`flex h-7 ${wide ? 'w-full' : 'min-w-0 flex-1'} items-center gap-2 rounded px-2 text-left text-[0.78125rem] hover:bg-muted ${s.id === src ? 'bg-primary/10' : ''}`}>
        <span className="w-3 flex-none text-link">{s.id === src ? '✓' : ''}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">{s.id === 'here' ? here : s.label}</span>
        {i?.busy && <span data-agent-dot role="img" aria-label={t('vcsAgentHere')} title={t('vcsAgentHere')} className="size-2 flex-none animate-pulse rounded-full bg-nb-accent" />}
        {i?.base && <span title={t('vcsAgainst', i.base)} className="flex-none font-mono text-[0.6875rem] text-muted-foreground">↑{i.ahead}</span>}
        {i?.dirty && <span role="img" aria-label={t('vcsDirtyMark')} className="flex-none text-[0.6875rem] text-nb-accent">✗</span>}
      </button>
    );
  };
  // a branch row: view it (the row) or switch this folder to it (the button, then an inline confirm)
  const branchRow = (s: Source) => ask !== s.id ? (
    <div key={s.id} className="group flex items-center">
      {row(s, false)}
      <button type="button" onClick={() => confirm(s.id)} title={t('vcsSwitchTip', s.label)} aria-label={t('vcsSwitchTip', s.label)} className="ml-1 h-6 flex-none rounded px-1.5 text-[0.6875rem] text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">{t('vcsSwitch')}</button>
    </div>
  ) : (
    <div key={s.id} data-switch-confirm className="my-0.5 rounded bg-muted/60 px-2 py-1.5 text-[0.75rem]">
      <div className="font-medium break-all text-foreground">{t('vcsSwitchQ', s.label)}</div>
      <div className="mt-0.5 text-[0.6875rem] text-muted-foreground">{t('vcsSwitchNote')}</div>
      {err && (
        <div role="alert" className="mt-1 text-[0.6875rem] text-destructive">
          {err.lead}
          {err.detail && <pre className="mt-0.5 font-mono whitespace-pre-wrap">{err.detail}</pre>}
        </div>
      )}
      <div className="mt-1.5 flex justify-end gap-1.5">
        <button type="button" onClick={() => confirm(null)} className="h-6 rounded px-2 hover:bg-muted">{t('cancel')}</button>
        <button type="button" autoFocus disabled={going} onClick={() => void switchTo(s)} className="h-6 rounded bg-primary px-2 text-primary-foreground disabled:opacity-60">{t('vcsSwitch')}</button>
      </div>
    </div>
  );
  // a worktree row: view it (the row) or open its folder in a window of this agent (the button): git keeps its branch there
  const treeRow = (s: Source) => (
    <div key={s.id} className="group flex items-center">
      {row(s, false)}
      {s.dir && (
        <button type="button" disabled={going} onClick={() => void openTree(s)} title={t('vcsOpenTreeTip', s.label)} aria-label={t('vcsOpenTreeTip', s.label)}
          className="ml-1 h-6 flex-none rounded px-1.5 text-[0.6875rem] text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">{t('vcsOpenTree')}</button>
      )}
    </div>
  );
  const trees = sources.filter((s) => s.kind === 'worktree' && match(s));
  const plain = sources.filter((s) => s.kind === 'branch' && match(s));
  const label = (s: string) => <div className="px-2 pt-2 pb-0.5 text-[0.65625rem] uppercase tracking-wide text-muted-foreground">{s}</div>;
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setQ(''); confirm(null); setOpenErr(null); } }}>
      <PopoverTrigger asChild>
        <button type="button" id="git-branch" title={t('vcsTip')} className={`flex h-7 flex-none items-center gap-1.5 rounded-md px-2 font-mono text-[0.71875rem] whitespace-nowrap hover:bg-muted ${viewing ? 'bg-nb-accent/15 text-nb-accent' : 'text-foreground/85'}`}>
          <Svg size={13}>{ICONS.log}</Svg>
          {viewing && <span className="font-sans text-[0.65625rem] opacity-80">{t('vcsViewing')}</span>}
          {shown}
          {/* the marks are named for a screen reader, with no tooltip (issue 463) */}
          {dirty ? <span data-dirty role="img" aria-label={t('vcsDirtyMark')} className="text-nb-accent/80">✗</span> : dirty === false && <span role="img" aria-label={t('vcsCleanMark')} className="text-success/80">✔</span>}
          <span className="opacity-60">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-1.5" onEscapeKeyDown={(e) => { if (ask) { e.preventDefault(); confirm(null); } }}>
        <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('vcsFindBranch')} aria-label={t('vcsFindBranch')} className="mb-1 h-[28px] w-full rounded-md border border-transparent bg-muted/50 px-2 text-[0.78125rem] text-foreground outline-0 focus:border-input-focus-soft focus:ring-2 focus:ring-input-ring" />
        <div className="max-h-[60vh] overflow-auto">
          {label(t('vcsThisFolder'))}
          {sources.filter((s) => s.id === 'here').map((s) => row(s))}
          {trees.length > 0 && label(t('vcsWorktrees'))}
          {trees.map(treeRow)}
          {openErr && <div role="alert" className="px-2 py-1 text-[0.6875rem] text-destructive">{t('vcsOpenFail', openErr)}</div>}
          {plain.length > 0 && label(t('vcsBranches'))}
          {plain.map(branchRow)}
        </div>
      </PopoverContent>
    </Popover>
  );
}
