// Which servers run on this machine and which agents each has (issue 680): the one reading the switcher (projects.ts), the
// remote connector (remote/discover.ts, remote/device.ts) and the launcher's attach (attach.ts) share.
//
// One registry and one token, in the server's state folder. Registry entries are only hints: a caller proves the listener
// with the token (GET /hello) before anything is sent to it. Nothing here creates a token: without one there are no servers.
import path from 'node:path';
import { PROVIDERS, type AgentProvider } from './agent/provider.ts';
import { readPrivateFile, SecretError } from './auth.ts';
import { AGENT_ID, agentPath, serverStateDir } from './state.ts';
import { readWindows, type WindowEntry } from './windows.ts';

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** The access token, or null when there is none yet; throws SecretError for an unusable file. */
export function serverToken(): string | null {
  return readPrivateFile(path.join(serverStateDir(), 'token'), TOKEN_RE, 'a token (64 hex characters)', 'delete it to make a new token (every open window then has to be reopened)');
}

/**
 * What a server's own row names as its agent. A server has none: the row is a server that does not answer, or an older one
 * whose top is its only agent.
 */
export const SERVER_PROVIDER: AgentProvider = 'claude';

export type Registry = { token: string; entries: [port: number, w: WindowEntry][] };

/** The registry with its token; null: no token, so no servers. An unusable token file goes to `bad` (then null), else it throws. */
export function registry(bad?: (e: SecretError) => void): Registry | null {
  let token: string | null;
  try {
    token = serverToken();
  } catch (e) {
    if (!bad || !(e instanceof SecretError)) throw e;
    bad(e);
    return null;
  }
  return token ? { token, entries: Object.entries(readWindows()).map(([port, w]) => [Number(port), w]) } : null;
}

/** GET /info at `base` ('' the server's, `/a/<id>` an agent's) with a proved listener's `bearer`: its fields, or null. */
export async function infoAt(port: number, base: string, bearer: string, fetchFn: typeof fetch = fetch, ms = 700): Promise<Record<string, unknown> | null> {
  try {
    // never follow a redirect: the answer must be that port's own
    const r = await fetchFn(`http://127.0.0.1:${port}${base}/info`, { headers: { authorization: bearer }, signal: AbortSignal.timeout(ms), redirect: 'error' });
    if (!r.ok) return null;
    const j: unknown = await r.json();
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A server's agents (its /info's `agents`), well formed only. */
export function agentsOf(info: Record<string, unknown> | null): { id: string; provider: AgentProvider }[] {
  if (!info || !Array.isArray(info.agents)) return [];
  return info.agents.flatMap((x: unknown) => {
    const { id, provider } = (x ?? {}) as { id?: unknown; provider?: unknown };
    return typeof id === 'string' && AGENT_ID.test(id) && (PROVIDERS as unknown[]).includes(provider) ? [{ id, provider: provider as AgentProvider }] : [];
  });
}

/**
 * A proved server's own /info (`top`) and each of its agents with that agent's /info, read under its prefix; an older
 * server's top is its first agent's. `info` is null for an agent that went between the two reads.
 */
export async function serverAgents(port: number, bearer: string, fetchFn: typeof fetch = fetch, ms?: number): Promise<{ top: Record<string, unknown> | null; agents: { id: string; provider: AgentProvider; info: Record<string, unknown> | null }[] }> {
  const top = await infoAt(port, '', bearer, fetchFn, ms);
  const agents = await Promise.all(agentsOf(top).map(async (a) => ({ ...a, info: a.id === top?.agent ? top : await infoAt(port, agentPath(a.id), bearer, fetchFn, ms) })));
  return { top, agents };
}
