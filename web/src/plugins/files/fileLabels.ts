import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from '@/sdk';

/**
 * The file tabs' labels, as IntelliJ IDEA shows them (issue 463): the file's name; when open files share a name, each
 * of them with as many of its parent folders as tell it apart from the others (`src/app.ts`, `lib/app.ts`). The same
 * path open twice (another branch) keeps one label: its source chip tells those apart. Keyed by path.
 */
export function fileLabels(paths: readonly string[]): Map<string, string> {
  const unique = [...new Set(paths)];
  const parts = new Map(unique.map((p) => [p, p.split('/').filter(Boolean)]));
  const tail = (p: string, n: number) => parts.get(p)!.slice(-n).join('/');
  const out = new Map<string, string>();
  for (const p of unique) {
    const own = parts.get(p)!;
    const rivals = unique.filter((q) => q !== p && tail(q, 1) === tail(p, 1));
    let n = 1;
    while (n < own.length && rivals.some((q) => tail(q, n) === tail(p, n))) n++;
    out.set(p, tail(p, n) || p);
  }
  return out;
}

/** The open file tabs' labels, by path: computed again only when the open tabs change. */
export const selectFileLabels = createSelector([(s: RootState) => s.tabs.open], (open) => fileLabels(open.flatMap((t) => (t.kind === 'file' ? [t.path] : []))));
