import fs from 'node:fs';
import path from 'node:path';
import { isSessionId } from '@nota-bene/shared';
import { renameRetry } from './platform.ts';
import { stateDir } from './state.ts';

// When the person last saw each session: <stateDir>/seen-sessions.json, session id → time (ms). A window's page marks its
// session while it is visible and focused (POST /seen); the projects list counts the final replies after that time as
// unseen. A time, not a count of replies: a compaction drops replies from the history, so a count would go wrong.
export const SEEN_MAX = 2000;
const fileIn = (dir: string) => path.join(dir, 'seen-sessions.json');

/** The marks; a missing or corrupt file is none, an entry that is not a session id with a time is dropped. */
export function readSeen(dir: string = stateDir()): Record<string, number> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(fileIn(dir), 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([k, v]) => isSessionId(k) && typeof v === 'number' && Number.isFinite(v)));
  } catch {
    return {};
  }
}

/** Marks `id` seen at `at` unless it already has a later mark; at most SEEN_MAX ids are kept, the oldest marks go first. */
export function markSeen(id: string, at: number, dir: string = stateDir()): void {
  if (!isSessionId(id)) throw new Error('not a session id');
  const marks = readSeen(dir);
  if ((marks[id] ?? -1) >= at) return;
  marks[id] = at;
  const kept = Object.entries(marks).sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX);
  const file = fileIn(dir);
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
  renameRetry(tmp, file);
}
