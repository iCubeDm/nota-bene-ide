// Issue 639: the top of a server is its home (its folder and agents); a page is an agent's, under /a/<id>/.
import { apiFetch } from './auth.ts';
import { agentBase } from './socket.ts';

/**
 * Where a page opened at the top goes: its server's first agent (`/a/<id>/`, the query kept). Null under an agent, at an
 * older server's top (its first agent's own), with no agent, or no answer.
 */
export async function agentHome(loc: Location | URL = location, fetchFn: typeof fetch = fetch): Promise<string | null> {
  if (agentBase(loc)) return null;
  try {
    const r = await apiFetch('/info', { cache: 'no-store' }, fetchFn);
    const j = r.ok ? ((await r.json()) as { agent?: unknown; agents?: { id?: unknown }[] } | null) : null;
    const id = j && j.agent === undefined && Array.isArray(j.agents) ? j.agents[0]?.id : undefined;
    const to = `/a/${String(id)}/`;
    return typeof id === 'string' && agentBase(new URL(to, 'http://x')) ? `${to}${loc.search}` : null;
  } catch {
    return null;
  }
}
