import fs from 'node:fs';
import path from 'node:path';
import { renameRetry } from './platform.ts';
import { readPrefs } from './prefs.ts';
import { stateBaseDir } from './state.ts';

// Whether a newer version is on npm, for the window's notice. The browser never asks: `/system/update` answers from here.
const LATEST_URL = 'https://registry.npmjs.org/nota-bene-ide/latest';
/** npm is asked at most this often per machine: the answer is shared through a file in the state folder. */
export const CHECK_EVERY_MS = 60_000;
const TIMEOUT_MS = 5000;
export const RELEASE = /^\d+\.\d+\.\d+$/;

/** NOTA_BENE_NO_UPDATE_CHECK: the check stays off whatever Settings say. */
export const updateCheckForcedOff = (): boolean => !!process.env.NOTA_BENE_NO_UPDATE_CHECK;

export const isNewer = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number)) as [number[], number[]];
  const i = x.findIndex((n, k) => n !== y[k]);
  return i >= 0 && x[i]! > y[i]!;
};

const checkFile = () => path.join(stateBaseDir(), 'update-check.json');

type Cached = { latest: string | null; at: number };

function readCached(file: string): Cached | null {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Cached>;
    const latest = typeof c.latest === 'string' && RELEASE.test(c.latest) ? c.latest : null;
    return typeof c.at === 'number' && Number.isFinite(c.at) ? { latest, at: c.at } : null;
  } catch { return null; }
}

/** The newest version the machine has seen on npm, from the shared file; no fetch. */
export function latestKnown(o: { file?: string } = {}): string | null {
  return readCached(o.file ?? checkFile())?.latest ?? null;
}

/**
 * The newer version than `current`, or null: also in a source checkout (its version is `git describe`), with the
 * check off (read per call, so Settings apply at once), and when npm cannot be reached. npm is asked at most once a
 * minute per machine: the time and the answer live in `file`, shared by every window, and a broken file counts as stale.
 */
export function updateCheck(o: { fetch?: typeof fetch; now?: () => number; off?: () => boolean; file?: string } = {}): (current: string) => Promise<string | null> {
  const get = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const off = o.off ?? (() => updateCheckForcedOff() || readPrefs().updateCheck === false);
  let running: Promise<void> | null = null;
  const ask = async (file: string) => {
    let latest = readCached(file)?.latest ?? null; // a failed ask keeps what was known
    try {
      const r = await get(LATEST_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const v = r.ok ? ((await r.json()) as { version?: unknown }).version : null;
      if (typeof v === 'string' && RELEASE.test(v)) latest = v;
    } catch { /* no network is not a fault: the notice just does not show */ }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ latest, at: now() } satisfies Cached), { mode: 0o600 });
      renameRetry(tmp, file);
    } catch { /* an unwritable folder only means the next ask is not spared */ }
    running = null;
  };
  return async (current) => {
    if (off() || !RELEASE.test(current)) return null;
    const file = o.file ?? checkFile();
    const c = readCached(file);
    if (!c || now() - c.at >= CHECK_EVERY_MS || c.at > now()) await (running ??= ask(file));
    const known = latestKnown({ file });
    return known && isNewer(known, current) ? known : null;
  };
}

const CHANGELOG_URL = (v: string) => `https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/v${v}/CHANGELOG.md`;
const SECTION = /^## (\d+\.\d+\.\d+)\b.*$/;

/** The CHANGELOG sections of the versions newer than `current`, newest first, as written; '' when there are none. */
export function changesSince(md: string, current: string): string {
  const out: string[] = [];
  let take = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) {
      const v = SECTION.exec(line)?.[1];
      take = !!v && isNewer(v, current);
      if (v && !take) break; // the file runs newest first: the rest is older still
    }
    if (take) out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * What changed between the running version and a newer one, from CHANGELOG.md at the newer one's tag; null when it
 * cannot be read. The file is fetched once per version (a failure is not kept, so the next ask tries again).
 */
export function changelog(o: { fetch?: typeof fetch } = {}): (current: string, latest: string) => Promise<string | null> {
  const get = o.fetch ?? fetch;
  const files = new Map<string, Promise<string | null>>();
  const read = async (v: string) => {
    try {
      const r = await get(CHANGELOG_URL(v), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return r.ok ? await r.text() : null;
    } catch { return null; }
  };
  return async (current, latest) => {
    if (!RELEASE.test(latest)) return null;
    let file = files.get(latest);
    if (!file) files.set(latest, (file = read(latest)));
    const md = await file;
    if (md === null) files.delete(latest);
    return md === null ? null : changesSince(md, current);
  };
}
