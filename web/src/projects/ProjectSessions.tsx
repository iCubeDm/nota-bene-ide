// A project's sessions in the switcher, of every agent with a window on the folder: this window's from its own /sessions,
// another window's through this server (/system/projects/sessions). Choosing one in this window switches it (with the
// Sessions confirm); in another window moves the tab there and that window opens it (`&s=`, landing.ts). New session: one
// entry per installed agent, in its window when it has one there, else a window of that agent is opened on the folder.
// Rename, archive and delete stay in the Sessions menu of the line above the chat.
import { useEffect, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { ConfirmDialog } from '@/controls/ConfirmDialog.tsx';
import { ago } from '@/controls/SessionPicker.tsx';
import { switchSession } from '@/controls/slice.ts';
import { REFUSED } from '@/controls/useNote.ts';
import { apiFetch } from '@/net/auth.ts';
import { toast } from '@/shell/toast.ts';
import { useAppDispatch } from '@/store/store.ts';
import { enterProject, openFolder, postJson, PROVIDER_LABEL, reasonText, type Provider, type RunningRow } from './api.ts';

export type LocalSession = { id: string; title: string; at: number; cwd: string; archived?: true };
type Item = { id: string; title: string; at: number; window: RunningRow };
const SHOWN = 8;
const LIVE = new Set(['working', 'waiting', 'idle']);
const rowCls = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted disabled:cursor-default';

export function ProjectSessions({ root, windows, local, onDone }: { root: string; windows: RunningRow[]; local: LocalSession[]; onDone: () => void }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const [others, setOthers] = useState<Item[]>([]);
  const [agents, setAgents] = useState<Provider[]>([]);
  const [all, setAll] = useState(false);
  const [ask, setAsk] = useState<{ id: string | null; title: string } | null>(null);
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
    ...(mine ? local.filter((s) => !s.archived && s.cwd === root).map((s) => ({ id: s.id, title: s.title, at: s.at, window: mine })) : []),
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
  const fresh = async (agent: Provider) => {
    const w = live.find((x) => x.provider === agent);
    if (w?.current) return setAsk({ id: null, title: '' });
    onDone();
    if (w) return void enterProject(w, 'new');
    const why = await openFolder(root, agent);
    if (why) toast(t('startFailed', reasonText(why)), root);
  };

  return (
    <div role="group" aria-label={t('projSessionsOf', folder)} className="pb-1 pl-12">
      {shown.map((x) => {
        const open = x.id === x.window.session;
        const unseen = open && !x.window.current ? x.window.unseen : 0;
        return (
          <button key={`${x.window.provider}${x.id}`} type="button" onClick={() => choose(x)} aria-current={open && x.window.current ? true : undefined}
            className={`${rowCls} ${open && x.window.current ? 'bg-primary/10' : ''}`}>
            <span className="min-w-0 flex-1 truncate text-foreground">{x.title || t('untitled')} · {PROVIDER_LABEL[x.window.provider]}</span>
            {unseen > 0 && <span className="rounded-full bg-primary px-1.5 text-[0.625rem] font-semibold leading-4 text-primary-foreground">{unseen}</span>}
            <span className="flex-none text-[0.6875rem] text-muted-foreground">{ago(x.at)}</span>
          </button>
        );
      })}
      {items.length > SHOWN && !all && (
        <button type="button" onClick={() => setAll(true)} className={`${rowCls} text-muted-foreground`}>{t('projMore', items.length)}</button>
      )}
      {agents.map((a) => (
        <button key={a} type="button" onClick={() => void fresh(a)} className={`${rowCls} text-link`}>{t('projNewWith', PROVIDER_LABEL[a])}</button>
      ))}
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
