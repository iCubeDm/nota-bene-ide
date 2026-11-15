// The recently opened folders, for the project switcher's "Recent": `<base>/recent.json` = [{ root, provider, at }], newest
// first, one entry per folder and provider. The launcher records every launch (next to agent-choice.json); folders known only
// from agent-choice.json (opened before this list existed) follow, with no time. Best effort: a launch never fails on it.
import fs from 'node:fs';
import path from 'node:path';
import { readChoices } from './agent/choice.ts';
import { parseProvider, type AgentProvider } from './agent/provider.ts';
import { renameRetry } from './platform.ts';

export type RecentEntry = { root: string; provider: AgentProvider; at: number };
export const RECENT_MAX = 30;
const FILE = 'recent.json';

function readOwn(base: string): RecentEntry[] {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(path.join(base, FILE), 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.filter((e): e is RecentEntry => {
      if (!e || typeof e !== 'object') return false;
      const { root, provider, at } = e as Record<string, unknown>;
      if (typeof root !== 'string' || typeof at !== 'number' || typeof provider !== 'string') return false;
      try {
        return parseProvider(provider) === provider;
      } catch {
        return false;
      }
    }).map(({ root, provider, at }) => ({ root, provider, at }));
  } catch {
    return [];
  }
}

export function recordRecent(base: string, root: string, provider: AgentProvider, now = Date.now()): void {
  try {
    const rest = readOwn(base).filter((e) => e.root !== root || e.provider !== provider);
    const next = [{ root, provider, at: now }, ...rest].slice(0, RECENT_MAX);
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const file = path.join(base, FILE), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameRetry(tmp, file);
  } catch { /* only a list for the switcher */ }
}

export function readRecent(base: string): RecentEntry[] {
  const own = readOwn(base);
  const known = new Set(own.map((e) => e.root));
  let seeded: RecentEntry[] = [];
  try {
    seeded = readChoices(base).filter(([root]) => !known.has(root)).map(([root, provider]) => ({ root, provider, at: 0 }));
  } catch { /* no choices */ }
  return [...own, ...seeded];
}
