// The recently opened folders, for the project switcher's "Recent": `<base>/recent.json` = [{ root, provider, at }], newest
// first, one entry per folder and provider. The launcher records every launch (next to agent-choice.json); folders known only
// from agent-choice.json (opened before this list existed) follow, with no time. Best effort: a launch never fails on it.
// A folder the person removes from the list goes to `<base>/recent-hidden.json` (its roots, newest first): out of the list for
// every provider, the seeded ones and this window's session history included (the page filters those), until it is launched again.
import fs from 'node:fs';
import path from 'node:path';
import { readChoices } from './agent/choice.ts';
import { parseProvider, type AgentProvider } from './agent/provider.ts';
import { renameRetry } from './platform.ts';
import { wirePath } from './wirePath.ts';

export type RecentEntry = { root: string; provider: AgentProvider; at: number };
export const RECENT_MAX = 30;
const HIDDEN_MAX = 200;
const FILE = 'recent.json';
const HIDDEN = 'recent-hidden.json';
/** the page names a folder in the wire form (wirePath), the files keep it as launched */
const same = (stored: string, given: string) => stored === given || wirePath(stored) === given;

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

export function readHidden(base: string): string[] {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(path.join(base, HIDDEN), 'utf8'));
    return Array.isArray(data) ? data.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

function write(base: string, name: string, data: unknown): void {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const file = path.join(base, name), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameRetry(tmp, file);
}

export function recordRecent(base: string, root: string, provider: AgentProvider, now = Date.now()): void {
  try {
    const rest = readOwn(base).filter((e) => e.root !== root || e.provider !== provider);
    write(base, FILE, [{ root, provider, at: now }, ...rest].slice(0, RECENT_MAX));
    const hidden = readHidden(base);
    if (hidden.some((h) => same(root, h))) write(base, HIDDEN, hidden.filter((h) => !same(root, h)));
  } catch { /* only a list for the switcher */ }
}

/** Removes `root` from the list, for every provider; throws when the files cannot be written (the page says so). */
export function forgetRecent(base: string, root: string): void {
  const own = readOwn(base);
  if (own.some((e) => same(e.root, root))) write(base, FILE, own.filter((e) => !same(e.root, root)));
  write(base, HIDDEN, [root, ...readHidden(base).filter((h) => h !== root)].slice(0, HIDDEN_MAX));
}

export function readRecent(base: string): RecentEntry[] {
  const hidden = readHidden(base);
  const shown = (root: string) => !hidden.some((h) => same(root, h));
  const own = readOwn(base).filter((e) => shown(e.root));
  const known = new Set(readOwn(base).map((e) => e.root));
  let seeded: RecentEntry[] = [];
  try {
    seeded = readChoices(base).filter(([root]) => !known.has(root) && shown(root)).map(([root, provider]) => ({ root, provider, at: 0 }));
  } catch { /* no choices */ }
  return [...own, ...seeded];
}
