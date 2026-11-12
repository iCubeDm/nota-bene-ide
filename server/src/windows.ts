// The window registry: one file per port, <stateDir>/windows/<port>.json = { root, pid, launcherPid?, startedAt }.
// Written by the launcher (bin/nota-bene.mjs, which imports this file directly) when a server answers /info, and by
// a supervised server itself when its root changes (a folder switch); read by `nota-bene --find`. One file per port
// keeps writers of different ports from ever touching each other's entries; each file is replaced atomically.
// An entry is only a hint: every reader verifies it (pid alive + /info.root), because a window can be killed
// without unregistering, and its port reused by another app.
import fs from 'node:fs';
import path from 'node:path';
import { SecretError, verifiedBearer } from './auth.ts';
import { pidAlive } from './platform.ts';
import { stateDir } from './state.ts';

export type WindowEntry = {
  root: string;
  /** the server process: its liveness is the window's */
  pid: number;
  /** the supervising launcher (survives the server's relaunches) */
  launcherPid?: number;
  startedAt: number;
  /** the release the launcher runs this window from (plain x.y.z), when it knows; absent in older entries */
  version?: string;
  /** the launch nonce, written by a launcher that exits 77: the outer part hands the window over with it (bin/nota-bene.mjs) */
  nonce?: string;
  /** the launcher is rebuilding web/dist before relaunching the server: a launch of the folder keeps waiting for it */
  building?: boolean;
};

const dir = (base?: string) => path.join(base ?? stateDir(), 'windows');
const fileOf = (port: number | string, base?: string) => path.join(dir(base), `${port}.json`);

function readEntry(port: number | string, base?: string): WindowEntry | undefined {
  try {
    const w: unknown = JSON.parse(fs.readFileSync(fileOf(port, base), 'utf8'));
    return w && typeof w === 'object' && typeof (w as WindowEntry).root === 'string' ? (w as WindowEntry) : undefined;
  } catch {
    return undefined;
  }
}

/** The entries of this provider's registry, or of the state dir `base` (the remote connector reads every provider's). */
export function readWindows(base?: string): Record<string, WindowEntry> {
  let names: string[];
  try {
    names = fs.readdirSync(dir(base));
  } catch {
    return {};
  }
  const out: Record<string, WindowEntry> = {};
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n);
    if (!m) continue;
    const w = readEntry(m[1]!, base);
    if (w) out[m[1]!] = w;
  }
  return out;
}

export function registerWindow(port: number, root: string, pid: number, launcherPid?: number, version?: string, nonce?: string): void {
  fs.mkdirSync(dir(), { recursive: true });
  const f = fileOf(port);
  const tmp = `${f}.tmp${process.pid}`;
  const entry: WindowEntry = { root, pid, ...(launcherPid !== undefined ? { launcherPid } : {}), startedAt: Date.now(), ...(version !== undefined ? { version } : {}), ...(nonce !== undefined ? { nonce } : {}) };
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, f);
}

/**
 * A server's own re-register after a folder switch: the new root, and the fields only its launcher knows (the release it
 * runs, which keeps that release from being pruned; the nonce) kept from the entry, when the entry is this server's.
 */
export function moveWindow(port: number, root: string, pid: number, launcherPid?: number): void {
  const w = readEntry(port);
  const own = w?.pid === pid ? w : undefined;
  registerWindow(port, root, pid, launcherPid, own?.version, own?.nonce);
}

/** Marks the port's entry (when it is this launcher's) as rebuilding web/dist, or clears the mark. */
export function setBuilding(port: number, launcherPid: number, on: boolean): void {
  const w = readEntry(port);
  if (!w || w.launcherPid !== launcherPid || Boolean(w.building) === on) return;
  const { building: _, ...rest } = w;
  const f = fileOf(port);
  const tmp = `${f}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(on ? { ...rest, building: true } : rest, null, 2));
  fs.renameSync(tmp, f);
}

/** Removes the port's entry only if it is still this pid's (or unreadable): a newer window on the port keeps its own. */
export function unregisterWindow(port: number, pid: number): void {
  if (fs.existsSync(fileOf(port)) && (readEntry(port)?.pid ?? pid) === pid) fs.rmSync(fileOf(port), { force: true });
}

export { pidAlive }; // its callers import it from here

/** GET http://127.0.0.1:PORT/info → { root } or null (no answer, not ours, not JSON, not logged in). The credential goes only to a listener that proved it holds the token (GET /hello). */
export async function probeInfo(port: number, timeoutMs = 500): Promise<{ root: string } | null> {
  try {
    const bearer = await verifiedBearer(port, timeoutMs);
    if (!bearer) return null;
    const r = await fetch(`http://127.0.0.1:${port}/info`, { headers: { authorization: bearer }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!r.ok) return null;
    const j: unknown = await r.json();
    const root = j && typeof j === 'object' ? (j as { root?: unknown }).root : undefined;
    return typeof root === 'string' ? { root } : null;
  } catch (e) {
    if (e instanceof SecretError) throw e; // not "no window": the user has to fix the token file
    return null;
  }
}

/**
 * A restarting window: its server is down (crashed, or exited 75) but its launcher is alive and relaunches it on the
 * same port. The launcher keeps the entry across relaunches, so the port stays reserved for it.
 */
const restarting = (w: WindowEntry): boolean => !pidAlive(w.pid) && w.launcherPid !== undefined && pidAlive(w.launcherPid);

/** The entries of windows in a restart gap (see `restarting`). */
export function restartingWindows(): { port: number; root: string; building: boolean }[] {
  return Object.entries(readWindows())
    .filter(([, w]) => restarting(w))
    .map(([key, w]) => ({ port: Number(key), root: w.root, building: w.building === true }))
    .sort((a, b) => a.port - b.port);
}

/**
 * The registered windows that are really there: pid alive and /info.root equal to the entry's root.
 * Proven-stale entries (dead pid and dead launcher, or the port answers with another root) are pruned; a restarting
 * entry is kept but not listed; an entry whose pid is alive but whose /info does not answer is skipped and kept
 * (a busy server is not proof of a stale entry).
 */
export async function liveWindows(
  probe: (port: number) => Promise<{ root: string } | null>,
): Promise<{ port: number; root: string }[]> {
  const entries = Object.entries(readWindows());
  const live: { port: number; root: string }[] = [];
  await Promise.all(entries.map(async ([key, w]) => {
    const port = Number(key);
    if (!pidAlive(w.pid)) {
      if (!restarting(w)) unregisterWindow(port, w.pid);
      return;
    }
    const got = await probe(port);
    if (got === null) return;
    if (got.root === w.root) live.push({ port, root: w.root });
    else unregisterWindow(port, w.pid);
  }));
  return live.sort((a, b) => a.port - b.port);
}
