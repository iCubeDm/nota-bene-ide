// Issue 706: prefs.json is the server's, in the state folder itself. A server started as Codex or omp kept its own in
// `providers/<p>`, and `modes` and `idleCompact` were keyed by the folder alone. Run at the server's start; a second run
// finds nothing. Tokens and registry entries are not moved: they belong to live processes and are made again.
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDERS, providerStateDir, type AgentProvider } from './agent/provider.ts';
import { PER_AGENT, updateRawPrefs } from './prefs.ts';
import { serverStateDir } from './state.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const keyed = (k: string) => PROVIDERS.some((p) => k.startsWith(`${p}:`));
/** kept by the folder alone before: now an agent's (`models` was never read that way, issue 662) */
const BY_FOLDER = ['modes', 'idleCompact'] as const;

function readObj(file: string): Obj | null {
  try {
    return obj(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** `to[name]`, made when absent. */
function map(to: Obj, name: string): Obj {
  return (to[name] = obj(to[name]) ?? {}) as Obj;
}

/** `from`, a file of `provider`'s folder, into `to`: what `to` has wins; an entry for a folder alone becomes `provider`'s. */
function merge(to: Obj, from: Obj, provider: AgentProvider): void {
  for (const [k, v] of Object.entries(from)) {
    if (!(PER_AGENT as readonly string[]).includes(k)) to[k] ??= v;
  }
  for (const name of PER_AGENT) {
    for (const [k, v] of Object.entries(obj(from[name]) ?? {})) {
      if (!keyed(k) && name === 'models') continue;
      map(to, name)[keyed(k) ? k : `${provider}:${k}`] ??= v;
    }
  }
}

const byFolder = (raw: Obj) => BY_FOLDER.flatMap((name) => Object.keys(obj(raw[name]) ?? {}).filter((k) => !keyed(k)).map((k) => [name, k] as const));

export function migratePrefs(): void {
  const base = serverStateDir();
  const old = PROVIDERS.flatMap((provider) => {
    const file = path.join(providerStateDir(base, provider), 'prefs.json');
    const from = path.dirname(file) === base ? null : readObj(file);
    return from ? [{ provider, file, from }] : [];
  });
  if (!old.length && !byFolder(readObj(path.join(base, 'prefs.json')) ?? {}).length) return;
  updateRawPrefs((raw) => {
    for (const { provider, from } of old) merge(raw, from, provider);
    // after the merge: a provider's own entry wins over the folder's
    for (const [name, k] of byFolder(raw)) {
      const m = map(raw, name);
      for (const p of PROVIDERS) m[`${p}:${k}`] ??= m[k];
      delete m[k];
    }
  });
  for (const { file } of old) {
    try {
      fs.renameSync(file, `${file}.moved`);
    } catch { /* another process moved it */ }
  }
}
