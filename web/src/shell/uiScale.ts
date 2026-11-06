import { useSyncExternalStore } from 'react';
import { isUiScale, UI_SCALES, type UiScale } from '@nota-bene/shared';
import { apiFetch } from '@/net/auth.ts';

const KEY = 'nb.uiScale';

// The interface scale (Settings → Defaults): the root font size as a factor of the browser's own, so every rem-sized
// text and spacing grows with it while the layout math (popups, the timeline, markup) stays in plain pixels. One for
// every window, like the language: the server keeps it (prefs.json, hello.uiScale), this origin's localStorage caches it
// so a reload does not flash the default first.
let cur: UiScale = read();
const subs = new Set<() => void>();
/** A choice the server has not confirmed yet: a hello that may predate it must not undo it. */
let unsynced: UiScale | null = null;

function read(): UiScale {
  try {
    const n = Number(localStorage.getItem(KEY));
    return isUiScale(n) ? n : 1;
  } catch { return 1; }
}

function apply(): void {
  if (typeof document !== 'undefined') document.documentElement.style.fontSize = cur === 1 ? '' : `${Math.round(cur * 100)}%`;
}
apply();

function setLocal(v: UiScale): void {
  if (v === cur) return;
  cur = v;
  try { localStorage.setItem(KEY, String(v)); } catch { /* storage unavailable: not persisted */ }
  apply();
  for (const f of subs) f();
}

function persist(v: UiScale): void {
  unsynced = v;
  try {
    void apiFetch('/system/prefs', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uiScale: v }) })
      .then((r) => { if (r.ok && unsynced === v) unsynced = null; }, () => {});
  } catch { /* no fetch: the local cache still holds the choice */ }
}

export const uiScale = {
  get: (): UiScale => cur,
  /** the user picked a scale: apply it here and save it for every window */
  choose: (v: UiScale) => {
    setLocal(v);
    persist(v);
  },
  /** the next scale up (`by` 1) or down (-1), stopping at the ends; the scale it chose */
  step: (by: 1 | -1): UiScale => {
    const next = UI_SCALES[Math.max(0, Math.min(UI_SCALES.length - 1, UI_SCALES.indexOf(cur) + by))]!;
    if (next !== cur) uiScale.choose(next);
    return next;
  },
  /** the server's `hello.uiScale` wins over this origin's cache, except while our own choice is unconfirmed */
  adopt: (server: unknown) => {
    if (unsynced !== null) return persist(unsynced);
    if (isUiScale(server)) setLocal(server);
  },
  subscribe: (f: () => void) => { subs.add(f); return () => void subs.delete(f); },
  /** tests: re-read the saved value, forget an unconfirmed choice */
  reload: () => { cur = read(); unsynced = null; apply(); },
};

export const useUiScale = () => useSyncExternalStore(uiScale.subscribe, uiScale.get);

/** How a scale reads in the interface language: `125 %`, `125%`. */
export const scaleLabel = (v: number, lang: string): string => new Intl.NumberFormat(lang, { style: 'percent' }).format(v);
