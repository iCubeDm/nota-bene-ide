// The starter (phase 1: a dialog over the current window): open a folder, or create one and open it, in a window of the
// chosen agent. The browser has no folder dialog, so this is our own picker over the server's /system/folders, from the
// home folder; a typed full path is browsed too. A desktop shell can swap in the OS dialog later.
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog.tsx';
import { useT } from '@/i18n/index.ts';
import { apiFetch } from '@/net/auth.ts';
import { isAbsolute, openFolder, postJson, PROVIDER_LABEL, reasonOf, reasonText, setStarter, validName, type Provider } from './api.ts';

type Listing = { path: string; parent: string | null; home: string; dirs: { name: string; git: boolean }[] };
const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`;
const btn = 'cursor-pointer rounded-md border border-border-soft px-2.5 py-1 text-xs text-foreground hover:enabled:border-primary disabled:cursor-default disabled:opacity-40';
const primary = 'cursor-pointer rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:cursor-default disabled:opacity-40';

export function Starter() {
  const t = useT();
  const [mode, setMode] = useState<'open' | 'new' | null>(null);
  const [list, setList] = useState<Listing | null>(null);
  const [typed, setTyped] = useState('');
  const [hidden, setHidden] = useState(false);
  const [agents, setAgents] = useState<Provider[]>([]);
  const [agent, setAgent] = useState<Provider>('claude');
  const [name, setName] = useState('');
  const [git, setGit] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const browse = async (path: string | undefined, withHidden = hidden) => {
    try {
      const r = await postJson('/system/folders', { ...(path !== undefined ? { path } : {}), hidden: withHidden });
      if (!r.ok) return setNote(t('startFailed', reasonText(await reasonOf(r))));
      const l = (await r.json()) as Listing;
      setList(l);
      setTyped(l.path);
      setNote(null);
    } catch (e) {
      setNote(t('startFailed', e instanceof Error ? e.message : String(e)));
    }
  };

  useEffect(() => {
    setStarter((m) => {
      setMode(m);
      setName('');
      setGit(true);
      setNote(null);
      setRunning(false);
      void browse(undefined);
      void apiFetch('/system/agents').then((r) => (r.ok ? r.json() : null)).then((j: { agents?: Provider[]; default?: Provider } | null) => {
        if (!j || !Array.isArray(j.agents)) return;
        setAgents(j.agents);
        if (j.default) setAgent(j.default);
      }).catch(() => {});
    });
    return () => setStarter(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registered once; browse reads the state it is given
  }, []);

  const go = async () => {
    if (!list || !mode) return;
    setRunning(true);
    setNote(null);
    const why = await openFolder(list.path, agent, mode === 'new' ? { name, git } : undefined);
    setRunning(false);
    if (why) setNote(why === 'exists' || why === 'still starting' ? reasonText(why) : t('startFailed', reasonText(why)));
  };
  const nameBad = mode === 'new' && name !== '' && !validName(name);
  const canGo = !!list && !running && (mode === 'open' || validName(name));

  return (
    <Dialog open={mode !== null} onOpenChange={(o) => { if (!o && !running) setMode(null); }}>
      <DialogContent className="flex max-h-[80vh] w-[520px] max-w-[92vw] flex-col gap-2">
        <DialogTitle>{mode === 'new' ? t('startNewTitle') : t('startOpenTitle')}</DialogTitle>
        <div className="flex items-center gap-1.5">
          <button type="button" className={btn} disabled={!list?.parent || running} onClick={() => list?.parent && void browse(list.parent)}>{t('startUp')}</button>
          <button type="button" className={btn} disabled={running} onClick={() => void browse(list?.home)}>{t('startHome')}</button>
          <input aria-label={t('startPath')} value={typed} onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (!isAbsolute(typed.trim())) return setNote(t('startPathAbs'));
              void browse(typed.trim());
            }}
            className="min-w-0 flex-1 rounded-md border border-border-soft bg-transparent px-2 py-1 font-mono text-[0.6875rem] text-foreground outline-none focus-visible:border-input-focus" />
        </div>
        <div className="min-h-40 overflow-auto rounded-md border border-border-soft p-1">
          {list && list.dirs.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('startEmpty')}</div>}
          {list?.dirs.map((d) => (
            <button key={d.name} type="button" disabled={running} onClick={() => void browse(join(list.path, d.name))}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-foreground hover:bg-muted">
              <span className="flex-1 truncate">{d.name}</span>
              {d.git && <span aria-hidden className="font-mono text-[0.625rem] text-muted-foreground">git</span>}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); void browse(list?.path, e.target.checked); }} />
          {t('startHidden')}
        </label>
        {mode === 'new' && (
          <div className="flex flex-col gap-1.5">
            {list && <div className="truncate font-mono text-[0.6875rem] text-muted-foreground">{t('startIn', list.path)}</div>}
            <input aria-label={t('startName')} placeholder={t('startName')} value={name} onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-border-soft bg-transparent px-2 py-1 text-xs text-foreground outline-none focus-visible:border-input-focus" />
            {nameBad && <div className="text-xs text-destructive">{t('startNameBad')}</div>}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} />
              {t('startGit')}
            </label>
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
          <button type="button" className={primary} disabled={!canGo} onClick={() => void go()}>{mode === 'new' ? t('startCreate') : t('startOpen')}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
