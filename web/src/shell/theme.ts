import { useSyncExternalStore } from 'react';
import { DEFAULT_THEME, isThemeId, THEME_KIND, type ThemeId } from '@nota-bene/shared';
import { apiFetch } from '@/net/auth.ts';

const KEY = 'nb.theme';

// The colour theme (Settings → Defaults): <html data-theme> selects one token block in theme.css. One for every window,
// like the interface scale: the server keeps it (prefs.json, hello.theme), this origin's localStorage caches it, and this
// module sets the attribute on import so the first paint already wears it.
let cur: ThemeId = read();
const subs = new Set<() => void>();
/** A choice the server has not confirmed yet: a hello that may predate it must not undo it. */
let unsynced: ThemeId | null = null;

function read(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    return isThemeId(v) ? v : DEFAULT_THEME;
  } catch { return DEFAULT_THEME; }
}

function apply(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = cur;
}
apply();

function setLocal(v: ThemeId): void {
  if (v === cur) return;
  cur = v;
  try { localStorage.setItem(KEY, v); } catch { /* storage unavailable: not persisted */ }
  apply();
  for (const f of subs) f();
}

function persist(v: ThemeId): void {
  unsynced = v;
  try {
    void apiFetch('/system/prefs', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: v }) })
      .then((r) => { if (r.ok && unsynced === v) unsynced = null; }, () => {});
  } catch { /* no fetch: the local cache still holds the choice */ }
}

export const theme = {
  get: (): ThemeId => cur,
  kind: (): 'dark' | 'light' => THEME_KIND[cur],
  /** the user picked a theme: apply it here and save it for every window */
  choose: (v: ThemeId) => {
    setLocal(v);
    persist(v);
  },
  /** the server's `hello.theme` wins over this origin's cache, except while our own choice is unconfirmed */
  adopt: (server: unknown) => {
    if (unsynced !== null) return persist(unsynced);
    if (isThemeId(server)) setLocal(server);
  },
  subscribe: (f: () => void) => { subs.add(f); return () => void subs.delete(f); },
  /** tests: re-read the saved value, forget an unconfirmed choice */
  reload: () => { cur = read(); unsynced = null; apply(); },
};

export const useTheme = () => useSyncExternalStore(theme.subscribe, theme.get);
