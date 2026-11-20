// Settings → Defaults → Projects rail: the open projects in a rail on the left (ProjectRail.tsx), on unless turned off.
// One setting for every window of this agent: its server keeps it (prefs.json, GET/POST /system/prefs); this origin's
// localStorage caches it so a reload does not flash the rail in or out. A new window (nothing cached) shows no rail until
// the server answers. Another window's change is read when this page is shown again.
import { useSyncExternalStore } from 'react';
import { t, connections, pageVisible, routes, toast } from '@/sdk';

const KEY = 'nb.projectRail';

/** the cached choice; null: none cached (unknown until the server answers) */
const read = (): boolean | null => {
  try {
    const v = localStorage.getItem(KEY);
    return v === '0' ? false : v === '1' ? true : null;
  } catch { return null; }
};

let cur = read();
/** The choice being saved, newest last: a read that may predate it must not undo it. */
let unsynced: boolean | null = null;
/** The saves go one at a time, so the server ends on the last choice. */
let chain: Promise<void> = Promise.resolve();
let saves = 0;
const subs = new Set<() => void>();

function setLocal(v: boolean): void {
  if (v === cur) return;
  cur = v;
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* storage unavailable: not persisted */ }
  for (const f of subs) f();
}

function sync(): void {
  if (unsynced !== null) return;
  void connections.current().fetch(routes.systemPrefs()).then((r) => (r.ok ? r.json() : null)).then((j: { projectRail?: unknown } | null) => {
    if (unsynced !== null) return;
    if (typeof j?.projectRail === 'boolean') setLocal(j.projectRail);
    else if (cur === null) setLocal(true); // a server without the setting: the default
  }).catch(() => { if (unsynced === null && cur === null) setLocal(true); });
}

async function save(v: boolean, n: number): Promise<void> {
  let why: string | null = null;
  try {
    const r = await connections.current().fetch(routes.systemPrefs(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectRail: v }) });
    if (!r.ok) why = String(r.status);
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  if (why !== null) toast(t('railSaveFail', why), t('defRail'));
  if (n !== saves) return; // a later choice is on its way: it decides
  unsynced = null;
  if (why !== null) sync();
}

export const railPref = {
  /** true / false, or null while a new window has not heard the server */
  get: (): boolean | null => cur,
  /** the user turned it on or off: here at once, and saved for every window of this agent */
  choose: (v: boolean) => {
    setLocal(v);
    unsynced = v;
    const n = ++saves;
    chain = chain.then(() => save(v, n));
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
  reload: () => { cur = read(); unsynced = null; chain = Promise.resolve(); },
};

function onShow(): void {
  if (pageVisible()) sync();
}

export const useRailPref = (): boolean | null => useSyncExternalStore(railPref.subscribe, railPref.get);
