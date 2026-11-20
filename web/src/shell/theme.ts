import { THEME_KIND, THEMES, type ThemeId } from '@nota-bene/shared';
import { storage, useStored } from '@/sdk/storage.ts';

/** The names are not translated (a theme is a proper name, like a language's own name). */
export const THEME_NAMES: Record<ThemeId, string> = { darcula: 'Darcula', plannotator: 'Plannotator', 'intellij-light': 'IntelliJ Light', 'github-light': 'GitHub Light', 'solarized-light': 'Solarized Light', 'solarized-dark': 'Solarized Dark' };

/** The pickers list dark themes first, then light ones, each under its heading (THEMES is already in that order). */
export const THEME_GROUPS: { kind: 'dark' | 'light'; head: 'themesDark' | 'themesLight'; ids: ThemeId[] }[] = [
  { kind: 'dark', head: 'themesDark', ids: THEMES.filter((id) => THEME_KIND[id] === 'dark') },
  { kind: 'light', head: 'themesLight', ids: THEMES.filter((id) => THEME_KIND[id] === 'light') },
];

// The colour theme (Settings → Themes): <html data-theme> selects one token block in theme.css. One for every window,
// like the interface scale: the server keeps it (prefs.json, hello.theme), this origin's storage caches it, and this
// module sets the attribute on import so the first paint already wears it.
const pref = storage.pref('theme');

function apply(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = pref.get();
}
apply();
pref.subscribe(apply);

export const theme = {
  get: (): ThemeId => pref.get(),
  kind: (): 'dark' | 'light' => THEME_KIND[pref.get()],
  /** the user picked a theme: apply it here and save it for every window */
  choose: (v: ThemeId) => void pref.set(v),
  /** the server's `hello.theme` wins over this origin's cache, except while our own choice is unconfirmed */
  adopt: (server: unknown) => pref.adopt(server),
  subscribe: (f: () => void) => pref.subscribe(f),
  /** tests: re-read the saved value, forget an unconfirmed choice */
  reload: () => { pref.reload(); apply(); },
};

export const useTheme = () => useStored(pref);
