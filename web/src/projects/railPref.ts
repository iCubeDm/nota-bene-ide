// Settings → Defaults → Projects rail: the open projects in a rail on the left (ProjectRail.tsx), on unless turned off.
// One setting for every window of this agent: its server keeps it (prefs.json, GET/POST /system/prefs); this origin's
// storage caches it so a reload does not flash the rail in or out. A new window (nothing cached) shows no rail until
// the server answers. Another window's change is read when this page is shown again (sdk/storage.ts).
import { t, storage, toast, useStored } from '@/sdk';

const pref = storage.pref('projectRail');

export const railPref = {
  /** true / false, or null while a new window has not heard the server */
  get: (): boolean | null => pref.get(),
  /** the user turned it on or off: here at once, and saved for every window of this agent; a failed save says so */
  choose: (v: boolean) => void pref.set(v).then((why) => { if (why !== null) toast(t('railSaveFail', why), t('defRail')); }),
  subscribe: (f: () => void) => pref.subscribe(f),
  /** tests: re-read the cache, forget an unconfirmed choice */
  reload: () => pref.reload(),
};

export const useRailPref = (): boolean | null => useStored(pref);
