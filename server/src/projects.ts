// The project switcher's server side (phase 1, over today's one-process windows): every provider's windows with their
// agent's state, the recent folders, and the login a tab needs to move to one of them.
//
// Each provider has its own registry and token (state dir per provider), so a window is proved with its own provider's token
// before anything is sent to it, as the remote connector does (remote/discover.ts). The login is the launcher's (`loginTarget`
// in bin/nota-bene.mjs): derived from that token, that port and the nonce the listener proved. It goes only into the JSON
// answer to the page, which navigates to it; never into a log, an error or a URL query.
import { providerStateDir, type AgentProvider } from './agent/provider.ts';
import { helperCredential, loginCredential, proveListener, SecretError } from './auth.ts';
import { readRecent, type RecentEntry } from './recent.ts';
import { providerToken } from './remote/discover.ts';
import { stateBaseDir } from './state.ts';
import { pidAlive, readWindows, type WindowEntry } from './windows.ts';
import { wirePath } from './wirePath.ts';

export const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'omp'];
const PROBE_MS = 700;

export type ProjectState = 'working' | 'waiting' | 'idle' | 'restarting' | 'silent';
export type RunningRow = {
  provider: AgentProvider; port: number; root: string; title: string | null; session: string | null;
  state: ProjectState; current: boolean; clients: number;
};
export type ProjectsList = { running: RunningRow[]; recent: (RecentEntry & { running: boolean })[] };
export type ProbedInfo = { root: string; session?: string | null; title?: string | null; busy?: boolean; pending?: boolean; clients?: number };
export type Probe = (port: number, token: string) => Promise<ProbedInfo | null>;

/** The listener on `port` proved with `token`, then its /info with that launch's helper bearer; null for anything else. */
export const probeWith: Probe = async (port, token) => {
  const n = await proveListener({ dial: port, timeoutMs: PROBE_MS, token });
  if (n === null) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/info`, { headers: { authorization: `Bearer ${helperCredential(token, port, n)}` }, signal: AbortSignal.timeout(PROBE_MS), redirect: 'error' });
    if (!r.ok) return null;
    const j = (await r.json()) as ProbedInfo | null;
    return j && typeof j.root === 'string' ? j : null;
  } catch {
    return null;
  }
};

const folder = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;
const sameRoot = (stored: string, given: string) => stored === given || wirePath(stored) === given;

/** A provider's registry and token; null when it has no token (it has no windows). Throws SecretError for a bad token file. */
function providerOf(provider: AgentProvider): { token: string; entries: [string, WindowEntry][] } | null {
  const dir = providerStateDir(stateBaseDir(), provider);
  const token = providerToken(dir);
  return token ? { token, entries: Object.entries(readWindows(dir)) } : null;
}

export async function listProjects(own: { port: number; provider: AgentProvider }, probe: Probe = probeWith, warn: (m: string) => void = () => {}): Promise<ProjectsList> {
  const rows: RunningRow[] = [];
  await Promise.all(PROVIDERS.map(async (provider) => {
    let p: ReturnType<typeof providerOf>;
    try {
      p = providerOf(provider);
    } catch (e) {
      if (e instanceof SecretError) return warn(e.message);
      throw e;
    }
    if (!p) return;
    const { token } = p;
    await Promise.all(p.entries.map(async ([key, w]) => {
      const port = Number(key);
      const alive = pidAlive(w.pid);
      if (!alive && !(w.launcherPid !== undefined && pidAlive(w.launcherPid))) return; // stale: gone
      const info = alive ? await probe(port, token) : null;
      const live = info && info.root === w.root ? info : null;
      const state: ProjectState = !alive ? 'restarting' : !live ? 'silent' : live.pending ? 'waiting' : live.busy ? 'working' : 'idle';
      rows.push({
        provider, port, root: wirePath(w.root), title: live?.title ?? null, session: live?.session ?? null, state,
        current: port === own.port && provider === own.provider, clients: live?.clients ?? 0,
      });
    }));
  }));
  rows.sort((a, b) => folder(a.root).localeCompare(folder(b.root)) || a.root.localeCompare(b.root) || PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider));
  const up = new Set(rows.filter((r) => r.state !== 'restarting').map((r) => `${r.provider} ${r.root}`));
  const recent = readRecent(stateBaseDir()).map((e) => ({ ...e, root: wirePath(e.root), running: up.has(`${e.provider} ${wirePath(e.root)}`) }));
  return { running: rows, recent };
}

export type EnterResult = { url: string } | { error: 'no such window' | 'window not answering' };

/** The login URL of a registered window of `provider` on `port` that still holds `root`. */
export async function enterUrl(o: { provider: AgentProvider; port: number; root: string }, fetchFn: typeof fetch = fetch): Promise<EnterResult> {
  const p = providerOf(o.provider);
  const w = p?.entries.find(([k]) => Number(k) === o.port)?.[1];
  if (!p || !w || !pidAlive(w.pid) || !sameRoot(w.root, o.root)) return { error: 'no such window' };
  const n = await proveListener({ dial: o.port, timeoutMs: 1500, token: p.token, fetchFn });
  if (n === null) return { error: 'window not answering' };
  try {
    const r = await fetchFn(`http://127.0.0.1:${o.port}/info`, { headers: { authorization: `Bearer ${helperCredential(p.token, o.port, n)}` }, signal: AbortSignal.timeout(1500), redirect: 'error' });
    const j = r.ok ? ((await r.json()) as { root?: unknown } | null) : null;
    if (!j || j.root !== w.root) return { error: 'window not answering' };
  } catch {
    return { error: 'window not answering' };
  }
  return { url: `http://127.0.0.1:${o.port}/#t=${loginCredential(p.token, o.port, n)}` };
}
