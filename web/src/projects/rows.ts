// The chat list's rows: one per folder over the windows of every agent in it, and the one badge that sums them up.
import type { LastMessage, ProjectState, RunningRow } from './api.ts';

export type ProjectRow = { root: string; windows: RunningRow[]; state: ProjectState; unseen: number; last: LastMessage | null; current: boolean };
export type Badge = '!' | number | null;

const URGENCY: ProjectState[] = ['waiting', 'working', 'idle', 'silent', 'restarting'];
const atOf = (x: { last: LastMessage | null }) => x.last?.at ?? 0;
const folderOf = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;

/** The windows grouped by folder: the most urgent state, the summed unseen, the newest message; waiting first, then unseen, then the rest. */
export function foldRows(running: RunningRow[]): ProjectRow[] {
  const by = new Map<string, RunningRow[]>();
  for (const r of running) by.set(r.root, [...(by.get(r.root) ?? []), r]);
  const rows = [...by].map(([root, ws]): ProjectRow => {
    const windows = [...ws].sort((a, b) => atOf(b) - atOf(a));
    return {
      root, windows,
      state: URGENCY.find((s) => windows.some((w) => w.state === s)) ?? 'idle',
      unseen: windows.reduce((n, w) => n + w.unseen, 0),
      last: windows[0]!.last,
      current: windows.some((w) => w.current),
    };
  });
  const group = (r: ProjectRow) => (r.state === 'waiting' ? 0 : r.unseen > 0 ? 1 : 2);
  return rows.sort((a, b) => group(a) - group(b) || atOf(b) - atOf(a) || folderOf(a.root).localeCompare(folderOf(b.root)) || a.root.localeCompare(b.root));
}

/** One badge over the projects other than this one: `!` when any waits for the person, else the unseen replies, else none. */
export function badgeOf(rows: { state: ProjectState; unseen: number; current: boolean }[]): Badge {
  const others = rows.filter((r) => !r.current);
  if (others.some((r) => r.state === 'waiting')) return '!';
  const n = others.reduce((s, r) => s + r.unseen, 0);
  return n > 0 ? n : null;
}

export const titlePrefix = (b: Badge): string => (b === null ? '' : `(${b}) `);
