// The project switcher's server side (phase 1, over today's one-process windows): every provider's windows with their
// agent's state, the recent folders, and the login a tab needs to move to one of them.
//
// Each provider has its own registry and token (state dir per provider), so a window is proved with its own provider's token
// before anything is sent to it, as the remote connector does (remote/discover.ts). The login is the launcher's (`loginTarget`
// in bin/nota-bene.mjs): derived from that token, that port and the nonce the listener proved. It goes only into the JSON
// answer to the page, which navigates to it; never into a log, an error or a URL query.
import { providerStateDir, type AgentProvider } from './agent/provider.ts';
import path from 'node:path';
import { helperCredential, loginCredential, proveListener, readSecret, SecretError } from './auth.ts';
import { readHidden, readRecent, type RecentEntry } from './recent.ts';
import { CONTROL_HEADER } from './system.ts';
import { providerToken } from './remote/discover.ts';
import { stateBaseDir } from './state.ts';
import { pidAlive, readWindows, type WindowEntry } from './windows.ts';
import { wirePath } from './wirePath.ts';

export const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'omp'];
const PROBE_MS = 700;

export type ProjectState = 'working' | 'waiting' | 'idle' | 'restarting' | 'silent';
export type LastMessage = { role: 'user' | 'assistant'; text: string; at?: number };
export type RunningRow = {
  provider: AgentProvider; port: number; root: string; title: string | null; session: string | null;
  state: ProjectState; current: boolean; clients: number;
  /** final replies of its session after the person last saw it (seen.ts) */
  unseen: number;
  last: LastMessage | null;
  /** issue 297: a window of a paired computer (its host id and name), reached through this computer's connector */
  remote?: { host: string; name: string };
};
export type ProjectsList = { running: RunningRow[]; recent: (RecentEntry & { running: boolean })[]; /** folders removed from Recent (recent.ts): the page drops them from its session history too */ hidden: string[] };
export type ProbedInfo = {
  root: string; session?: string | null; title?: string | null; busy?: boolean; pending?: boolean; clients?: number;
  unseen?: number; last?: LastMessage | null;
};
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
        unseen: typeof live?.unseen === 'number' ? live.unseen : 0, last: live?.last ?? null,
      });
    }));
  }));
  rows.sort((a, b) => folder(a.root).localeCompare(folder(b.root)) || a.root.localeCompare(b.root) || PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider));
  const up = new Set(rows.filter((r) => r.state !== 'restarting').map((r) => `${r.provider} ${r.root}`));
  const recent = readRecent(stateBaseDir()).map((e) => ({ ...e, root: wirePath(e.root), running: up.has(`${e.provider} ${wirePath(e.root)}`) }));
  return { running: rows, recent, hidden: readHidden(stateBaseDir()) };
}

/** A paired computer's windows as its host stream lists them (remote/hostLink.ts), for the switcher. */
export type Computer = { id: string; name: string; windows: { port: number; provider: string; root: string; [k: string]: unknown }[] };

/**
 * The windows of the paired computers as rows (issue 297), the state from what the host stream says (`pending`, `busy`);
 * `current`: the one a desktop proxy's page shows. An unknown agent's window is left out (the page names the agents).
 */
export function remoteRows(computers: Computer[], current?: { host: string; port: number }): RunningRow[] {
  return computers.flatMap((c) => c.windows.flatMap((w): RunningRow[] => {
    if (!(PROVIDERS as string[]).includes(w.provider) || typeof w.port !== 'number' || typeof w.root !== 'string') return [];
    const last = w.last && typeof w.last === 'object' ? w.last as LastMessage : null;
    return [{
      provider: w.provider as AgentProvider, port: w.port, root: w.root, title: typeof w.title === 'string' ? w.title : null,
      session: typeof w.session === 'string' ? w.session : null, state: w.pending ? 'waiting' : w.busy ? 'working' : 'idle',
      current: current?.host === c.id && current.port === w.port, clients: 0, unseen: 0, last, remote: { host: c.id, name: c.name },
    }];
  }));
}

/**
 * A row as another computer's page gets it (issue 297, the desktop proxy): what the switcher lists and moves with (folder,
 * agent, port, state, computer), none of the window's content (title, session, last message, counts).
 */
export const bareRow = (r: RunningRow): RunningRow => ({ ...r, title: null, session: null, clients: 0, unseen: 0, last: null });

export type EnterResult = { url: string } | { error: 'no such window' | 'window not answering' };
type Window = { provider: AgentProvider; port: number; root: string };
type Proved = { token: string; nonce: string; bearer: string; root: string } | { error: 'no such window' | 'window not answering' };

/** A registered window of `provider` on `port` that still holds `root`: proved with its provider's token, its /info checked. */
async function proved(o: Window, fetchFn: typeof fetch): Promise<Proved> {
  const p = providerOf(o.provider);
  const w = p?.entries.find(([k]) => Number(k) === o.port)?.[1];
  if (!p || !w || !pidAlive(w.pid) || !sameRoot(w.root, o.root)) return { error: 'no such window' };
  const n = await proveListener({ dial: o.port, timeoutMs: 1500, token: p.token, fetchFn });
  if (n === null) return { error: 'window not answering' };
  const bearer = `Bearer ${helperCredential(p.token, o.port, n)}`;
  try {
    const r = await fetchFn(`http://127.0.0.1:${o.port}/info`, { headers: { authorization: bearer }, signal: AbortSignal.timeout(1500), redirect: 'error' });
    const j = r.ok ? ((await r.json()) as { root?: unknown } | null) : null;
    if (!j || j.root !== w.root) return { error: 'window not answering' };
  } catch {
    return { error: 'window not answering' };
  }
  return { token: p.token, nonce: n, bearer, root: w.root };
}

/** The login URL of that window; with `session`, the page there opens that session once logged in (web landing.ts). */
export async function enterUrl(o: Window & { session?: string }, fetchFn: typeof fetch = fetch): Promise<EnterResult> {
  const r = await proved(o, fetchFn);
  if ('error' in r) return r;
  return { url: `http://127.0.0.1:${o.port}/#t=${loginCredential(r.token, o.port, r.nonce)}${o.session ? `&s=${o.session}` : ''}` };
}

export type SessionRow = { id: string; title: string; at: number; archived?: true };
export type SessionsResult = { current: string | null; sessions: SessionRow[] } | { error: 'no such window' | 'window not answering' };

/** That window's sessions (its GET /sessions) in its folder: one in a subfolder is that folder's (its switch would move the window). */
export async function sessionsOf(o: Window, fetchFn: typeof fetch = fetch): Promise<SessionsResult> {
  const r = await proved(o, fetchFn);
  if ('error' in r) return r;
  try {
    const res = await fetchFn(`http://127.0.0.1:${o.port}/sessions`, { headers: { authorization: r.bearer }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    const v = res.ok ? ((await res.json()) as { current?: unknown; sessions?: unknown } | null) : null;
    if (!v || !Array.isArray(v.sessions)) return { error: 'window not answering' };
    const sessions = (v.sessions as { id: string; title: string; at: number; cwd: string; archived?: true }[])
      .filter((x) => typeof x?.id === 'string' && x.cwd === r.root)
      .map((x) => ({ id: x.id, title: typeof x.title === 'string' ? x.title : '', at: typeof x.at === 'number' ? x.at : 0, ...(x.archived ? { archived: true as const } : {}) }));
    return { current: typeof v.current === 'string' ? v.current : null, sessions };
  } catch {
    return { error: 'window not answering' };
  }
}

export type StopResult = { ok: true } | { error: 'no such window' | 'window not answering' | 'refused' };

/**
 * Stops that window (its POST /control/stop, with its provider's control token): its agent and launcher stop, the session
 * stays. The window is proved first, so the token goes only to a listener that holds that provider's access token.
 */
export async function stopAt(o: Window, fetchFn: typeof fetch = fetch): Promise<StopResult> {
  const r = await proved(o, fetchFn);
  if ('error' in r) return r;
  const control = readSecret(path.join(providerStateDir(stateBaseDir(), o.provider), 'control-token'));
  if (!control) return { error: 'refused' };
  try {
    // redirect: 'error': a 307/308 would carry the token on to wherever it points
    const res = await fetchFn(`http://127.0.0.1:${o.port}/control/stop`, { method: 'POST', headers: { [CONTROL_HEADER]: control }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    return res.ok ? { ok: true } : { error: 'refused' };
  } catch {
    return { error: 'window not answering' };
  }
}

/** Header ⏻, before this window stops itself: every other live window of every provider; how many stopped and failed. */
export async function stopOthers(own: { port: number; provider: AgentProvider }, fetchFn: typeof fetch = fetch): Promise<{ stopped: number; failed: number }> {
  const targets: Window[] = [];
  for (const provider of PROVIDERS) {
    let p: ReturnType<typeof providerOf>;
    try {
      p = providerOf(provider);
    } catch (e) {
      if (e instanceof SecretError) continue;
      throw e;
    }
    for (const [key, w] of p?.entries ?? []) {
      const port = Number(key);
      if ((port === own.port && provider === own.provider) || !pidAlive(w.pid)) continue;
      targets.push({ provider, port, root: w.root });
    }
  }
  const results = await Promise.all(targets.map((w) => stopAt(w, fetchFn)));
  const stopped = results.filter((r) => 'ok' in r).length;
  return { stopped, failed: results.length - stopped };
}
