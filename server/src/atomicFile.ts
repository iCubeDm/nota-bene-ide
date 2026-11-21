// Whole-file writes and read-modify-writes of the files every window shares (prefs.json, sessions.json, ...): a write is a
// tmp file renamed over the old one, so a reader never sees half of it; an update holds `<file>.lock` across its read and
// write, so two windows updating one file at once both keep their change (issue 562). Sync: the critical part is short.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pidAlive, renameRetry, sleepSync } from './platform.ts';

/** JSON.stringify's indent, a final newline, the file's mode: what each file has always been written with. */
export type JsonFormat = { space?: number; newline?: boolean; mode?: number };

/**
 * `staleMs`: a lock older than this (or dated this far ahead: a clock that jumped) is a holder that hung or slept, or a
 * reused pid; an update takes well under it, even a retried rename. `waitMs`: a wait longer than this is an error.
 */
export const LOCK = { staleMs: 10_000, waitMs: 15_000 };

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

const token = (): string => `${process.pid} ${randomBytes(8).toString('hex')}`;
const readText = (file: string): string | null => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};

/**
 * What a stale lock holds (to hand to breakLock), or null for a live or missing one. Stale: its pid is dead, or its age
 * is past LOCK.staleMs either way. An empty one is being written: judged by age only.
 */
function staleText(lock: string): string | null {
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    const text = fs.readFileSync(lock, 'utf8');
    if (Math.abs(age) > LOCK.staleMs) return text;
    return text !== '' && !pidAlive(Number(text.split(' ')[0])) ? text : null;
  } catch {
    return null; // gone meanwhile: the next try takes it
  }
}

/**
 * Removes `lock` (true) only while it still holds `judged`, the text found stale; a lock that has changed since (a new
 * holder's) is never moved or removed. One breaker at a time, under `<lock>.break`: with no other breaker, the text can
 * only change by its own holder releasing it, so the check and the removal see one lock. A break lock left by a crash
 * (it is held for two syscalls) goes after LOCK.staleMs.
 */
export function breakLock(lock: string, judged: string): boolean {
  const brk = `${lock}.break`;
  try {
    fs.writeFileSync(brk, '', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try {
      if (Math.abs(Date.now() - fs.statSync(brk).mtimeMs) > LOCK.staleMs) fs.rmSync(brk, { force: true });
    } catch { /* gone */ }
    return false;
  }
  try {
    if (readText(lock) !== judged) return false;
    fs.rmSync(lock, { force: true });
    return true;
  } finally {
    fs.rmSync(brk, { force: true });
  }
}

/**
 * Runs `fn` holding `<file>.lock` (created with O_EXCL, naming this pid and a token of its own), across processes; never
 * nest it on one file. The release removes the lock only while it is still ours. Throws when the wait passes LOCK.waitMs.
 */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`, mine = token(), until = Date.now() + LOCK.waitMs;
  for (let wait = 1; ; wait = Math.min(wait * 2, 20)) {
    try {
      fs.writeFileSync(lock, mine, { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (Date.now() > until) throw new Error(`timed out waiting for the lock ${lock}`);
    const judged = staleText(lock);
    if (judged === null || !breakLock(lock, judged)) sleepSync(wait);
  }
  try {
    return fn();
  } finally {
    if (readText(lock) === mine) fs.rmSync(lock, { force: true });
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
