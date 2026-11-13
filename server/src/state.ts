import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside } from '@nota-bene/shared/paths';
import { parseProvider, providerStateDir } from './agent/provider.ts';
import { realpathNative, renameRetry } from './platform.ts';

/** A secret or the state folder is unusable (wrong owner, loose mode, ...): the user has to act. Never swallowed as "not ours". */
export class SecretError extends Error {}

const tightened = new Set<string>();

/** The state dir. It holds the access token, so it is private to the user: created 700, and tightened to 700 once per process. */
export function stateBaseDir(): string {
  return process.env.NOTA_BENE_HOME ?? path.join(os.homedir(), '.nota-bene');
}

/**
 * Windows: why the state folder `real` (a real path) may not be used, or null. Mode bits mean nothing there; what keeps the
 * token private is the ACL the folder inherits, and only the user profile's (`profile`) shuts out the other local users by
 * default (a folder elsewhere, `C:\nb` or `D:\state`, is readable by every user). So a folder outside the profile is refused
 * unless NOTA_BENE_ALLOW_SHARED_HOME=1 says its ACL was restricted by hand. Case-insensitive, either separator.
 */
export function sharedHomeRefusal(real: string, profile: string, env: Record<string, string | undefined> = process.env): string | null {
  if (env.NOTA_BENE_ALLOW_SHARED_HOME === '1' || isInside(real, profile, { caseInsensitive: true })) return null;
  return `the state folder ${real} is outside your user profile (${profile}), where other users of this computer can read the access token by default; refusing to use it. `
    + 'Unset NOTA_BENE_HOME or point it at a folder inside your profile, or, if only you can read that folder, set NOTA_BENE_ALLOW_SHARED_HOME=1';
}

export function stateDir(): string {
  const dir = providerStateDir(stateBaseDir(), parseProvider(process.env.NOTA_BENE_AGENT));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!tightened.has(dir)) {
    if (process.platform === 'win32') {
      const why = sharedHomeRefusal(realpathNative(dir), realpathNative(os.homedir()));
      if (why) throw new SecretError(why);
    }
    if (process.getuid && fs.statSync(dir).uid !== process.getuid()) {
      throw new SecretError(`the state folder ${dir} belongs to another user; refusing to use it. Point NOTA_BENE_HOME at a folder of your own`);
    }
    tightened.add(dir);
    try {
      fs.chmodSync(dir, 0o700); // best effort: a dir that is not ours stays as it is
    } catch { /* not ours */ }
  }
  return dir;
}

function read(file: string): Record<string, string> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function lastSession(projectDir: string): string | undefined {
  return read(path.join(stateDir(), 'sessions.json'))[projectDir];
}

export function saveSession(projectDir: string, id: string | null): void {
  const file = path.join(stateDir(), 'sessions.json');
  const data = read(file);
  if (id === null) delete data[projectDir];
  else data[projectDir] = id;
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameRetry(tmp, file);
}

/** A deleted session: every project whose last session it was forgets it (one atomic write); returns how many did. */
export function forgetSession(id: string): number {
  const file = path.join(stateDir(), 'sessions.json');
  const data = read(file);
  const dirs = Object.keys(data).filter((k) => data[k] === id);
  if (dirs.length === 0) return 0;
  for (const k of dirs) delete data[k];
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameRetry(tmp, file);
  return dirs.length;
}

/** Adds the entries the file does not have yet (never overwrites), in one atomic write; returns how many were added. */
export function addMissingSessions(entries: Record<string, string>): number {
  const file = path.join(stateDir(), 'sessions.json');
  const data = read(file);
  let added = 0;
  for (const [k, v] of Object.entries(entries)) {
    if (data[k] !== undefined) continue;
    data[k] = v;
    added++;
  }
  if (added === 0) return 0;
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameRetry(tmp, file);
  return added;
}
