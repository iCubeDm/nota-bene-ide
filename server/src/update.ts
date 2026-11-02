import { readPrefs } from './prefs.ts';

// Whether a newer version is on npm, for the window's notice. The browser never asks: `/system/update` answers from here.
const LATEST_URL = 'https://registry.npmjs.org/nota-bene-ide/latest';
const CHECK_EVERY_MS = 6 * 3600_000;
const TIMEOUT_MS = 5000;
const RELEASE = /^\d+\.\d+\.\d+$/;

/** NOTA_BENE_NO_UPDATE_CHECK: the check stays off whatever Settings say. */
export const updateCheckForcedOff = (): boolean => !!process.env.NOTA_BENE_NO_UPDATE_CHECK;

export const isNewer = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number)) as [number[], number[]];
  const i = x.findIndex((n, k) => n !== y[k]);
  return i >= 0 && x[i]! > y[i]!;
};

/**
 * The newer version than `current`, or null: also in a source checkout (its version is `git describe`), with the
 * check off (read per call, so Settings apply at once), and when npm cannot be reached. npm is asked at most once per 6 hours.
 */
export function updateCheck(o: { fetch?: typeof fetch; now?: () => number; off?: () => boolean } = {}): (current: string) => Promise<string | null> {
  const get = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const off = o.off ?? (() => updateCheckForcedOff() || readPrefs().updateCheck === false);
  let known: string | null = null;
  let at = -Infinity;
  let running: Promise<void> | null = null;
  const ask = async () => {
    try {
      const r = await get(LATEST_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const v = r.ok ? ((await r.json()) as { version?: unknown }).version : null;
      if (typeof v === 'string' && RELEASE.test(v)) known = v;
    } catch { /* no network is not a fault: the notice just does not show */ }
    at = now();
    running = null;
  };
  return async (current) => {
    if (off() || !RELEASE.test(current)) return null;
    if (now() - at >= CHECK_EVERY_MS) await (running ??= ask());
    return known && isNewer(known, current) ? known : null;
  };
}
