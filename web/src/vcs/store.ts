import { useMemo, useSyncExternalStore } from 'react';
import type { VcsDiff, VcsFile, VcsPatch } from '@nota-bene/shared';
import { defineResource, routes, useResource, type Route } from '@/sdk';

/** The git views' shared state, outside Redux as `files/sources.ts` is: the tool window and the tab share one fetch. */
export type RepoDiff = Extract<VcsDiff, { repo: true }>;
type Ui = {
  panel: boolean;
  focus: { path: string; at: number } | null;
  split: boolean;
  /** "show" per project and source */
  bases: Record<string, string>;
  /** a commit a comment asked for */
  commit: { sha: string; path: string; at: number } | null;
  hasRepo: boolean;
};

const readBases = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem('vcs:bases') ?? '{}') as Record<string, string>; } catch { return {}; }
};
const initial = (): Ui => ({ panel: false, focus: null, split: localStorage.getItem('vcs:split') === '1', bases: readBases(), commit: null, hasRepo: false });
let ui = initial();
const listeners = new Set<() => void>();
const fire = () => { for (const fn of listeners) fn(); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => void listeners.delete(fn); };
const change = (next: Partial<Ui>) => { ui = { ...ui, ...next }; fire(); };

const baseKey = (root: string, src: string) => `${root}\0${src}`;

export const useVcsUi = () => useSyncExternalStore(subscribe, () => ui);
export const setPanel = (panel: boolean) => change({ panel });
export const focusFile = (path: string) => change({ focus: { path, at: Date.now() } });
export const showCommit = (sha: string, path: string) => change({ commit: { sha, path, at: Date.now() } });
export const setHasRepo = (hasRepo: boolean) => { if (hasRepo !== ui.hasRepo) change({ hasRepo }); };
export const setSplit = (split: boolean) => { localStorage.setItem('vcs:split', split ? '1' : '0'); change({ split }); };
export const baseOf = (bases: Ui['bases'], root: string, src: string): string | undefined => bases[baseKey(root, src)];
export function pickBase(root: string, src: string, base: string | null) {
  const bases = { ...ui.bases };
  if (base) bases[baseKey(root, src)] = base; else delete bases[baseKey(root, src)];
  localStorage.setItem('vcs:bases', JSON.stringify(bases));
  change({ bases });
}
/** Test hook. */
export function resetVcs() { ui = initial(); fire(); }

/** One project, source and base's diff: one poll every 4 s however many views watch it (the tool window and the tab, issue 471). */
export const diffResource = defineResource<{ root: string; src: string; base: string | undefined }, VcsDiff>({
  key: (a) => `${a.root}\0${a.src}\0${a.base ?? ''}`,
  route: (a) => routes.vcsDiff(a.src, a.base),
  every: 4_000,
});

/** The file on screen: the one picked, or the first when that one is gone from the list. */
export const currentFile = (files: VcsFile[], path: string | undefined) => files.find((f) => f.path === path) ?? files[0] ?? null;

const patchResource = defineResource<Route, VcsPatch>({ key: (url) => url, route: (url) => url });

/** One file's patch, refreshed while shown (only this file, so a large diff costs nothing here). `failed`: the last ask; what came before stays. */
export function usePatch(url: Route | null, on: boolean, every = 4_000) {
  const { data, failed } = useResource(patchResource, url, { on, every });
  return useMemo(() => (!url ? null : data ? { url, ...data, failed } : failed ? { url, patch: '', truncated: false, failed } : null), [url, data, failed]);
}
