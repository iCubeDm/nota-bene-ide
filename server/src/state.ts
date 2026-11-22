import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside } from '@nota-bene/shared/paths';
import { parseProvider, providerStateDir, type AgentProvider } from './agent/provider.ts';
import { updateJson } from './atomicFile.ts';
import { realpathNative } from './platform.ts';

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

/** Which agent a set of per-agent stores belongs to, and the folder they keep their data in (epic 383, step 2a). */
export type AgentContext = { provider: AgentProvider; stateDir: string };

/** `provider`'s context under `base`: its folder created and checked as every state folder is. */
export function agentContext(provider: AgentProvider, base: string = stateBaseDir()): AgentContext {
  return { provider, stateDir: ensureStateDir(providerStateDir(base, provider)) };
}

/** The context the launcher chose for this process through NOTA_BENE_AGENT; the only reader of that variable here. */
export function envAgentContext(): AgentContext {
  return agentContext(parseProvider(process.env.NOTA_BENE_AGENT));
}

/**
 * The window process's own folder: its token, control token, prefs and window registry. Chosen by NOTA_BENE_AGENT, as the
 * agent's folder is; step 2b of epic 383 moves each of these to the one server.
 */
export function serverStateDir(): string {
  return envAgentContext().stateDir;
}

/** Created 700 and checked once per process: ours (owner), and on Windows inside the user profile. */
function ensureStateDir(dir: string): string {
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

const asMap = (data: unknown): Record<string, string> =>
  data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, string>) : {};

function read(file: string): Record<string, string> {
  try {
    return asMap(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

export function lastSession(dir: string, projectDir: string): string | undefined {
  return read(path.join(dir, 'sessions.json'))[projectDir];
}

export function saveSession(dir: string, projectDir: string, id: string | null): void {
  updateJson(path.join(dir, 'sessions.json'), (d) => {
    const data = asMap(d);
    if (id === null) delete data[projectDir];
    else data[projectDir] = id;
    return data;
  }, { space: 2 });
}

/** A deleted session: every project whose last session it was forgets it (one atomic write); returns how many did. */
export function forgetSession(dir: string, id: string): number {
  let n = 0;
  updateJson(path.join(dir, 'sessions.json'), (d) => {
    const data = asMap(d);
    const dirs = Object.keys(data).filter((k) => data[k] === id);
    n = dirs.length;
    if (n === 0) return undefined;
    for (const k of dirs) delete data[k];
    return data;
  }, { space: 2 });
  return n;
}
