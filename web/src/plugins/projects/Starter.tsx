// The starter: an Open folder dialog over the server's /system/folders (the browser has none of its own; a desktop shell can
// swap in the OS dialog later). Places on the left, the path as breadcrumbs and a field with Tab completion, the folders
// with git repositories first: a click selects, a double click or Enter goes in, Open opens the selection (or the folder
// being browsed). "New folder here" creates one in the folder being browsed and opens it. Either way in a window of the
// chosen agent, and this tab moves there.
import { useEffect, useRef, useState } from 'react';
import { useT, connection, routes, send } from '@/sdk';
import { Dialog, DialogContent, DialogTitle } from '@/sdk/ui';
import { isAbsolute, onPageRestore, openFolder, PROVIDER_LABEL, reasonOf, reasonText, setStarter, validName, type Provider } from './api.ts';

type Dir = { name: string; git: boolean };
type Place = { path: string; kind: 'home' | 'desktop' | 'recent' };
type Listing = { path: string; parent: string | null; home: string; dirs: Dir[]; places?: Place[] };
const winPath = (p: string) => p.includes('\\') && !p.includes('/');
const sepOf = (p: string) => (winPath(p) ? '\\' : '/');
const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${name}`;
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
/** The path as steps: [label, path] from the root down. */
function crumbs(p: string): [string, string][] {
  const win = /^[A-Za-z]:/.test(p);
  const parts = p.split(/[\\/]/).filter(Boolean);
  const out: [string, string][] = win ? [] : [['/', '/']];
  let acc = '';
  for (const [i, part] of parts.entries()) {
    acc = win ? (i === 0 ? `${part}\\` : join(acc, part)) : `${acc}/${part}`;
    out.push([part, acc]);
  }
  return out;
}
const byGitThenName = (a: Dir, b: Dir) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const commonPrefix = (xs: string[]) => xs.reduce((p, x) => { let i = 0; while (i < p.length && i < x.length && p[i]!.toLowerCase() === x[i]!.toLowerCase()) i++; return p.slice(0, i); });
const btn = 'cursor-pointer rounded-md border border-border-soft px-2.5 py-1 text-xs text-foreground hover:enabled:border-primary disabled:cursor-default disabled:opacity-40';
const primary = 'cursor-pointer rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:cursor-default disabled:opacity-40';

export function Starter() {
  const t = useT();
  const [mode, setMode] = useState<'open' | 'new' | null>(null);
  const [list, setList] = useState<Listing | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [hidden, setHidden] = useState(false);
  const [agents, setAgents] = useState<Provider[]>([]);
  const [agent, setAgent] = useState<Provider>('claude');
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [git, setGit] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const seq = useRef(0);
  const last = useRef<string | undefined>(undefined);
  // issue 449: a page brought back by Back after opening a folder comes with the dialog still open
  useEffect(() => onPageRestore(() => { setRunning(false); setMode(null); }), []);

  const fetchListing = async (path: string | undefined, withHidden: boolean): Promise<Listing | string> => {
    try {
      const r = await send(routes.systemFolders(), { ...(path !== undefined ? { path } : {}), hidden: withHidden });
      if (!r.ok) return reasonOf(r);
      return (await r.json()) as Listing;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  /** Browses `path` (home when undefined); a listing that arrives after a newer request is dropped. */
  const browse = async (path: string | undefined, withHidden = hidden) => {
    const mine = ++seq.current;
    const l = await fetchListing(path, withHidden);
    if (mine !== seq.current) return;
    if (typeof l === 'string') return setNote(t('startFailed', reasonText(l)));
    setList(l);
    if (l.places) setPlaces(l.places);
    setTyped(l.path);
    setSelected(null);
    setNote(null);
    last.current = l.path;
  };

  useEffect(() => {
    setStarter((m) => {
      setMode(m);
      setMaking(m === 'new');
      setName('');
      setGit(true);
      setNote(null);
      setRunning(false);
      setHidden(false);
      void browse(last.current, false);
      void connection.fetch(routes.systemAgents()).then((r) => (r.ok ? r.json() : null)).then((j: { agents?: Provider[]; default?: Provider } | null) => {
        if (!j || !Array.isArray(j.agents)) return;
        setAgents(j.agents);
        if (j.default) setAgent(j.default);
      }).catch(() => {});
    });
    return () => setStarter(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registered once; browse reads the state it is given
  }, []);

  /** Tab in the path field: the folder names of the typed parent that start with what follows its last separator. */
  const complete = async () => {
    const v = typed;
    const cut = Math.max(v.lastIndexOf('/'), v.lastIndexOf('\\'));
    if (!isAbsolute(v) || cut < 0) return;
    const parent = v.slice(0, cut) || sepOf(v);
    const prefix = v.slice(cut + 1).toLowerCase();
    const l = list && list.path === parent ? list : await fetchListing(parent, hidden);
    if (typeof l === 'string') return;
    const hits = l.dirs.map((d) => d.name).filter((n) => n.toLowerCase().startsWith(prefix));
    if (hits.length === 0) return;
    const base = parent.endsWith(sepOf(v)) ? parent : `${parent}${sepOf(v)}`;
    setTyped(hits.length === 1 ? `${base}${hits[0]}${sepOf(v)}` : `${base}${commonPrefix(hits)}`);
  };

  /** Opens the selection (or the folder being browsed), or creates the new folder in it and opens that. */
  const launch = async (create: boolean) => {
    if (!list) return;
    setRunning(true);
    setNote(null);
    const why = create
      ? await openFolder(list.path, agent, { name, git })
      : await openFolder(selected ? join(list.path, selected) : list.path, agent);
    setRunning(false);
    if (why) setNote(why === 'exists' ? reasonText(why) : t('startFailed', reasonText(why)));
  };
  const nameBad = making && name !== '' && !validName(name);
  const dirs = [...(list?.dirs ?? [])].sort(byGitThenName);
  const placeName = (p: Place) => (p.kind === 'home' ? t('startHome') : p.kind === 'desktop' ? t('startDesktop') : baseName(p.path));

  return (
    <Dialog open={mode !== null} onOpenChange={(o) => { if (!o && !running) setMode(null); }}>
      <DialogContent className="flex max-h-[82vh] w-[720px] max-w-[94vw] flex-col gap-2">
        <DialogTitle>{mode === 'new' ? t('startNewTitle') : t('startOpenTitle')}</DialogTitle>
        <nav aria-label={t('startPath')} className="flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-[0.6875rem] text-muted-foreground">
          {list && crumbs(list.path).map(([label, path], i, all) => (
            <span key={path} className="flex items-center gap-0.5">
              {i > 0 && all[i - 1]![0] !== '/' && <span aria-hidden>{sepOf(list.path)}</span>}
              <button type="button" disabled={running} onClick={() => void browse(path)}
                className={`cursor-pointer rounded px-1 py-0.5 hover:bg-muted ${i === all.length - 1 ? 'text-foreground' : ''}`}>{label}</button>
            </span>
          ))}
        </nav>
        <input aria-label={t('startPathField')} value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && !e.shiftKey && typed.trim()) { e.preventDefault(); void complete(); return; }
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (!isAbsolute(typed.trim())) return setNote(t('startPathAbs'));
            void browse(typed.trim().replace(/(.)[\\/]+$/, '$1'));
          }}
          className="rounded-md border border-border-soft bg-transparent px-2 py-1 font-mono text-[0.6875rem] text-foreground outline-none focus-visible:border-input-focus" />
        <div className="flex min-h-0 gap-2">
          <nav aria-label={t('startPlaces')} className="flex w-36 flex-none flex-col gap-0.5">
            {places.map((p) => (
              <button key={p.path} type="button" title={p.path} disabled={running} onClick={() => void browse(p.path)}
                className={`cursor-pointer truncate rounded-md px-2 py-1 text-left text-xs hover:bg-muted ${list?.path === p.path ? 'bg-primary/10 text-foreground' : 'text-muted-foreground'}`}>{placeName(p)}</button>
            ))}
          </nav>
          <div role="listbox" aria-label={t('startFolders')} className="min-h-48 flex-1 overflow-auto rounded-md border border-border-soft p-1">
            {list && dirs.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('startEmpty')}</div>}
            {list && dirs.map((d) => (
              <div key={d.name} role="option" tabIndex={0} data-name={d.name} aria-selected={selected === d.name}
                onClick={() => setSelected(d.name)}
                onDoubleClick={() => { if (!running) void browse(join(list.path, d.name)); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !running) { e.preventDefault(); void browse(join(list.path, d.name)); } }}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-input-ring ${selected === d.name ? 'bg-primary/15' : ''}`}>
                <span className="flex-1 truncate">{d.name}</span>
                {d.git && <span aria-hidden className="font-mono text-[0.625rem] text-muted-foreground">git</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); void browse(list?.path, e.target.checked); }} />
            {t('startHidden')}
          </label>
          <span className="flex-1" />
          {!making && <button type="button" className={btn} disabled={!list || running} onClick={() => setMaking(true)}>{t('startNewHere')}</button>}
        </div>
        {making && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border-soft p-2">
            {list && <div className="truncate font-mono text-[0.6875rem] text-muted-foreground">{t('startIn', list.path)}</div>}
            <div className="flex items-center gap-2">
              <input aria-label={t('startName')} placeholder={t('startName')} value={name} autoFocus onChange={(e) => setName(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-border-soft bg-transparent px-2 py-1 text-xs text-foreground outline-none focus-visible:border-input-focus" />
              <label className="flex flex-none items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} />
                {t('startGit')}
              </label>
              <button type="button" className={primary} disabled={!list || running || !validName(name)} onClick={() => void launch(true)}>{t('startCreate')}</button>
            </div>
            {nameBad && <div className="text-xs text-destructive">{t('startNameBad')}</div>}
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t('startAgent')}
            <select aria-label={t('startAgent')} value={agent} onChange={(e) => setAgent(e.target.value as Provider)} disabled={running}
              className="rounded-md border border-border-soft bg-transparent px-1.5 py-0.5 text-xs text-foreground">
              {(agents.length ? agents : [agent]).map((a) => <option key={a} value={a}>{PROVIDER_LABEL[a]}</option>)}
            </select>
          </label>
          <span className="flex-1 truncate text-xs">
            {running ? <span className="text-muted-foreground">{t('startOpening')}</span> : note && <span className="text-destructive">{note}</span>}
          </span>
          <button type="button" className={primary} disabled={!list || running} onClick={() => void launch(false)}>{t('startOpen')}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
