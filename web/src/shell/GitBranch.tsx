import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import type { Source, VcsBranch } from '@nota-bene/shared';
import { selectSession, selectTurnSeq, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { apiFetch } from '@/net/auth.ts';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { loadSources, useSources } from '@/files/sources.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { pickSource, selectTree } from '@/tree/slice.ts';
import { setHasRepo } from '@/vcs/store.ts';

type GitStatus = { branch: string | null; detached: boolean; dirty: boolean };
const THROTTLE = 3_000;

const isStatus = (v: unknown): v is GitStatus => {
  const s = v as GitStatus;
  return !!s && typeof s.dirty === 'boolean' && typeof s.detached === 'boolean' && (s.branch === null || typeof s.branch === 'string');
};

/**
 * GET /git-status for the current root: on load, on a root change, after each live turn and on window focus, at most
 * one request per 3 s (a request inside the window is deferred to its end, not dropped). null: not a repo / no answer.
 */
function useGitStatus(root: string | undefined, turnSeq: number): GitStatus | null {
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
        const r = await apiFetch('/git-status');
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
  return status;
}

/** The branch button: picking changes what the window shows, the checkout and the agent stay where they are. */
export function GitBranch() {
  const t = useT();
  const d = useAppDispatch();
  const root = useAppSelector(selectSession)?.root;
  const st = useGitStatus(root, useAppSelector(selectTurnSeq));
  const { src } = useAppSelector(selectTree);
  const sources = useSources();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [info, setInfo] = useState<VcsBranch[]>([]);
  const viewing = src !== 'here';
  useEffect(() => setInfo([]), [root]); // an id of the old project may mean another branch here
  useEffect(() => {
    if (!open && !viewing) return;
    if (open) void loadSources(true);
    let running = false;
    let gone = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const r = await apiFetch('/vcs-branches');
        if (r.ok && !gone) setInfo(await r.json() as VcsBranch[]);
      } catch { /* keep */ } finally { running = false; }
    };
    void run();
    const id = setInterval(() => { if (document.visibilityState === 'visible') void run(); }, open ? 5_000 : 30_000); // closed: only the mark of the source shown
    return () => { gone = true; clearInterval(id); };
  }, [open, viewing, root]);
  useEffect(() => setHasRepo(!!st), [st]);
  if (!st) return null;
  const here = st.detached ? t('gitDetached') : st.branch;
  const cur = sources.find((s) => s.id === src);
  const shown = viewing ? cur?.label ?? src : here;
  const dirty = viewing ? info.find((i) => i.id === src)?.dirty : st.dirty; // undefined: not known yet, no mark
  const f = q.trim().toLowerCase();
  const match = (s: Source) => !f || s.label.toLowerCase().includes(f);
  const row = (s: Source) => {
    const i = info.find((x) => x.id === s.id);
    return (
      <button key={s.id} type="button" onClick={() => { d(pickSource(s.id)); setOpen(false); }} className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[0.78125rem] hover:bg-muted ${s.id === src ? 'bg-primary/10' : ''}`}>
        <span className="w-3 flex-none text-primary">{s.id === src ? '✓' : ''}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">{s.id === 'here' ? here : s.label}</span>
        {i?.busy && <span data-agent-dot role="img" aria-label={t('vcsAgentHere')} title={t('vcsAgentHere')} className="size-2 flex-none animate-pulse rounded-full bg-nb-accent" />}
        {i?.base && <span title={t('vcsAgainst', i.base)} className="flex-none font-mono text-[0.6875rem] text-muted-foreground">↑{i.ahead}</span>}
        {i?.dirty && <span title={t('vcsHasUncommitted')} className="flex-none text-[0.6875rem] text-nb-accent">✗</span>}
      </button>
    );
  };
  const trees = sources.filter((s) => s.kind === 'worktree' && match(s));
  const plain = sources.filter((s) => s.kind === 'branch' && match(s));
  const label = (s: string) => <div className="px-2 pt-2 pb-0.5 text-[0.65625rem] uppercase tracking-wide text-muted-foreground">{s}</div>;
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQ(''); }}>
      <PopoverTrigger asChild>
        <button type="button" id="git-branch" title={viewing ? t('vcsViewingTip', shown ?? '', here ?? '') : `${t('gitBranch')} · ${st.dirty ? t('gitDirty') : t('gitClean')}`} className={`flex h-7 flex-none items-center gap-1.5 rounded-md px-2 font-mono text-[0.71875rem] whitespace-nowrap hover:bg-muted ${viewing ? 'bg-nb-accent/15 text-nb-accent' : 'text-foreground/85'}`}>
          <Svg size={13}>{ICONS.log}</Svg>
          {viewing && <span className="font-sans text-[0.65625rem] opacity-80">{t('vcsViewing')}</span>}
          {shown}
          {dirty ? <span data-dirty className="text-nb-accent/80">✗</span> : dirty === false && <span className="text-success/80">✔</span>}
          <span className="opacity-60">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-1.5">
        <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('vcsFindBranch')} aria-label={t('vcsFindBranch')} className="mb-1 h-[28px] w-full rounded-md border border-transparent bg-muted/50 px-2 text-[0.78125rem] text-foreground outline-0 focus:border-primary/50" />
        <div className="max-h-[60vh] overflow-auto">
          {label(t('vcsThisFolder'))}
          {sources.filter((s) => s.id === 'here').map(row)}
          {trees.length > 0 && label(t('vcsWorktrees'))}
          {trees.map(row)}
          {plain.length > 0 && label(t('vcsBranches'))}
          {plain.map(row)}
        </div>
      </PopoverContent>
    </Popover>
  );
}
