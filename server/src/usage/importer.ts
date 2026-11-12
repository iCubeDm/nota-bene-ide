// Brings new transcript lines into the store. Incremental by byte offset; the first run reads everything, in chunks
// that yield to the event loop, while the report already answers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UsageProvider } from '@nota-bene/shared';
import { realpathNative } from '../platform.ts';
import { defaultProjectsDir } from '../sessions.ts';
import { claudeAgentRecord, claudeFile, isTempDir, parseClaudeLine, parseCodexLine, type UsageRecord } from './parse.ts';
import { readLines, type FileState, type ImportState, type UsageStore } from './store.ts';

const LOCK_STALE_MS = 10 * 60_000;
const FLUSH_RECORDS = 5000;
const SAVE_EVERY_FILES = 50;
/** Raise it when a parser change should reach what is already in the store: every transcript is read once more. */
const PARSE_VERSION = 2;

/** The temporary folders of this machine (POSIX: also /tmp and macOS's /private/tmp, whatever TMPDIR says). */
export const tempDirs = (platform: NodeJS.Platform = process.platform): string[] => {
  const tmp = os.tmpdir();
  let real = tmp;
  try { real = realpathNative(tmp); } catch { /* keep the name */ }
  if (platform === 'win32') return [...new Set([tmp.replace(/[\\/]+$/, ''), real])];
  return [...new Set(['/tmp', '/private/tmp', tmp.replace(/\/$/, ''), real])];
};

function jsonlUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.isFile() && n.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Where a provider's transcripts live, and how one file's lines become records. */
export type UsageSource = {
  files(): string[];
  /** `state.context` is kept between imports */
  reader(file: string, state: FileState): { line(text: string): UsageRecord[]; finish?(): UsageRecord[] };
};

export function claudeSource(root: string = defaultProjectsDir()): UsageSource {
  return {
    files: () => jsonlUnder(root),
    reader(file) {
      const where = claudeFile(path.relative(root, file));
      return {
        line: (text) => parseClaudeLine(text, where),
        finish() {
          if (!where.agent) return [];
          try {
            const r = claudeAgentRecord(where.agent, fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
            return r ? [r] : [];
          } catch {
            return [];
          }
        },
      };
    },
  };
}

export function codexSource(home: string = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')): UsageSource {
  return {
    files: () => ['sessions', 'archived_sessions'].flatMap((d) => jsonlUnder(path.join(home, d))),
    reader(_file, state) {
      const context = state.context ??= {};
      return { line: (text) => parseCodexLine(text, context) };
    },
  };
}

export const defaultSource = (provider: UsageProvider): UsageSource => (provider === 'codex' ? codexSource() : claudeSource());

/** Drops what the store already says: a call's later lines only count when a counter grew. */
function freshFilter(known: readonly UsageRecord[]): (r: UsageRecord) => boolean {
  const calls = new Map<string, { in: number; out: number; write: number; read: number }>();
  const other = new Set<string>();
  const key = (r: Exclude<UsageRecord, { k: 'c' }>): string =>
    r.k === 'p' ? `p${r.session}:${r.ts}:${r.label}` : r.k === 'a' ? `a${r.id}` : r.k === 'h' ? `h${r.ts}` : r.k === 'x' ? `x${r.ts}` : `l${r.ts}:${r.minutes}`;
  const fresh = (r: UsageRecord): boolean => {
    if (r.k === 'c') {
      const a = calls.get(r.id);
      if (a && r.in <= a.in && r.out <= a.out && r.write <= a.write && r.read <= a.read) return false;
      calls.set(r.id, { in: Math.max(a?.in ?? 0, r.in), out: Math.max(a?.out ?? 0, r.out), write: Math.max(a?.write ?? 0, r.write), read: Math.max(a?.read ?? 0, r.read) });
      return true;
    }
    const k = key(r);
    if (other.has(k)) return false;
    other.add(k);
    return true;
  };
  for (const r of known) fresh(r);
  return fresh;
}

/** One pass over the transcripts. Returns false when another window holds the lock. */
export async function importUsage(store: UsageStore, source: UsageSource): Promise<boolean> {
  const lock = store.lock(LOCK_STALE_MS);
  if (!lock) return false;
  try {
    const fresh = freshFilter(await store.load());
    const temp = tempDirs();
    const state: ImportState = store.readState();
    let batch: UsageRecord[] = [], changed = 0;
    const take = (records: readonly UsageRecord[]) => {
      for (const r of records) {
        if (r.k === 'c' && isTempDir(r.cwd, temp)) continue;
        if (fresh(r)) batch.push(r);
      }
    };
    const flush = () => { store.append(batch); batch = []; };
    for (const file of source.files()) {
      let size: number;
      try { size = fs.statSync(file).size; } catch { continue; } // vanished meanwhile
      const known = state[file]?.v === PARSE_VERSION ? state[file] : undefined;
      const prev = known && size >= known.offset ? known : { offset: 0 }; // smaller: rewritten, read it anew
      if (size === prev.offset) continue;
      const reader = source.reader(file, prev);
      try {
        const offset = await readLines(file, prev.offset, (text) => {
          take(reader.line(text));
          if (batch.length >= FLUSH_RECORDS) flush();
        });
        take(reader.finish?.() ?? []);
        state[file] = { ...prev, offset, v: PARSE_VERSION };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (++changed % SAVE_EVERY_FILES === 0) {
        flush();
        store.writeState(state);
        lock.touch();
      }
    }
    flush();
    store.writeState(state);
    return true;
  } finally {
    lock.release();
  }
}
