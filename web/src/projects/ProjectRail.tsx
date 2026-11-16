// The open projects in a rail at the window's left edge (issue 419, a stopgap before one server for every project): a tile
// per folder running in any window, in a fixed order by name so nothing moves under the pointer, with its state dot and
// badge. A click moves this tab to that project the way the switcher does; + opens a folder. Settings can turn it off; a
// narrow window has no room for it.
import { useState, useSyncExternalStore } from 'react';
import { useT } from '@/i18n/index.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { enterProject, openStarter, PROVIDER_LABEL, useProjects, type RunningRow } from './api.ts';
import { useRailPref } from './railPref.ts';
import { foldRows, type Badge, type ProjectRow } from './rows.ts';
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

/**
 * This project's tile stands for the other windows in its folder (another agent's): its badge counts only them, never this
 * window's own replies, and a click goes to the one that needs the person most (waiting, then unseen), else nowhere.
 */
export function siblingsOf(r: ProjectRow): { badge: Badge; target: RunningRow | undefined; waiting: RunningRow | undefined } {
  const others = r.windows.filter((w) => !w.current && LIVE.has(w.state));
  const waiting = others.find((w) => w.state === 'waiting');
  const unseen = others.filter((w) => w.unseen > 0).sort((a, b) => b.unseen - a.unseen);
  const n = others.reduce((s, w) => s + w.unseen, 0);
  return { badge: waiting ? '!' : n > 0 ? n : null, target: waiting ?? unseen[0], waiting };
}

export function ProjectRail() {
  const on = useRailPref();
  const wide = useSyncExternalStore(subscribeWide, isWide);
  // null: a new window that has not heard the server yet, so a rail turned off never flashes in
  return on === true && wide ? <Rail /> : null;
}

function Rail() {
  const t = useT();
  const { data, reload } = useProjects(true);
  const [moving, setMoving] = useState(false);
  const move = async (w: RunningRow) => {
    if (moving) return;
    setMoving(true);
    // a refusal (the window just went) shows the list as it is now. On success the page is leaving, but `moving` is cleared
    // too (issue 449): it guards only the request; a page brought back by Back, or a navigation cancelled before it
    // left, must take the next click
    const ok = await enterProject(w);
    setMoving(false);
    if (!ok) reload();
  };
  const rows = foldRows(data?.running ?? []).sort(byName);
  return (
    <nav aria-label={t('projRail')} data-rail className="flex w-11 flex-none flex-col items-center gap-1.5 overflow-y-auto border-r border-border-soft bg-chrome py-2">
      {rows.map((r) => {
        const sib = r.current ? siblingsOf(r) : null;
        const target = sib ? sib.target : r.windows.find((w) => LIVE.has(w.state));
        const go = !!target;
        const latest = r.windows.find((w) => w.title)?.title;
        const agents = [...new Set(r.windows.map((w) => PROVIDER_LABEL[w.provider]))].join(', ');
        const lines = [folderOf(r.root), agents, t(STATE_KEY[r.state]), ...(latest ? [latest] : []), ...(r.current ? [t('projThis')] : []),
          ...(sib?.waiting ? [t('projSiblingWaits', PROVIDER_LABEL[sib.waiting.provider])] : [])];
        return (
          <Tooltip key={r.root}>
            <TooltipTrigger asChild>
              <button type="button" data-root={r.root} aria-label={lines.join(' · ')} aria-current={r.current ? 'true' : undefined}
                aria-disabled={!r.current && !go ? 'true' : undefined}
                onClick={() => { if (target) void move(target); }}
                className={`relative grid flex-none place-items-center rounded-lg p-0.5 ${r.current ? `bg-primary/15 ring-1 ring-primary/50 ${go ? 'cursor-pointer' : 'cursor-default'}` : go ? 'cursor-pointer hover:bg-muted' : 'cursor-default opacity-45'}`}>
                <Tile root={r.root} state={r.state} ring="border-chrome" />
                <span className="absolute -top-1 -right-1 flex">
                  <BadgeView b={sib ? sib.badge : rowBadge(r)} />
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
