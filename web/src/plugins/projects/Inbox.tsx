// The server's home page's inbox (issue 651): every agent of the projects list, by what it needs from the person (waiting
// for an answer, done and unread, working, idle), each group with its count. An agent of this server that waits shows its
// open asks, oldest first, answered here (answerAsk); one of another server or computer has none and offers to open it.
import { useState } from 'react';
import type { InteractionAnswer } from '@nota-bene/shared';
import { useT, ago, toast } from '@/sdk';
import { AgentIcon, PermissionCard } from '@/sdk/ui';
import { answerAsk, enterProject, openStarter, PROVIDER_LABEL, useProjects, type RunningRow } from './api.ts';
import { folderOf, STATE_KEY, Tile } from './Tile.tsx';

type Group = 'waiting' | 'unread' | 'working' | 'idle';
const GROUPS: { id: Group; head: 'inboxWaiting' | 'inboxUnread' | 'inboxWorking' | 'inboxIdle' }[] = [
  { id: 'waiting', head: 'inboxWaiting' }, { id: 'unread', head: 'inboxUnread' }, { id: 'working', head: 'inboxWorking' }, { id: 'idle', head: 'inboxIdle' },
];
const groupOf = (r: RunningRow): Group =>
  r.state === 'waiting' ? 'waiting' : r.state === 'working' ? 'working' : r.state === 'idle' && r.unseen > 0 ? 'unread' : 'idle';
const byFolder = (a: RunningRow, b: RunningRow) => folderOf(a.root).localeCompare(folderOf(b.root), undefined, { sensitivity: 'base' }) || a.root.localeCompare(b.root);
const btn = 'cursor-pointer rounded-md px-2.5 py-1 text-xs';

export function Inbox() {
  const t = useT();
  const { data, reload } = useProjects(true);
  // the asks answered from here: gone at once, not when the next list comes (a second click would find them settled)
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const running = (data?.running ?? []).map((r) => (r.asks ? { ...r, asks: r.asks.filter((a) => !sent.has(a.id)) } : r));
  const answer = async (r: RunningRow, id: string, allow: boolean, response?: InteractionAnswer) => {
    if (sent.has(id)) return;
    setSent((s) => new Set(s).add(id));
    if (!(await answerAsk(r, id, allow, response))) {
      // not taken: shown again if it is still open
      setSent((s) => { const n = new Set(s); n.delete(id); return n; });
      toast(t('askGone'), folderOf(r.root));
    }
    reload();
  };
  return (
    <main aria-label={t('inbox')} className="mx-auto flex w-full max-w-[860px] flex-col gap-1 px-6 py-6">
      <h1 className="pb-2 text-lg font-semibold tracking-[-0.01em] text-foreground">{t('inbox')}</h1>
      {data && !running.length && (
        <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
          <p>{t('inboxEmpty')}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => openStarter('open')} className={`${btn} border border-border text-foreground hover:bg-muted`}>{t('projOpenFolder')}</button>
            <button type="button" onClick={() => openStarter('new')} className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}>{t('projNew')}</button>
          </div>
        </div>
      )}
      {GROUPS.map(({ id, head }) => {
        const rows = running.filter((r) => groupOf(r) === id).sort(byFolder);
        if (!rows.length) return null;
        return (
          <section key={id} aria-label={t(head, rows.length)} className="pb-3">
            <h2 className="pt-3 pb-2 text-[0.6875rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{t(head, rows.length)}</h2>
            <div className="flex flex-col gap-2">
              {rows.map((r) => <Item key={`${r.port} ${r.id ?? r.provider} ${r.remote?.host ?? ''}`} r={r} group={id} onAnswer={answer} />)}
            </div>
          </section>
        );
      })}
    </main>
  );
}

function Item({ r, group, onAnswer }: { r: RunningRow; group: Group; onAnswer(r: RunningRow, id: string, allow: boolean, response?: InteractionAnswer): Promise<void> }) {
  const t = useT();
  const folder = folderOf(r.root);
  const line = group === 'unread' ? r.last?.text : group === 'working' ? r.title ?? r.last?.text : null;
  return (
    <div data-inbox-item className={`rounded-[10px] border bg-card px-3 py-2.5 ${group === 'waiting' ? 'border-warn' : 'border-border'}`}>
      <button type="button" aria-label={`${folder} · ${PROVIDER_LABEL[r.provider]} · ${t(STATE_KEY[r.state])}`} onClick={() => void enterProject(r)}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md text-left">
        <Tile root={r.root} state={r.state} ring="border-card" />
        <span className="truncate text-[0.8125rem] font-semibold text-foreground">{folder}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground"><AgentIcon provider={r.provider} />{PROVIDER_LABEL[r.provider]}</span>
        {r.remote && <span className="truncate text-xs text-muted-foreground">{r.remote.name}</span>}
        {r.last?.at && <span className="ml-auto flex-none text-[0.6875rem] text-muted-foreground">{ago(r.last.at)}</span>}
      </button>
      {line && <p className="mt-1.5 line-clamp-2 pl-[42px] text-xs text-muted-foreground">{line}</p>}
      {group === 'waiting' && (r.asks?.length
        ? <div className="pl-[42px]">{r.asks.map((a) => <PermissionCard key={a.id} ask={a} onAnswer={(allow, res) => void onAnswer(r, a.id, allow, res)} />)}</div>
        : <div className="mt-2 pl-[42px]"><button type="button" onClick={() => void enterProject(r)} className={`${btn} border border-border text-foreground hover:bg-muted`}>{t('inboxOpen')}</button></div>)}
    </div>
  );
}
