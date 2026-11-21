// A project's look, shared by the header's switcher and the rail: its tile (two letters on a colour of its own, with the
// state dot) and its one badge; the state names and which states have a window to move to.
import { ICONS, Svg } from '@/sdk/ui';
import type { ProjectState } from './api.ts';
import { initials, type Badge } from './rows.ts';

export const folderOf = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;
const DOT: Record<ProjectState, string> = {
  working: 'animate-pulse bg-nb-accent', waiting: 'bg-warn', idle: 'bg-success', restarting: 'bg-muted-foreground/30', silent: 'bg-destructive/60',
};
export const STATE_KEY = { working: 'projWorking', waiting: 'projWaiting', idle: 'projIdle', restarting: 'projRestarting', silent: 'projSilent' } as const;
export const LIVE = new Set<ProjectState>(['working', 'waiting', 'idle']);

// the theme's accents, tinted: readable in every theme
const TILES = ['bg-accent-agent/20 text-accent-agent', 'bg-accent-model/20 text-accent-model', 'bg-accent-sessions/20 text-accent-sessions',
  'bg-accent-usage/20 text-accent-usage', 'bg-primary/20 text-primary', 'bg-success/20 text-success', 'bg-warn/20 text-warn'];

/**
 * Two letters of its session's title (issue 509), else of the folder, on a colour picked by its path: the same project looks
 * the same everywhere, whatever its session. `ring`: the dot's edge, the surface's colour. `remote`: another computer's
 * (issue 297), a laptop in the corner.
 */
export function Tile({ root, title, state, remote, ring = 'border-popover' }: { root: string; title?: string | null; state?: ProjectState; remote?: boolean; ring?: string }) {
  let h = 0;
  for (const c of root) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span aria-hidden className={`relative flex size-8 flex-none items-center justify-center rounded-lg text-[0.6875rem] font-bold ${TILES[h % TILES.length]}`}>
      {initials(title ?? '') || initials(folderOf(root)) || '?'}
      {state && <span className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 ${ring} ${DOT[state]}`} />}
      {remote && <span data-remote className={`absolute -bottom-1 -left-1 rounded-sm p-px text-muted-foreground ${ring === 'border-chrome' ? 'bg-chrome' : 'bg-popover'}`}><Svg size={10}>{ICONS.laptop}</Svg></span>}
    </span>
  );
}

export function BadgeView({ b }: { b: Badge }) {
  if (b === null) return null;
  return <span data-badge className={`min-w-4 rounded-full px-1.5 text-center text-[0.625rem] font-semibold leading-4 ${b === '!' ? 'bg-warn text-background' : 'bg-primary text-primary-foreground'}`}>{b}</span>;
}

/** A row's own badge: `!` while an agent of it waits for the person, else its unseen replies, else none. */
export const rowBadge = (r: { state: ProjectState; unseen: number }): Badge => (r.state === 'waiting' ? '!' : r.unseen > 0 ? r.unseen : null);
