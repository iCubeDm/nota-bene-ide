// Which servers run on this machine and which agents each has (issue 680): the one reading the switcher (projects.ts), the
// remote connector (remote/discover.ts, remote/device.ts) and the launcher's attach (attach.ts) share.
//
// Each provider has its own registry and token (state dir per provider; a server keeps the token of the provider it
// started as). Registry entries are only hints: a caller proves the listener with that provider's token (GET /hello)
// before anything is sent to it. Nothing here creates a token: a provider without one has no servers.
import path from 'node:path';
import { PROVIDERS, providerStateDir, type AgentProvider } from './agent/provider.ts';
import { readPrivateFile, SecretError } from './auth.ts';
import { AGENT_ID, stateBaseDir } from './state.ts';
import { readWindows, type WindowEntry } from './windows.ts';

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** A provider state dir's access token, or null when it has none; throws SecretError for an unusable file. */
export function providerToken(dir: string): string | null {
  return readPrivateFile(path.join(dir, 'token'), TOKEN_RE, 'a token (64 hex characters)', 'delete it to make a new token (every open window then has to be reopened)');
}

export type Registry = { provider: AgentProvider; dir: string; token: string; entries: [port: number, w: WindowEntry][] };

/** Every provider's registry with its token, in PROVIDERS' order. `bad`: a provider whose token file is unusable (it is left out). */
export function registries(bad: (e: SecretError, provider: AgentProvider) => void = () => {}): Registry[] {
  return PROVIDERS.flatMap((provider): Registry[] => {
    const dir = providerStateDir(stateBaseDir(), provider);
    let token: string | null;
    try {
      token = providerToken(dir);
    } catch (e) {
      if (!(e instanceof SecretError)) throw e;
      bad(e, provider);
      return [];
    }
    return token ? [{ provider, dir, token, entries: Object.entries(readWindows(dir)).map(([port, w]) => [Number(port), w]) }] : [];
  });
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
  const agents = await Promise.all(agentsOf(top).map(async (a) => ({ ...a, info: a.id === top?.agent ? top : await infoAt(port, `/a/${a.id}`, bearer, fetchFn, ms) })));
  return { top, agents };
}
