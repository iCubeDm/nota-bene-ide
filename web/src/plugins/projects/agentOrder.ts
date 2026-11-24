// Issue 638: the order of a project's agent tabs, the same on every agent's page, so moving to one only changes which is
// active; a drag changes it. One list of this origin for every project, an agent named by its port and id; agents it
// does not name keep the server's order after the ones it does.
import { json, storage, useStored } from '@/sdk';
import type { RunningRow } from './api.ts';

const MAX = 100;
const saved = storage.local<string[]>('nb.agentOrder', json((v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')), []);

export const agentKey = (r: RunningRow): string => `${r.port}/${r.agent ?? r.provider}`;
export const useAgentOrder = (): string[] => useStored(saved);

/** `rows` in the saved order */
export function ordered(rows: RunningRow[], order: string[]): RunningRow[] {
  const at = new Map(order.map((k, i) => [k, i]));
  const rank = (r: RunningRow, i: number) => at.get(agentKey(r)) ?? order.length + i;
  return rows.map((r, i) => ({ r, n: rank(r, i) })).sort((a, b) => a.n - b.n).map((x) => x.r);
}

/** a drag among `shown` (in their order): `from` goes before or after `to`; the rest of the list keeps its place */
export function moveAgent(shown: RunningRow[], from: string, to: string, after: boolean): void {
  const keys = shown.map(agentKey).filter((k) => k !== from);
  const j = keys.indexOf(to);
  if (j < 0 || !shown.some((r) => agentKey(r) === from)) return;
  keys.splice(j + (after ? 1 : 0), 0, from);
  const here = new Set(keys);
  saved.set([...keys, ...saved.get().filter((k) => !here.has(k))].slice(0, MAX));
}
