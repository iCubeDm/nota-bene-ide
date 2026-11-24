// Issue 639: the top of a server is its home (its folder and agents); a page is an agent's, under /a/<id>/.
import { apiFetch } from './auth.ts';
import { agentBase } from './socket.ts';

/** Whether this page is its server's home (the top of a server that has agents under /a/<id>/), not an older one's agent. */
export async function isHome(loc: Location | URL = location, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (agentBase(loc)) return false;
  try {
    const r = await apiFetch('/info', { cache: 'no-store' }, fetchFn);
    const j = r.ok ? ((await r.json()) as { agent?: unknown; agents?: unknown } | null) : null;
    return !!j && j.agent === undefined && Array.isArray(j.agents);
  } catch {
    return false;
  }
}

/**
 * Where a page goes whose agent its server no longer has (closed, or not reopened by a restart): its socket is refused and
 * `<base>/info` answers 404. The top, its home page. Null otherwise.
 */
export async function agentGone(loc: Location | URL = location, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const base = agentBase(loc);
  if (!base) return null;
  try {
    return (await apiFetch(`${base}/info`, { cache: 'no-store' }, fetchFn)).status === 404 ? `/${loc.search}` : null;
  } catch {
    return null;
  }
}
