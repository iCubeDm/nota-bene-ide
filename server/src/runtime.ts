// The runtime store: releases installed by the in-app update live in <stateBase>/runtime/<x.y.z>/ (a full
// nota-bene-ide package each), `current` names the one a launcher hands over to, state.json holds the update's
// bookkeeping, and update.lock serializes installs across windows. The launcher (bin/nota-bene.mjs) imports this file.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { providerStateDir, type AgentProvider } from './agent/provider.ts';
import { stateBaseDir } from './state.ts';
import { RELEASE } from './update.ts';
import { pidAlive } from './windows.ts';

export const runtimeDir = (): string => path.join(stateBaseDir(), 'runtime');
export const launcherOf = (v: string): string => path.join(runtimeDir(), v, 'node_modules', 'nota-bene-ide', 'bin', 'nota-bene.mjs');

const currentFile = () => path.join(runtimeDir(), 'current');
const stateFile = () => path.join(runtimeDir(), 'state.json');
const lockFile = () => path.join(runtimeDir(), 'update.lock');

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** What `current` says, installed or not: after a rollback to a launcher's own version there is no runtime folder for it. */
export const rawCurrent = (): string | null => {
  try { return fs.readFileSync(currentFile(), 'utf8').trim(); } catch { return null; }
};

/** The version `current` names, when it is a plain release whose launcher is really installed. */
export function readCurrent(): string | null {
  const v = rawCurrent();
  return v !== null && RELEASE.test(v) && fs.existsSync(launcherOf(v)) ? v : null;
}

export type UpdateState = {
  auto: boolean;
  /** the `current` before the last change: kept on disk for a way back */
  previous?: string;
  failed?: { version: string; at: number; reason: string };
  rolledBack?: { version: string; at: number };
};

export function readUpdateState(): UpdateState {
  try {
    const s: unknown = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (s && typeof s === 'object' && !Array.isArray(s)) return { ...(s as UpdateState), auto: (s as UpdateState).auto === true };
  } catch { /* missing or broken: the defaults */ }
  return { auto: false };
}

export function patchUpdateState(f: (s: UpdateState) => UpdateState): void {
  writeAtomic(stateFile(), JSON.stringify(f(readUpdateState()), null, 2));
}

/** Points `current` at `v`, remembering the replaced version as `previous`. With `expect`, only while `current` still says so. */
export function writeCurrent(v: string, expect?: string | null): boolean {
  if (!RELEASE.test(v)) return false;
  const was = rawCurrent();
  if (expect !== undefined && was !== expect) return false;
  writeAtomic(currentFile(), v);
  if (was !== null && was !== v && RELEASE.test(was)) patchUpdateState((s) => ({ ...s, previous: was }));
  return true;
}

/** An unparseable lock younger than this is a write in progress, not a stale lock. */
const LOCK_GRACE_MS = 10_000;
/** npm is killed and the install fails after this long, so a hung npm cannot hold the lock for good. */
export const NPM_TIMEOUT_MS = 10 * 60_000;

type LockRead = { version: string; pid: number } | 'stale' | null;
export function readLock(file: string): LockRead {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const l = JSON.parse(text) as { version?: unknown; pid?: unknown };
    if (typeof l.version === 'string' && typeof l.pid === 'number') return pidAlive(l.pid) ? { version: l.version, pid: l.pid } : 'stale';
  } catch { /* unparseable: judged by age below */ }
  try { return Date.now() - fs.statSync(file).mtimeMs < LOCK_GRACE_MS ? { version: '', pid: 0 } : 'stale'; } catch { return null; }
}

export function installing(): { version: string; pid: number } | null {
  const l = readLock(lockFile());
  return l && l !== 'stale' ? l : null;
}

/** Takes update.lock atomically (a complete tmp file hard-linked into place); false when a live install holds it. */
function takeLock(version: string): boolean {
  return takeLockFile(lockFile(), version);
}

/** The same atomic lock at any path (the Whisper installer has its own). */
export function takeLockFile(file: string, version: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const uniq = `${process.pid}.${Math.random().toString(36).slice(2)}`;
  const tmp = `${file}.${uniq}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version, pid: process.pid }), { mode: 0o600 });
  try {
    for (let tries = 0; tries < 3; tries++) {
      try {
        fs.linkSync(tmp, file);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const l = readLock(file);
      if (l && l !== 'stale') return false;
      // stale: move it aside (one winner), and re-check what was really moved
      const aside = `${file}.${uniq}.stale`;
      try { fs.renameSync(file, aside); } catch { continue; }
      const moved = readLock(aside);
      if (moved && moved !== 'stale') {
        try { fs.linkSync(aside, file); } catch { /* the newer owner already re-created it */ }
        fs.rmSync(aside, { force: true });
        return false;
      }
      fs.rmSync(aside, { force: true });
    }
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function defaultNpm(): string | null {
  const beside = path.join(path.dirname(process.execPath), 'npm');
  if (fs.existsSync(beside)) return beside;
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (d && fs.existsSync(path.join(d, 'npm'))) return path.join(d, 'npm');
  }
  return null;
}

export function run(cmd: string, args: string[], out: number | 'pipe', timeoutMs = NPM_TIMEOUT_MS): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', out, out === 'pipe' ? 'ignore' : out] });
    let stdout = '';
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, timeoutMs);
    c.stdout?.on('data', (d: Buffer) => { stdout += d; });
    c.on('error', () => { clearTimeout(t); resolve({ code: null, stdout, timedOut }); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, timedOut }); });
  });
}

export async function installRelease(version: string, o: { npm?: string; node?: string; log?: string; npmTimeoutMs?: number } = {}): Promise<'installed' | 'running' | { failed: string }> {
  if (!RELEASE.test(version)) return { failed: `not a release version: ${version}` };
  if (readCurrent() === version) return 'installed'; // already there: nothing to fetch, nothing to disturb
  if (!takeLock(version)) return 'running';
  const dir = path.join(runtimeDir(), version);
  // a folder that is previous or run by a live window is somebody's: never removed here, reused when complete
  const owned = protectedVersions().has(version);
  const removeOwn = () => { if (!owned) fs.rmSync(dir, { recursive: true, force: true }); };
  let reason: string | null = null;
  try {
    const npm = o.npm ?? defaultNpm();
    if (!npm) {
      reason = 'npm not found';
    } else if (!(owned && fs.existsSync(launcherOf(version)))) {
      removeOwn(); // a leftover of an earlier failure
      const log = fs.openSync(o.log ?? path.join(runtimeDir(), 'update.log'), 'a', 0o600);
      try {
        // The release check may see a new version before npm's cached metadata expires.
        const got = await run(npm, ['install', '--prefix', dir, `nota-bene-ide@${version}`, '--prefer-online', '--no-audit', '--no-fund'], log, o.npmTimeoutMs);
        if (got.timedOut) reason = 'npm timed out';
        else if (got.code !== 0) reason = `npm install exited with ${got.code}`;
      } finally { fs.closeSync(log); }
    }
    if (reason === null) {
      const check = await run(o.node ?? process.execPath, [launcherOf(version), '--version'], 'pipe', o.npmTimeoutMs);
      const said = check.stdout.trim();
      if (check.code !== 0 || said !== version) reason = `installed version check said ${said || `exit ${check.code}`}, expected ${version}`;
    }
    if (reason === null && !writeCurrent(version)) reason = 'could not write current';
    if (reason === null) {
      patchUpdateState((s) => { const { failed: _f, ...rest } = s; return rest; });
      pruneRuntime();
      return 'installed';
    }
    patchUpdateState((s) => ({ ...s, failed: { version, at: Date.now(), reason: reason! } }));
    removeOwn();
    return { failed: reason };
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
    try { patchUpdateState((s) => ({ ...s, failed: { version, at: Date.now(), reason: reason! } })); } catch { /* best effort */ }
    removeOwn();
    return { failed: reason };
  } finally {
    fs.rmSync(lockFile(), { force: true });
  }
}

/** Versions that live windows (or their restarting launchers) run, from every provider's registry. */
function versionsInUse(): Set<string> {
  const used = new Set<string>();
  for (const p of ['claude', 'codex', 'omp'] as AgentProvider[]) {
    const dir = path.join(providerStateDir(stateBaseDir(), p), 'windows');
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      try {
        const w = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as { version?: unknown; pid?: unknown; launcherPid?: unknown };
        if (typeof w.version === 'string' && (pidAlive(w.pid as number) || pidAlive(w.launcherPid as number))) used.add(w.version);
      } catch { /* a broken entry keeps nothing */ }
    }
  }
  return used;
}

/** `current`, its predecessor and every version a live window runs: never removed. */
function protectedVersions(): Set<string> {
  const keep = versionsInUse();
  const cur = rawCurrent();
  if (cur) keep.add(cur);
  const prev = readUpdateState().previous;
  if (prev) keep.add(prev);
  return keep;
}

/** Removes the installed releases that are neither `current`, its predecessor nor run by a live window. */
export function pruneRuntime(): void {
  const keep = protectedVersions();
  let names: string[] = [];
  try { names = fs.readdirSync(runtimeDir()); } catch { return; }
  for (const n of names) {
    if (RELEASE.test(n) && !keep.has(n)) fs.rmSync(path.join(runtimeDir(), n), { recursive: true, force: true });
  }
}
