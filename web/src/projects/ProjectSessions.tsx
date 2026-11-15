// A project's sessions in the switcher, of every agent with a window on the folder: this window's from its own /sessions,
// another window's through this server (/system/projects/sessions). Choosing one in this window switches it (with the
// Sessions confirm); in another window moves the tab there and that window opens it (`&s=`, landing.ts). New session: one
// entry per installed agent, in its window when it has one there, else a window of that agent is opened on the folder.
// This window's sessions are renamed and archived from their row (the time gives way on hover); delete stays in the
// Sessions menu (▾ on the chat tab). Another window's are only opened: its server takes no write from this one.
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useT } from '@/i18n/index.ts';
import { ConfirmDialog } from '@/controls/ConfirmDialog.tsx';
import { ago, ArchiveIcon } from '@/controls/SessionPicker.tsx';
import { switchSession } from '@/controls/slice.ts';
import { REFUSED } from '@/controls/useNote.ts';
import { archiveSession, renameSession } from '@/controls/sessionsApi.ts';
import { apiFetch } from '@/net/auth.ts';
import { toast } from '@/shell/toast.ts';
import { useAppDispatch } from '@/store/store.ts';
import { enterProject, openFolder, postJson, PROVIDER_LABEL, reasonText, type Provider, type RunningRow } from './api.ts';

export type LocalSession = { id: string; title: string; at: number; cwd: string; archived?: true };
type Item = { id: string; title: string; at: number; window: RunningRow; mine?: true };
const SHOWN = 8;
const LIVE = new Set(['working', 'waiting', 'idle']);
const ACTION = 'rounded px-1 text-xs text-muted-foreground hover:text-foreground';
const rowCls = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted disabled:cursor-default';

export function ProjectSessions({ root, windows, local, setLocal, onDone }: {
  root: string; windows: RunningRow[]; local: LocalSession[]; setLocal: Dispatch<SetStateAction<LocalSession[]>>; onDone: () => void;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  const [others, setOthers] = useState<Item[]>([]);
  const [agents, setAgents] = useState<Provider[]>([]);
  const [all, setAll] = useState(false);
  const [ask, setAsk] = useState<{ id: string | null; title: string } | null>(null);
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const folder = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
  const live = windows.filter((w) => LIVE.has(w.state));
  const mine = live.find((w) => w.current);

  useEffect(() => {
    let gone = false;
    void Promise.all(live.filter((w) => !w.current).map(async (w) => {
      try {
        const r = await postJson('/system/projects/sessions', { provider: w.provider, port: w.port, root: w.root });
        if (!r.ok) return [];
        const v = (await r.json()) as { sessions?: { id: string; title: string; at: number; archived?: true }[] };
        return (v.sessions ?? []).filter((x) => !x.archived).map((x) => ({ id: x.id, title: x.title, at: x.at, window: w }));
      } catch {
        return [];
      }
    })).then((lists) => { if (!gone) setOthers(lists.flat()); });
    apiFetch('/system/agents').then((r) => (r.ok ? r.json() : null)).then((j: { agents?: Provider[] } | null) => {
      if (!gone && j && Array.isArray(j.agents)) setAgents(j.agents);
    }).catch(() => {});
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per expansion: the menu's poll must not refetch every window's list
  }, [root]);

  const items: Item[] = [
    ...(mine ? local.filter((s) => !s.archived && s.cwd === root).map((s) => ({ id: s.id, title: s.title, at: s.at, window: mine, mine: true as const })) : []),
    ...others,
  ].sort((a, b) => b.at - a.at);
  const shown = all ? items : items.slice(0, SHOWN);

  const choose = (x: Item) => {
    if (x.window.current) {
      if (x.id === x.window.session) return;
      setAsk({ id: x.id, title: x.title || t('untitled') });
      return;
    }
    onDone();
    void enterProject(x.window, x.id);
  };
  const rename = async () => {
    if (!edit) return;
    const title = edit.text.trim();
    const failed = await renameSession(edit.id, title);
    if (failed !== null) return toast(t('renameFail') + failed, root);
    setLocal((l) => l.map((x) => (x.id === edit.id ? { ...x, title } : x)));
    setEdit(null);
  };
  const archive = async (id: string) => {
    const failed = await archiveSession(id, true);
    if (failed !== null) return toast(t('archiveFail') + failed, root);
    setLocal((l) => l.map((x) => (x.id === id ? { ...x, archived: true as const } : x)));
  };
  const [pick, setPick] = useState<Provider | null>(null);
  const picked = pick ? live.find((x) => x.provider === pick) : undefined;
  // the agent of a window here first (this window's when it is one), else the first installed
  const firstAgent = (): Provider | null => (mine ?? live[0])?.provider ?? agents[0] ?? null;
  const fresh = async (agent: Provider) => {
    const w = live.find((x) => x.provider === agent);
    onDone();
    if (w?.current) {
      const r = dispatch(switchSession(null, root));
      if (r !== 'sent') toast(t('switchFail') + t(REFUSED[r]), root);
      return;
    }
    if (w) return void enterProject(w, 'new');
    const why = await openFolder(root, agent);
    if (why) toast(t('startFailed', reasonText(why)), root);
  };

  return (
    <div role="group" aria-label={t('projSessionsOf', folder)} className="pb-1 pl-12">
      {shown.map((x) => {
        const open = x.id === x.window.session;
        const unseen = open && !x.window.current ? x.window.unseen : 0;
        const title = x.title || t('untitled');
        if (edit?.id === x.id) {
          return (
            <input
              key={x.id}
              autoFocus
              value={edit.text}
              maxLength={200}
              aria-label={t('renameSess')}
              placeholder={t('untitled')}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setEdit({ id: x.id, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void rename(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEdit(null); }
              }}
              onBlur={() => setEdit(null)}
              className="my-0.5 block w-full rounded-md border border-primary bg-transparent px-2 py-1 text-xs text-foreground outline-none"
            />
          );
        }
        return (
          <div key={`${x.window.provider}${x.id}`} className="group/row relative">
            <button type="button" onClick={() => choose(x)} aria-current={open && x.window.current ? true : undefined}
              className={`${rowCls} ${open && x.window.current ? 'bg-primary/10' : ''}`}>
              <span className="min-w-0 flex-1 truncate text-foreground">{title} · {PROVIDER_LABEL[x.window.provider]}</span>
              {unseen > 0 && <span className="rounded-full bg-primary px-1.5 text-[0.625rem] font-semibold leading-4 text-primary-foreground">{unseen}</span>}
              <span className={`flex-none text-[0.6875rem] text-muted-foreground ${x.mine ? 'group-focus-within/row:invisible group-hover/row:invisible' : ''}`}>{ago(x.at)}</span>
            </button>
            {/* in place of the time on hover: rename, and archive unless it is the open one (switch away first) */}
            {x.mine && (
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
                <button type="button" aria-label={`${t('renameSess')}: ${title}`} title={t('renameSess')} onClick={() => setEdit({ id: x.id, text: x.title })} className={ACTION}>✎</button>
                {!open && (
                  <button type="button" aria-label={`${t('archiveSess')}: ${title}`} title={t('archiveSess')} onClick={() => void archive(x.id)} className={ACTION}>
                    <ArchiveIcon />
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {items.length > SHOWN && !all && (
        <button type="button" onClick={() => setAll(true)} className={`${rowCls} text-muted-foreground`}>{t('projMore', items.length)}</button>
      )}
      <button type="button" onClick={() => setPick(firstAgent())} className={`${rowCls} text-link`}>{t('projNewSess')}</button>
      {pick && (
        <ConfirmDialog
          title={t('newQ')}
          // a new session in this window replaces the open one here: the switch warning; elsewhere nothing is replaced
          body={picked?.current ? t(pick === 'codex' ? 'switchWarnCodex' : pick === 'omp' ? 'switchWarnOmp' : 'switchWarn').trim() : ''}
          confirm={t('projNewSessStart')}
          onConfirm={() => { const a = pick; setPick(null); void fresh(a); }}
          onCancel={() => setPick(null)}
        >
          <div role="radiogroup" aria-label={t('startAgent')} className="flex flex-wrap gap-2">
            {agents.map((a) => (
              <label key={a} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${a === pick ? 'border-primary text-foreground' : 'border-border-soft text-muted-foreground'}`}>
                <input type="radio" name="nb-new-agent" aria-label={PROVIDER_LABEL[a]} checked={a === pick} onChange={() => setPick(a)} className="accent-primary" />
                {PROVIDER_LABEL[a]}
              </label>
            ))}
          </div>
        </ConfirmDialog>
      )}
      {ask && (
        <ConfirmDialog
          title={ask.id ? t('openQ', ask.title) : t('newQ')}
          body={t(mine?.provider === 'codex' ? 'switchWarnCodex' : mine?.provider === 'omp' ? 'switchWarnOmp' : 'switchWarn').trim()}
          confirm={t('switchBtn')}
          onConfirm={() => {
            const id = ask.id;
            setAsk(null);
            onDone();
            const r = dispatch(switchSession(id, root));
            if (r !== 'sent') toast(t('switchFail') + t(REFUSED[r]), root);
          }}
          onCancel={() => setAsk(null)}
        />
      )}
    </div>
  );
}
