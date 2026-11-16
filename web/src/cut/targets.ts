// The edits that "Add to edit" in the Files tree can add to (issue 426): every edit of this folder open in a tab and
// editable registers itself while its view stands. The tree adds to the one shown most recently, through that view's own
// editing state, so the change is one step of its undo and is saved as any other edit (never a second writer of the file).
import { useSyncExternalStore } from 'react';

export type EditTarget = {
  /** the edit's project-relative path */
  path: string;
  /** appends these project files, in this order (CutBody: the first track of each one's kind) */
  add: (files: readonly string[]) => void | Promise<void>;
};

const targets = new Map<string, EditTarget>();
// when each edit was last shown (0: not since it opened): the larger, the more recent
const stamps = new Map<string, number>();
let clock = 0;
let current: EditTarget | null = null;
const subs = new Set<() => void>();

function tell(): void {
  let best: EditTarget | null = null;
  for (const t of targets.values()) if (!best || (stamps.get(t.path) ?? 0) >= (stamps.get(best.path) ?? 0)) best = t;
  current = best;
  for (const f of subs) f();
}

/** `t` can be added to until the returned function is called. */
export function registerEditTarget(t: EditTarget): () => void {
  targets.set(t.path, t);
  // no newer by registering: restored tabs load their edits in any order, the one shown last stays the one added to
  if (!stamps.has(t.path)) stamps.set(t.path, 0);
  tell();
  return () => {
    if (targets.get(t.path) !== t) return;
    targets.delete(t.path);
    tell();
  };
}

/** The edit at `path` is shown now: it becomes the one added to. */
export function touchEditTarget(path: string): void {
  stamps.set(path, ++clock);
  if (targets.has(path)) tell();
}

/** The edit shown most recently of those that can be added to; null when none is open. */
export const currentEditTarget = (): EditTarget | null => current;

const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
/** currentEditTarget, re-rendered when it changes. */
export const useEditTarget = (): EditTarget | null => useSyncExternalStore(subscribe, currentEditTarget);

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
/** How the menu names the edit at `path`: its file name, or its project path while another open edit has that name too. */
export function editTargetName(path: string): string {
  const name = base(path);
  for (const t of targets.keys()) if (t !== path && base(t).toLowerCase() === name.toLowerCase()) return path;
  return name;
}
