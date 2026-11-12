import fs from 'node:fs';
import path from 'node:path';
import { isSessionId } from '@nota-bene/shared';
import { renameRetry } from './platform.ts';
import { stateDir } from './state.ts';

// The Sessions menu's archive: <stateDir>/archived-sessions.json, the ids it hides, oldest first. Nota Bene's own list (per
// provider, as the state dir is): the agent's transcripts and threads are never touched, and an id no listing has is ignored
const MAX = 5000;
const fileIn = (dir: string) => path.join(dir, 'archived-sessions.json');

/** The archived ids; a missing or corrupt file is none, an entry that is not a session id is dropped. */
export function readArchived(dir: string = stateDir()): Set<string> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(fileIn(dir), 'utf8'));
    return new Set(Array.isArray(data) ? data.filter(isSessionId) : []);
  } catch {
    return new Set();
  }
}

/** Archives (`on`) or restores `id`, in one atomic write; at most MAX ids are kept, the oldest go first. */
export function setArchived(id: string, on: boolean, dir: string = stateDir()): void {
  if (!isSessionId(id)) throw new Error('not a session id');
  const ids = readArchived(dir);
  if (ids.has(id) === on) return;
  if (on) ids.add(id); else ids.delete(id);
  const file = fileIn(dir);
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify([...ids].slice(-MAX)));
  renameRetry(tmp, file);
}
