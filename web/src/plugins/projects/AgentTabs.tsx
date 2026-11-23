// Epic 383 2e (issue 405): the other agents of this tab's folder, as tabs right after the chat's, and + to add one. A tab is
// an agent of the same computer (this one, or the one whose page this is) on the same folder; a click moves this tab to
// it, as the switcher does. + starts a new agent of an installed kind on the folder and moves there.
import { useEffect, useState } from 'react';
import { connections, remotePage, routes, toast, useT } from '@/sdk';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Svg, Tooltip, TooltipContent, TooltipTrigger } from '@/sdk/ui';
import { enterProject, openFolder, PROVIDER_LABEL, reasonText, useProjects, type Provider, type RunningRow } from './api.ts';
import { badgeOf } from './rows.ts';
import { BadgeView, DOT, LIVE, STATE_KEY } from './Tile.tsx';

export function AgentTabs() {
  const t = useT();
  const { data } = useProjects(false);
  const [kinds, setKinds] = useState<Provider[]>([]);
  const remote = remotePage();
  useEffect(() => {
    if (remote) return;
    let gone = false;
    connections.current().fetch(routes.systemAgents()).then((r) => (r.ok ? r.json() : null)).then((j: { agents?: Provider[] } | null) => {
      if (!gone && j && Array.isArray(j.agents)) setKinds(j.agents);
    }).catch(() => {});
    return () => { gone = true; };
  }, [remote]);
  const here = data?.running.find((r) => r.current);
  if (!here) return null;
  const same = (r: RunningRow) => r.root === here.root && r.remote?.host === here.remote?.host;
  const others = data!.running.filter((r) => !r.current && same(r) && LIVE.has(r.state));
  const add = async (p: Provider) => {
    const why = await openFolder(here.root, p, undefined, undefined, true);
    if (why) toast(t('projEnterFailed', reasonText(why)), here.root);
  };
  return (
    <>
      {others.map((r) => <AgentTab key={`${r.port}/${r.agent ?? r.provider}`} r={r} />)}
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
            {kinds.map((p) => <DropdownMenuItem key={p} onSelect={() => void add(p)}>{PROVIDER_LABEL[p]}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

/** Another agent of the folder, a tab of the strip's look: its state, its kind, its session's title, its badge. */
function AgentTab({ r }: { r: RunningRow }) {
  const t = useT();
  const name = PROVIDER_LABEL[r.provider];
  return (
    <div
      role="tab"
      tabIndex={-1}
      aria-selected={false}
      aria-label={[name, r.title, t(STATE_KEY[r.state])].filter(Boolean).join(' · ')}
      onClick={() => void enterProject(r)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void enterProject(r); } }}
      className="flex h-7 max-w-[220px] flex-none cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[0.78125rem] font-medium whitespace-nowrap text-muted-foreground hover:bg-muted/50 hover:text-foreground"
    >
      <span aria-hidden className={`size-1.5 flex-none rounded-full ${DOT[r.state]}`} />
      <span className="text-foreground/80">{name}</span>
      {r.title && <span className="truncate">{r.title}</span>}
      <BadgeView b={badgeOf([r])} />
    </div>
  );
}
