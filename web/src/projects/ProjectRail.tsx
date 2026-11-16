// The open projects in a rail at the window's left edge (issue 419, a stopgap before one server for every project): a tile
// per folder running in any window, in a fixed order by name so nothing moves under the pointer, with its state dot and
// badge. A click moves this tab to that project the way the switcher does; + opens a folder. Settings can turn it off; a
// narrow window has no room for it.
import { useSyncExternalStore } from 'react';
import { useT } from '@/i18n/index.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { enterProject, openStarter, PROVIDER_LABEL, useProjects } from './api.ts';
import { useRailPref } from './railPref.ts';
import { foldRows, type ProjectRow } from './rows.ts';
import { BadgeView, folderOf, LIVE, rowBadge, STATE_KEY, Tile } from './Tile.tsx';

/** Below this width the rail would crowd the panes out: it is not shown (and not polled for). */
const WIDE = '(min-width: 768px)';
const subscribeWide = (f: () => void) => {
  const mq = window.matchMedia?.(WIDE);
  mq?.addEventListener('change', f);
  return () => mq?.removeEventListener('change', f);
};
const isWide = () => window.matchMedia?.(WIDE).matches ?? true;

/** By folder name, case-insensitive, then by the whole path: the order does not follow the states. */
export const byName = (a: ProjectRow, b: ProjectRow): number =>
  folderOf(a.root).localeCompare(folderOf(b.root), undefined, { sensitivity: 'base' }) || a.root.localeCompare(b.root);

export function ProjectRail() {
  const on = useRailPref();
  const wide = useSyncExternalStore(subscribeWide, isWide);
  return on && wide ? <Rail /> : null;
}

function Rail() {
  const t = useT();
  const { data } = useProjects(true);
  const rows = foldRows(data?.running ?? []).sort(byName);
  return (
    <nav aria-label={t('projRail')} data-rail className="flex w-11 flex-none flex-col items-center gap-1.5 overflow-y-auto border-r border-border-soft bg-chrome py-2">
      {rows.map((r) => {
        const live = r.windows.find((w) => LIVE.has(w.state));
        const go = !r.current && !!live;
        const latest = r.windows.find((w) => w.title)?.title;
        const agents = [...new Set(r.windows.map((w) => PROVIDER_LABEL[w.provider]))].join(', ');
        const lines = [folderOf(r.root), agents, t(STATE_KEY[r.state]), ...(latest ? [latest] : []), ...(r.current ? [t('projThis')] : [])];
        return (
          <Tooltip key={r.root}>
            <TooltipTrigger asChild>
              <button type="button" data-root={r.root} aria-label={lines.join(' · ')} aria-current={r.current ? 'true' : undefined}
                aria-disabled={!r.current && !live ? 'true' : undefined}
                onClick={() => { if (go) void enterProject(live); }}
                className={`relative grid flex-none place-items-center rounded-lg p-0.5 ${r.current ? 'bg-primary/15 ring-1 ring-primary/50' : go ? 'cursor-pointer hover:bg-muted' : 'cursor-default opacity-45'}`}>
                <Tile root={r.root} state={r.state} ring="border-chrome" />
                <span className="absolute -top-1 -right-1 flex">
                  <BadgeView b={rowBadge(r)} />
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <span className="flex flex-col">
                <b>{lines[0]}</b>
                {lines.slice(1).map((l, i) => <span key={i}>{l}</span>)}
              </span>
            </TooltipContent>
          </Tooltip>
        );
      })}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={t('projOpenFolder')} onClick={() => openStarter('open')}
            className="mt-auto grid size-8 flex-none cursor-pointer place-items-center rounded-lg border border-dashed border-border-soft text-base leading-none text-muted-foreground hover:bg-muted hover:text-foreground">+</button>
        </TooltipTrigger>
        <TooltipContent side="right">{t('projOpenFolder')}</TooltipContent>
      </Tooltip>
    </nav>
  );
}
