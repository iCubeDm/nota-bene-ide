import { useEffect, useState, useSyncExternalStore } from 'react';
import type { VcsDiff, VcsFile, VcsPatch } from '@nota-bene/shared';
import { apiFetch } from '@/net/auth.ts';

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
  failed: boolean;
};

const readBases = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem('vcs:bases') ?? '{}') as Record<string, string>; } catch { return {}; }
};
const initial = (): Ui => ({ panel: false, focus: null, split: localStorage.getItem('vcs:split') === '1', bases: readBases(), commit: null, hasRepo: false, failed: false });
let ui = initial();
let data: VcsDiff | null = null;
let loadedFor = '';
let raw = '';
let seq = 0;
let inflight = ''; // the key being asked: a slow git does not pile up requests
const listeners = new Set<() => void>();
const fire = () => { for (const fn of listeners) fn(); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => void listeners.delete(fn); };
const change = (next: Partial<Ui>) => { ui = { ...ui, ...next }; fire(); };

const baseKey = (root: string, src: string) => `${root}\0${src}`;
const diffKey = (root: string, src: string, base: string | undefined) => `${root}\0${src}\0${base ?? ''}`;

export const useVcsUi = () => useSyncExternalStore(subscribe, () => ui);
/** The answer for exactly this project, source and base: another's list is never shown under this one's name. */
export const useDiffData = (root: string, src: string, base: string | undefined) =>
  useSyncExternalStore(subscribe, () => (loadedFor === diffKey(root, src, base) ? data : null));
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
export function resetVcs() { ui = initial(); data = null; loadedFor = raw = inflight = ''; seq++; fire(); }

export async function loadDiff(root: string, src: string, base: string | undefined) {
  const key = diffKey(root, src, base);
  if (inflight === key) return;
  inflight = key;
  const mine = ++seq;
  try {
    const q = new URLSearchParams({ src, ...(base ? { base } : {}) });
    const r = await apiFetch(`/vcs-diff?${q}`);
    const body = r.ok ? await r.text() : null;
    if (mine !== seq) return;
    if (ui.failed !== (body === null)) change({ failed: body === null });
    if (body === null || (key === loadedFor && body === raw)) return; // no change: no re-render of a large diff
    loadedFor = key; raw = body; data = JSON.parse(body) as VcsDiff;
    fire();
  } catch { /* offline: keep what is shown */ } finally {
    if (mine === seq) inflight = '';
  }
}

/** The file on screen: the one picked, or the first when that one is gone from the list. */
export const currentFile = (files: VcsFile[], path: string | undefined) => files.find((f) => f.path === path) ?? files[0] ?? null;

/** One file's patch, refreshed while shown (only this file, so a large diff costs nothing here). `failed`: the last ask; what came before stays. */
export function usePatch(url: string | null, on: boolean, every = 4_000) {
  const [got, setGot] = useState<(VcsPatch & { url: string; failed: boolean }) | null>(null);
  useEffect(() => {
    if (!url || !on) return;
    let gone = false;
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const r = await apiFetch(url);
        if (gone) return;
        if (!r.ok) return setGot((p) => (p?.url === url ? { ...p, failed: true } : { url, patch: '', truncated: false, failed: true }));
        const v = await r.json() as VcsPatch;
        if (!gone) setGot((p) => (p?.url === url && p.patch === v.patch && !p.failed ? p : { url, ...v, failed: false }));
      } catch { /* keep */ } finally { running = false; }
    };
    void run();
    if (!every) return () => { gone = true; };
    const id = setInterval(() => { if (document.visibilityState === 'visible') void run(); }, every);
    return () => { gone = true; clearInterval(id); };
  }, [url, on, every]);
  return got?.url === url ? got : null;
}
