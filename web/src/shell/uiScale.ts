import { UI_SCALES, type UiScale } from '@nota-bene/shared';
import { storage, useStored } from '@/sdk/storage.ts';

// The interface scale (Settings → Defaults): the root font size as a factor of the browser's own, so every rem-sized
// text and spacing grows with it while the layout math (popups, the timeline, markup) stays in plain pixels. One for
// every window, like the language: the server keeps it (prefs.json, hello.uiScale), this origin's storage caches it
// so a reload does not flash the default first.
const pref = storage.pref('uiScale');

function apply(): void {
  const cur = pref.get();
  if (typeof document !== 'undefined') document.documentElement.style.fontSize = cur === 1 ? '' : `${Math.round(cur * 100)}%`;
}
apply();
pref.subscribe(apply);

export const uiScale = {
  get: (): UiScale => pref.get(),
  /** the user picked a scale: apply it here and save it for every window */
  choose: (v: UiScale) => void pref.set(v),
  /** the next scale up (`by` 1) or down (-1), stopping at the ends; the scale it chose */
  step: (by: 1 | -1): UiScale => {
    const cur = pref.get();
    const next = UI_SCALES[Math.max(0, Math.min(UI_SCALES.length - 1, UI_SCALES.indexOf(cur) + by))]!;
    if (next !== cur) uiScale.choose(next);
    return next;
  },
  /** the server's `hello.uiScale` wins over this origin's cache, except while our own choice is unconfirmed */
  adopt: (server: unknown) => pref.adopt(server),
  subscribe: (f: () => void) => pref.subscribe(f),
  /** tests: re-read the saved value, forget an unconfirmed choice */
  reload: () => { pref.reload(); apply(); },
};

export const useUiScale = () => useStored(pref);
