// Epic 383 2e (issue 405): the other agents of this tab's folder, as tabs right after the chat's, and + to add one. A tab is
// an agent of the same computer (this one, or the one whose page this is) on the same folder; a click moves this tab to
// it, as the switcher does. + starts a new agent of an installed kind on the folder, or (issue 620) on another worktree
// of its repository, and moves there; an agent in such a worktree is a tab of the project too, named with its branch.
// Helpers an agent started (2g) sit under their lead as one group (a count and their state dots), not as tabs; on a
// helper's own page, Keep makes it an agent of the project. ✕ on a tab closes that agent after a confirm (issue 636).
// Issue 638: this page's agent is the chat's tab, in its place among the others (agentOrder.ts); a drag reorders them.
import { useEffect, useState } from 'react';
import { connections, DROP_MARK, remotePage, routes, send, toast, useChatTab, useDragOrder, useSources, useT } from '@/sdk';
import type { ReactNode } from 'react';
import { AgentIcon, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, ConfirmDialog, Svg, Tooltip, TooltipContent, TooltipTrigger } from '@/sdk/ui';
import { enterProject, openFolder, PROVIDER_LABEL, reasonText, stopProject, useProjects, type Provider, type RunningRow } from './api.ts';
import { badgeOf } from './rows.ts';
import { agentKey, moveAgent, ordered, useAgentOrder } from './agentOrder.ts';
import { BadgeView, DOT, LIVE, STATE_KEY } from './Tile.tsx';

/** the strip's agents as last drawn: what Alt+[ / Alt+] go through (phase 3) */
let order: RunningRow[] = [];

/** Moves this tab `step` agents along the strip's order (wrapping); nothing with one agent. */
export function cycleAgent(step: 1 | -1): void {
  if (order.length < 2) return;
  const i = Math.max(0, order.findIndex((r) => r.current));
  void enterProject(order[(i + order.length + step) % order.length]!);
}

export function AgentTabs() {
  const t = useT();
  const { data } = useProjects(false);
  const [kinds, setKinds] = useState<Provider[]>([]);
  const [closing, setClosing] = useState<RunningRow | null>(null);
  const saved = useAgentOrder();
  const chat = useChatTab();
  const remote = remotePage();
  // the repository's other worktrees (the files' sources): folder -> branch
  const trees = new Map(useSources().flatMap((x) => (x.kind === 'worktree' && x.dir ? [[x.dir, x.label] as const] : [])));
  useEffect(() => {
    if (remote) return;
    let gone = false;
    connections.current().fetch(routes.systemAgents()).then((r) => (r.ok ? r.json() : null)).then((j: { agents?: Provider[] } | null) => {
      if (!gone && j && Array.isArray(j.agents)) setKinds(j.agents);
    }).catch(() => {});
    return () => { gone = true; };
  }, [remote]);
  const here = data?.running.find((r) => r.current);
  if (!here) { order = []; return <>{chat}</>; }
  const same = (r: RunningRow) => (r.root === here.root || (!here.remote && trees.has(r.root))) && r.remote?.host === here.remote?.host;
  const others = data!.running.filter((r) => !r.current && same(r) && LIVE.has(r.state));
  // a helper whose lead is here (this agent or a tab) goes in its lead's group
  const ids = new Set([here.id, ...others.map((r) => r.id)].filter(Boolean));
  const grouped = (r: RunningRow) => !!r.lead && ids.has(r.lead);
  const helpersOf = (id: string | undefined) => (id ? others.filter((r) => r.lead === id) : []);
  // in the server's order (folder, agent, start), then the saved one
  order = ordered(data!.running.filter((r) => r === here || (others.includes(r) && !grouped(r))), saved);
  const shown = order;
  const move = (from: string, to: string, after: boolean) => moveAgent(shown, from, to, after);
  const keep = async () => {
    const r = await send('/agent/keep', {}).catch(() => null);
    if (!r?.ok) toast(t('helperKeep'), t('whyBadRequest'));
  };
  const add = async (dir: string, p: Provider) => {
    const why = await openFolder(dir, p, undefined, undefined, true);
    if (why) toast(t('projEnterFailed', reasonText(why)), dir);
  };
  const close = async (r: RunningRow) => {
    setClosing(null);
    const why = await stopProject(r);
    if (why) toast(t('agentClose'), reasonText(why));
  };
  const choices = (dir: string) => kinds.map((p) => <DropdownMenuItem key={p} onSelect={() => void add(dir, p)}><AgentIcon provider={p} />{PROVIDER_LABEL[p]}</DropdownMenuItem>);
  return (
    <>
      {shown.map((r) => (
        <Place key={agentKey(r)} id={agentKey(r)} move={move}>
          {r === here ? chat : <AgentTab r={r} branch={r.root === here.root ? undefined : trees.get(r.root)} onClose={r.agent && !r.remote && !remote ? () => setClosing(r) : undefined} />}
          {r === here && here.lead && !remote && (
            <button type="button" title={t('helperKeepTip')} onClick={() => void keep()} className="ml-1 h-6 flex-none rounded-md border border-border-soft px-2 text-[0.6875rem] text-muted-foreground hover:text-foreground">
              {t('helperKeep')}
            </button>
          )}
          <HelperGroup helpers={helpersOf(r.id)} />
        </Place>
      ))}
      {!remote && kinds.length > 0 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={t('agentAdd')} className="grid size-7 flex-none place-items-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                  <Svg size={14}><path d="M12 5v14M5 12h14" /></Svg>
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('agentAdd')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">
            {choices(here.root)}
            {trees.size > 0 && <DropdownMenuSeparator />}
            {[...trees].map(([dir, branch]) => (
              <DropdownMenuSub key={dir}>
                <DropdownMenuSubTrigger>{branch}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>{choices(dir)}</DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {closing && (
        <ConfirmDialog title={t('agentCloseQ')} body={t('agentCloseBody', agentName(closing))} confirm={t('agentClose')} danger
          onConfirm={() => void close(closing)} onCancel={() => setClosing(null)} />
      )}
    </>
  );
}

const agentName = (r: RunningRow) => [PROVIDER_LABEL[r.provider], r.title].filter(Boolean).join(' · ');

/** An agent's place in the strip (its tab, its helpers), which a drag moves among the others. */
function Place({ id, move, children }: { id: string; move: (from: string, to: string, after: boolean) => void; children: ReactNode }) {
  return <span {...useDragOrder('application/x-nb-agent', id, move)} className={`flex flex-none items-center rounded-lg ${DROP_MARK}`}>{children}</span>;
}

/** A lead's helpers: their count and state dots; its menu opens one. */
function HelperGroup({ helpers }: { helpers: RunningRow[] }) {
  const t = useT();
  if (helpers.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={t('helpersOf', helpers.length)} title={t('helpersOf', helpers.length)}
          className="flex h-6 flex-none items-center gap-1 rounded-md px-1.5 text-[0.6875rem] text-muted-foreground hover:bg-muted/50 hover:text-foreground">
          <span>{helpers.length}</span>
          {helpers.map((h) => <span key={h.id ?? h.port} data-dot aria-hidden className={`size-1.5 rounded-full ${DOT[h.state]}`} />)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {helpers.map((h) => (
          <DropdownMenuItem key={h.id ?? h.port} onSelect={() => void enterProject(h)}>
            <span aria-hidden className={`size-1.5 flex-none rounded-full ${DOT[h.state]}`} />
            <AgentIcon provider={h.provider} />
            {[PROVIDER_LABEL[h.provider], h.title].filter(Boolean).join(' · ')}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Another agent of the project, a tab of the strip's look: its state, its kind (its vendor's mark and name), its worktree's branch, its session's title, its badge, and ✕ when it can be closed from here. */
function AgentTab({ r, branch, onClose }: { r: RunningRow; branch?: string | undefined; onClose?: (() => void) | undefined }) {
  const t = useT();
  const name = PROVIDER_LABEL[r.provider];
  return (
    <div
      role="tab"
      tabIndex={-1}
      aria-selected={false}
      aria-label={[name, branch, r.title, t(STATE_KEY[r.state])].filter(Boolean).join(' · ')}
      onClick={() => void enterProject(r)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void enterProject(r); } }}
      className="flex h-7 max-w-[220px] flex-none cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[0.78125rem] font-medium whitespace-nowrap text-muted-foreground hover:bg-muted/50 hover:text-foreground"
    >
      <span aria-hidden className={`size-1.5 flex-none rounded-full ${DOT[r.state]}`} />
      <AgentIcon provider={r.provider} />
      <span className="text-foreground/80">{name}</span>
      {branch && <span className="rounded bg-muted px-1 text-[0.6875rem]">{branch}</span>}
      {r.title && <span className="truncate">{r.title}</span>}
      <BadgeView b={badgeOf([r])} />
      {onClose && (
        <button type="button" aria-label={`${t('agentClose')}: ${agentName(r)}`} title={t('agentClose')}
          onClick={(e) => { e.stopPropagation(); onClose(); }} onKeyDown={(e) => e.stopPropagation()}
          className="grid size-[18px] flex-none place-items-center rounded-[5px] opacity-50 hover:bg-muted hover:opacity-100">
          <Svg size={10}><path d="M18 6 6 18M6 6l12 12" /></Svg>
        </button>
      )}
    </div>
  );
}
