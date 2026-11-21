import { useMemo } from 'react';
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { VcsDiff, VcsFile, VcsPatch } from '@nota-bene/shared';
import { bool, defineResource, json, routes, storage, useAppSelector, useResource, type Registry, type Route, type StartListening } from '@/sdk';

/** The git views' shared state (the tool window and the tab share one fetch through the diff resource). */
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

// the diff layout and the base per project and source outlive the page (storage, saved by `vcsListeners`); the rest is this page's
const savedSplit = storage.local('vcs:split', bool, false);
const savedBases = storage.local('vcs:bases', json<Record<string, string>>(), {});

const baseKey = (root: string, src: string) => `${root}\0${src}`;

export const vcsSlice = createSlice({
  name: 'vcs',
  initialState: (): Ui => ({ panel: false, focus: null, split: savedSplit.get(), bases: savedBases.get(), commit: null, hasRepo: false }),
  reducers: {
    setPanel: (s, a: PayloadAction<boolean>) => void (s.panel = a.payload),
    focusFile: { reducer: (s, a: PayloadAction<Ui['focus']>) => void (s.focus = a.payload), prepare: (path: string) => ({ payload: { path, at: Date.now() } }) },
    showCommit: {
      reducer: (s, a: PayloadAction<Ui['commit']>) => void (s.commit = a.payload),
      prepare: (sha: string, path: string) => ({ payload: { sha, path, at: Date.now() } }),
    },
    setHasRepo: (s, a: PayloadAction<boolean>) => void (s.hasRepo = a.payload),
    setSplit: (s, a: PayloadAction<boolean>) => void (s.split = a.payload),
    pickBase: {
      reducer: (s, a: PayloadAction<{ key: string; base: string | null }>) => {
        if (a.payload.base) s.bases[a.payload.key] = a.payload.base;
        else delete s.bases[a.payload.key];
      },
      prepare: (root: string, src: string, base: string | null) => ({ payload: { key: baseKey(root, src), base } }),
    },
  },
});
export const { setPanel, focusFile, showCommit, setHasRepo, setSplit, pickBase } = vcsSlice.actions;

export const useVcsUi = (): Ui => useAppSelector((s) => s.vcs);
export const baseOf = (bases: Ui['bases'], root: string, src: string): string | undefined => bases[baseKey(root, src)];

/** Saves the layout and the bases when they change; Files and Changes share the left side, so the tree opening closes the panel. */
export function vcsListeners(start: StartListening, { files }: Registry): void {
  start({ predicate: (_a, st, was) => st.vcs.split !== was.vcs.split, effect: (_a, api) => savedSplit.set(api.getState().vcs.split) });
  start({ predicate: (_a, st, was) => st.vcs.bases !== was.vcs.bases, effect: (_a, api) => savedBases.set(api.getState().vcs.bases) });
  if (files) start({ predicate: (_a, st, was) => files.selectTreeOpen(st) && !files.selectTreeOpen(was), effect: (_a, api) => void api.dispatch(setPanel(false)) });
}

/** One project, source and base's diff: one poll every 4 s however many views watch it (the tool window and the tab, issue 471). */
export const diffResource = defineResource<{ root: string; src: string; base: string | undefined }, VcsDiff>({
  id: 'vcs.diff',
  key: (a) => `${a.root}\0${a.src}\0${a.base ?? ''}`,
  route: (a) => routes.vcsDiff(a.src, a.base),
  every: 4_000,
});

/** The file on screen: the one picked, or the first when that one is gone from the list. */
export const currentFile = (files: VcsFile[], path: string | undefined) => files.find((f) => f.path === path) ?? files[0] ?? null;

export const patchResource = defineResource<Route, VcsPatch>({ id: 'vcs.patch', key: (url) => url, route: (url) => url });

/** One file's patch, refreshed while shown (only this file, so a large diff costs nothing here). `failed`: the last ask; what came before stays. */
export function usePatch(url: Route | null, on: boolean, every = 4_000) {
  const { data, failed } = useResource(patchResource, url, { on, every });
  return useMemo(() => (!url ? null : data ? { url, ...data, failed } : failed ? { url, patch: '', truncated: false, failed } : null), [url, data, failed]);
}
