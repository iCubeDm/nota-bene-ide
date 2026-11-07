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

const rawCurrent = (): string | null => {
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

export function installing(): { version: string; pid: number } | null {
  try {
    const l = JSON.parse(fs.readFileSync(lockFile(), 'utf8')) as { version?: unknown; pid?: unknown };
    return typeof l.version === 'string' && typeof l.pid === 'number' && pidAlive(l.pid) ? { version: l.version, pid: l.pid } : null;
  } catch { return null; }
}

/** Takes update.lock (exclusive create); false when a live install holds it. A stale lock is replaced. */
function takeLock(version: string): boolean {
  fs.mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  for (let tries = 0; tries < 3; tries++) {
    try {
      fs.writeFileSync(lockFile(), JSON.stringify({ version, pid: process.pid }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (installing()) return false;
      fs.rmSync(lockFile(), { force: true });
    }
  }
  return false;
}

function defaultNpm(): string | null {
  const beside = path.join(path.dirname(process.execPath), 'npm');
  if (fs.existsSync(beside)) return beside;
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (d && fs.existsSync(path.join(d, 'npm'))) return path.join(d, 'npm');
  }
  return null;
}

function run(cmd: string, args: string[], out: number | 'pipe'): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', out, out === 'pipe' ? 'ignore' : out] });
    let stdout = '';
    c.stdout?.on('data', (d: Buffer) => { stdout += d; });
    c.on('error', () => resolve({ code: null, stdout }));
    c.on('close', (code) => resolve({ code, stdout }));
  });
}

export async function installRelease(version: string, o: { npm?: string; node?: string; log?: string } = {}): Promise<'installed' | 'running' | { failed: string }> {
  if (!RELEASE.test(version)) return { failed: `not a release version: ${version}` };
  if (!takeLock(version)) return 'running';
  const dir = path.join(runtimeDir(), version);
  let reason: string | null = null;
  try {
    const npm = o.npm ?? defaultNpm();
    if (!npm) {
      reason = 'npm not found';
    } else {
      fs.rmSync(dir, { recursive: true, force: true }); // a leftover of an earlier failure
      const log = fs.openSync(o.log ?? path.join(runtimeDir(), 'update.log'), 'a', 0o600);
      try {
        const got = await run(npm, ['install', '--prefix', dir, `nota-bene-ide@${version}`, '--no-audit', '--no-fund'], log);
        if (got.code !== 0) reason = `npm install exited with ${got.code}`;
      } finally { fs.closeSync(log); }
      if (reason === null) {
        const check = await run(o.node ?? process.execPath, [launcherOf(version), '--version'], 'pipe');
        const said = check.stdout.trim();
        if (check.code !== 0 || said !== version) reason = `installed version check said ${said || `exit ${check.code}`}, expected ${version}`;
      }
    }
    if (reason === null && !writeCurrent(version)) reason = 'could not write current';
    if (reason === null) {
      patchUpdateState((s) => { const { failed: _f, ...rest } = s; return rest; });
      pruneRuntime();
      return 'installed';
    }
    patchUpdateState((s) => ({ ...s, failed: { version, at: Date.now(), reason: reason! } }));
    fs.rmSync(dir, { recursive: true, force: true });
    return { failed: reason };
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
    try { patchUpdateState((s) => ({ ...s, failed: { version, at: Date.now(), reason: reason! } })); } catch { /* best effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
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

/** Removes the installed releases that are neither `current`, its predecessor nor run by a live window. */
export function pruneRuntime(): void {
  const keep = versionsInUse();
  const cur = rawCurrent();
  if (cur) keep.add(cur);
  const prev = readUpdateState().previous;
  if (prev) keep.add(prev);
  let names: string[] = [];
  try { names = fs.readdirSync(runtimeDir()); } catch { return; }
  for (const n of names) {
    if (RELEASE.test(n) && !keep.has(n)) fs.rmSync(path.join(runtimeDir(), n), { recursive: true, force: true });
  }
}
