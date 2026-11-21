// Whole-file writes and read-modify-writes of the files every window shares (prefs.json, sessions.json, ...): a write is a
// tmp file renamed over the old one, so a reader never sees half of it; an update holds `<file>.lock` across its read and
// write, so two windows updating one file at once both keep their change (issue 562). Sync: the critical part is short.
import fs from 'node:fs';
import path from 'node:path';
import { pidAlive, renameRetry, sleepSync } from './platform.ts';

/** JSON.stringify's indent, a final newline, the file's mode: what each file has always been written with. */
export type JsonFormat = { space?: number; newline?: boolean; mode?: number };

/** A lock older than this is a holder that hung or a reused pid: an update takes well under it, even a retried rename. */
const STALE_MS = 10_000;

/**
 * Writes `file` whole: a hidden tmp file in the same folder, renamed over the old one (over `file` itself, even a symlink
 * there, never its target); a failed write leaves no tmp file.
 */
export function writeAtomic(file: string, data: string | Buffer, mode?: number): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmp, data, { mode, flag: 'wx' });
    renameRetry(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function writeJsonAtomic(file: string, value: unknown, f: JsonFormat = {}): void {
  writeAtomic(file, JSON.stringify(value, null, f.space) + (f.newline ? '\n' : ''), f.mode);
}

/** A lock whose holder is gone (its pid is dead) or that is older than STALE_MS. An empty one is still being written. */
function stale(lock: string): boolean {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) return true;
    const text = fs.readFileSync(lock, 'utf8');
    return text !== '' && !pidAlive(Number(text));
  } catch {
    return false; // gone meanwhile: the next try takes it
  }
}

/** Moves a stale lock aside (one waiter wins) and drops it; one that turns out live (a newer holder's) is put back. */
function breakLock(lock: string): void {
  const aside = `${lock}.${process.pid}-${Math.random().toString(36).slice(2)}`;
  try { fs.renameSync(lock, aside); } catch { return; }
  if (!stale(aside)) {
    try { fs.linkSync(aside, lock); } catch { /* another holder already made its own */ }
  }
  fs.rmSync(aside, { force: true });
}

/** Runs `fn` holding `<file>.lock` (created with O_EXCL, naming this pid), across processes; never nest it on one file. */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  for (let wait = 1; ; wait = Math.min(wait * 2, 20)) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (stale(lock)) breakLock(lock);
    else sleepSync(wait);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Read-modify-write of the JSON `file` under its lock: `fn` gets what it holds (undefined when missing or corrupt) and
 * returns what to write, or undefined to leave the file as it is.
 */
export function updateJson(file: string, fn: (data: unknown) => unknown, f: JsonFormat = {}): void {
  withLock(file, () => {
    let data: unknown;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = undefined; }
    const next = fn(data);
    if (next !== undefined) writeJsonAtomic(file, next, f);
  });
}
