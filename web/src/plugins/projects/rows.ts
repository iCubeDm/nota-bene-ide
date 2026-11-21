// The chat list's rows: one per folder over the windows of every agent in it, and the one badge that sums them up.
import type { LastMessage, ProjectState, RunningRow } from './api.ts';

/** `key`: the folder, qualified by its computer for another one's (issue 297: the same path may be on both) */
export type ProjectRow = {
  key: string; root: string; remote?: RunningRow['remote']; windows: RunningRow[]; state: ProjectState; unseen: number; last: LastMessage | null; current: boolean;
};
export type Badge = '!' | number | null;

const URGENCY: ProjectState[] = ['waiting', 'working', 'idle', 'silent', 'restarting'];
const atOf = (x: { last: LastMessage | null }) => x.last?.at ?? 0;
const folderOf = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;

/** A folder's row key: its path, qualified by its computer for another one's. */
export const rowKey = (root: string, host?: string): string => (host ? `${host}\n${root}` : root);
const keyOf = (r: RunningRow) => rowKey(r.root, r.remote?.host);

/** The windows grouped by folder (and computer): the most urgent state, the summed unseen, the newest message; waiting first, then unseen, then the rest. */
export function foldRows(running: RunningRow[]): ProjectRow[] {
  const by = new Map<string, RunningRow[]>();
  for (const r of running) by.set(keyOf(r), [...(by.get(keyOf(r)) ?? []), r]);
  const rows = [...by].map(([key, ws]): ProjectRow => {
    const windows = [...ws].sort((a, b) => atOf(b) - atOf(a));
    return {
      key, root: ws[0]!.root, ...(ws[0]!.remote ? { remote: ws[0]!.remote } : {}), windows,
      state: URGENCY.find((s) => windows.some((w) => w.state === s)) ?? 'idle',
      unseen: windows.reduce((n, w) => n + w.unseen, 0),
      last: windows[0]!.last,
      current: windows.some((w) => w.current),
    };
  });
  const group = (r: ProjectRow) => (r.state === 'waiting' ? 0 : r.unseen > 0 ? 1 : 2);
  return rows.sort((a, b) => group(a) - group(b) || atOf(b) - atOf(a) || folderOf(a.root).localeCompare(folderOf(b.root)) || a.key.localeCompare(b.key));
}

/** One badge over the projects other than this one: `!` when any waits for the person, else the unseen replies, else none. */
export function badgeOf(rows: { state: ProjectState; unseen: number; current: boolean }[]): Badge {
  const others = rows.filter((r) => !r.current);
  if (others.some((r) => r.state === 'waiting')) return '!';
  const n = others.reduce((s, r) => s + r.unseen, 0);
  return n > 0 ? n : null;
}

/**
 * issue 509: a tile's letters from any text: the initials of its first two words, else a lone word's first two characters,
 * else '' (no letters or digits). By code point, marks kept inside a word, uppercased before the cut: at most two.
 */
export function initials(text: string): string {
  const words = (text.normalize('NFC').match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? []).map((w) => [...w.toUpperCase()]);
  return (words.length > 1 ? [words[0]![0], words[1]![0]] : (words[0] ?? []).slice(0, 2)).join('');
}

/** A row's session title: this window's own when it has one, else the first window's with one. */
export const rowTitle = (r: Pick<ProjectRow, 'windows'>): string | null =>
  (r.windows.find((w) => w.current && w.title) ?? r.windows.find((w) => w.title))?.title ?? null;

export const titlePrefix = (b: Badge): string => (b === null ? '' : `(${b}) `);
