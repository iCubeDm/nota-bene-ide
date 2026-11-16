// Settings → Defaults → Projects rail: the open projects in a rail on the left (ProjectRail.tsx), on unless turned off.
// One setting for every window: the server keeps it (prefs.json, GET/POST /system/prefs); this origin's localStorage caches
// it so a reload does not flash the rail in or out. Another window's change is read when this page is shown again.
import { useSyncExternalStore } from 'react';
import { apiFetch } from '@/net/auth.ts';

const KEY = 'nb.projectRail';

const read = (): boolean => {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
};

let cur = read();
/** A choice the server has not confirmed yet: a read that may predate it must not undo it. */
let unsynced: boolean | null = null;
const subs = new Set<() => void>();

function setLocal(v: boolean): void {
  if (v === cur) return;
  cur = v;
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* storage unavailable: not persisted */ }
  for (const f of subs) f();
}

function sync(): void {
  if (unsynced !== null) return;
  void apiFetch('/system/prefs').then((r) => (r.ok ? r.json() : null)).then((j: { projectRail?: unknown } | null) => {
    if (unsynced === null && typeof j?.projectRail === 'boolean') setLocal(j.projectRail);
  }).catch(() => { /* the cached choice stays */ });
}

export const railPref = {
  get: (): boolean => cur,
  /** the user turned it on or off: here at once, and saved for every window */
  choose: (v: boolean) => {
    setLocal(v);
    unsynced = v;
    void apiFetch('/system/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectRail: v }) })
      .then((r) => { if (r.ok && unsynced === v) unsynced = null; }, () => {});
  },
  /** the server's value, read when the first subscriber comes and whenever the page is shown again */
  subscribe: (f: () => void) => {
    if (subs.size === 0) {
      sync();
      document.addEventListener('visibilitychange', onShow);
    }
    subs.add(f);
    return () => {
      subs.delete(f);
      if (subs.size === 0) document.removeEventListener('visibilitychange', onShow);
    };
  },
  /** tests: re-read the cache, forget an unconfirmed choice */
  reload: () => { cur = read(); unsynced = null; },
};

function onShow(): void {
  if (document.visibilityState === 'visible') sync();
}

export const useRailPref = (): boolean => useSyncExternalStore(railPref.subscribe, railPref.get);
