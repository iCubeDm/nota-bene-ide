// The project switcher's server side (phase 1, over today's one-process windows): every provider's windows with their
// agent's state, the recent folders, and the login a tab needs to move to one of them.
//
// Each provider has its own registry and token (state dir per provider), so a window is proved with its own provider's token
// before anything is sent to it, as the remote connector does (remote/discover.ts). The login is the launcher's (`loginTarget`
// in bin/nota-bene.mjs): derived from that token, that port and the nonce the listener proved. It goes only into the JSON
// answer to the page, which navigates to it; never into a log, an error or a URL query.
import type { HostWindow, LastMessage } from '@nota-bene/shared';
import { providerStateDir, type AgentProvider } from './agent/provider.ts';
import path from 'node:path';
import { helperCredential, loginCredential, proveListener, readSecret, SecretError } from './auth.ts';
import { readHidden, readRecent, type RecentEntry } from './recent.ts';
import { CONTROL_HEADER } from './system.ts';
import { providerToken } from './remote/discover.ts';
import { AGENT_ID, stateBaseDir } from './state.ts';
import { pidAlive, readKeptAgents, readWindows, type WindowEntry } from './windows.ts';
import { wirePath } from './wirePath.ts';
import type { OpenAsk } from './session/permissions.ts';

export const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'omp'];
const PROBE_MS = 700;

export type ProjectState = 'working' | 'waiting' | 'idle' | 'restarting' | 'silent';
export type RunningRow = {
  provider: AgentProvider; port: number; root: string; title: string | null; session: string | null;
  state: ProjectState; current: boolean; clients: number;
  /** final replies of its session after the person last saw it (seen.ts) */
  unseen: number;
  last: LastMessage | null;
  /** issue 297: a window of a paired computer (its host id and name), reached through this computer's connector */
  remote?: { host: string; name: string };
  /** epic 383: an agent the server on `port` opened beside its window's, at `/a/<agent>/` */
  agent?: string;
  /** epic 383 2g: its agent id (the window's own too) */
  id?: string;
  /** issue 651: its open asks (clipped), for an agent of the asking page's server only: the page answers it there */
  asks?: OpenAsk[];
};
export type ProjectsList = { running: RunningRow[]; recent: (RecentEntry & { running: boolean })[]; /** folders removed from Recent (recent.ts): the page drops them from its session history too */ hidden: string[] };
export type ProbedInfo = {
  root: string; session?: string | null; title?: string | null; busy?: boolean; pending?: boolean; clients?: number;
  unseen?: number; last?: LastMessage | null; /** epic 383: its agent id */ agent?: string; asks?: OpenAsk[];
  /** epic 383: the other agents of that server, each its own /a/<id>/info (probeWith) */
  extra?: (ProbedInfo & { agent: string; provider: AgentProvider })[];
};
export type Probe = (port: number, token: string) => Promise<ProbedInfo | null>;

/** An agent's /info at `base` ('' the window's, `/a/<id>` another's) with `bearer`; null for anything else. */
async function infoAt(port: number, base: string, bearer: string, fetchFn: typeof fetch = fetch, ms = PROBE_MS): Promise<(ProbedInfo & { agent?: unknown; agents?: unknown }) | null> {
  try {
    const r = await fetchFn(`http://127.0.0.1:${port}${base}/info`, { headers: { authorization: bearer }, signal: AbortSignal.timeout(ms), redirect: 'error' });
    const j = r.ok ? ((await r.json()) as (ProbedInfo & { agent?: unknown; agents?: unknown }) | null) : null;
    return j && typeof j.root === 'string' ? j : null;
  } catch {
    return null;
  }
}

const isAgent = (a: unknown): a is { id: string; provider: AgentProvider } =>
  !!a && typeof (a as { id?: unknown }).id === 'string' && AGENT_ID.test((a as { id: string }).id) && PROVIDERS.includes((a as { provider: AgentProvider }).provider);

/** The listener on `port` proved with `token`, then its /info and its other agents' with that launch's helper bearer; null for anything else. */
export const probeWith: Probe = async (port, token) => {
  const n = await proveListener({ dial: port, timeoutMs: PROBE_MS, token });
  if (n === null) return null;
  const bearer = `Bearer ${helperCredential(token, port, n)}`;
  const j = await infoAt(port, '', bearer);
  if (!j) return null;
  const others = (Array.isArray(j.agents) ? j.agents : []).filter(isAgent).filter((a) => a.id !== j.agent);
  const extra = (await Promise.all(others.map(async (a) => {
    const i = await infoAt(port, `/a/${a.id}`, bearer);
    return i ? [{ ...i, agent: a.id, provider: a.provider }] : [];
  }))).flat();
  return { ...j, extra };
};

const folder = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;
const sameRoot = (stored: string, given: string) => stored === given || wirePath(stored) === given;

/** A provider's registry and token; null when it has no token (it has no windows). Throws SecretError for a bad token file. */
function providerOf(provider: AgentProvider): { token: string; entries: [string, WindowEntry][] } | null {
  const dir = providerStateDir(stateBaseDir(), provider);
  const token = providerToken(dir);
  return token ? { token, entries: Object.entries(readWindows(dir)) } : null;
}

/** The page asking (projectRoutes): its server's port, its provider and, for an agent beside the window's, its id. */
export type Own = { port: number; provider: AgentProvider; agent?: string };

export async function listProjects(own: Own, probe: Probe = probeWith, warn: (m: string) => void = () => {}): Promise<ProjectsList> {
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
      const stateOf = (i: ProbedInfo): ProjectState => (i.pending ? 'waiting' : i.busy ? 'working' : 'idle');
      const row = (p: AgentProvider, root: string, i: ProbedInfo | null, state: ProjectState, agent?: string): RunningRow => ({
        provider: p, port, root: wirePath(root), title: i?.title ?? null, session: i?.session ?? null, state,
        current: port === own.port && (agent ? agent === own.agent : provider === own.provider && !own.agent), clients: i?.clients ?? 0,
        unseen: typeof i?.unseen === 'number' ? i.unseen : 0, last: i?.last ?? null, ...(agent ? { agent } : {}),
        ...(typeof i?.agent === 'string' ? { id: i.agent } : agent ? { id: agent } : {}),
        ...(port === own.port && Array.isArray(i?.asks) && i.asks.length ? { asks: i.asks } : {}),
      });
      // its agents, each its own row (issue 639: the top is the server's home): as they answer, or while it restarts the
      // ones it keeps (they come back with it). The server's own row only for a server that is not answering, or an older
      // one whose top is its first agent
      const kept = alive ? null : readKeptAgents(port, providerStateDir(stateBaseDir(), provider));
      // only its launcher's: the file outlives a Stop, and a later launch on this port does not reopen them
      const back = kept && kept.launcherPid === w.launcherPid ? kept.agents : [];
      if (live ? typeof live.agent === 'string' : !back.length) rows.push(row(provider, w.root, live, !alive ? 'restarting' : !live ? 'silent' : stateOf(live)));
      if (live) for (const x of live.extra ?? []) rows.push(row(x.provider, x.root, x, stateOf(x), x.agent));
      for (const x of back) rows.push(row(x.provider, x.root, null, 'restarting', x.id));
    }));
  }));
  rows.sort((a, b) => folder(a.root).localeCompare(folder(b.root)) || a.root.localeCompare(b.root) || PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider));
  const up = new Set(rows.filter((r) => r.state !== 'restarting').map((r) => `${r.provider} ${r.root}`));
  const recent = readRecent(stateBaseDir()).map((e) => ({ ...e, root: wirePath(e.root), running: up.has(`${e.provider} ${wirePath(e.root)}`) }));
  return { running: rows, recent, hidden: readHidden(stateBaseDir()) };
}

/** A paired computer's windows as its host stream lists them (remote/hostLink.ts), for the switcher. */
export type Computer = { id: string; name: string; windows: HostWindow[] };

/**
 * The windows of the paired computers as rows (issue 297), the state from what the host stream says (`pending`, `busy`);
 * `current`: the one a desktop proxy's page shows. An unknown agent's window is left out (the page names the agents).
 */
export function remoteRows(computers: Computer[], current?: { host: string; port: number; agent?: string }): RunningRow[] {
  return computers.flatMap((c) => c.windows.flatMap((w): RunningRow[] => {
    // a newer computer's agent this one does not know
    if (!PROVIDERS.includes(w.provider)) return [];
    const last = w.last && typeof w.last === 'object' ? w.last : null;
    return [{
      provider: w.provider, port: w.port, root: w.root, title: typeof w.title === 'string' ? w.title : null,
      session: typeof w.session === 'string' ? w.session : null, state: w.pending ? 'waiting' : w.busy ? 'working' : 'idle',
      current: current?.host === c.id && current.port === w.port && current.agent === w.agent, clients: 0, unseen: 0, last,
      remote: { host: c.id, name: c.name }, ...(w.agent ? { agent: w.agent } : {}),
    }];
  }));
}

/**
 * A row as another computer's page gets it (issue 297, the desktop proxy): what the switcher lists and moves with (folder,
 * agent, port, state, computer), none of the window's content (title, session, last message, counts).
 */
export const bareRow = (r: RunningRow): RunningRow => ({ ...r, title: null, session: null, clients: 0, unseen: 0, last: null });

export type EnterResult = { url: string } | { error: 'no such window' | 'window not answering' };
/** A window, or with `agent` (epic 383) an agent the server on `port` opened: `provider` is then that agent's */
type Window = { provider: AgentProvider; port: number; root: string; agent?: string };
type Proved = { provider: AgentProvider; token: string; nonce: string; bearer: string; root: string; base: string } | { error: 'no such window' | 'window not answering' };

/** The registry entry on `port` and its token: of `provider`, or for an agent of whichever provider's server holds the port. */
function entryOf(o: Window): { provider: AgentProvider; token: string; w: WindowEntry } | null {
  for (const provider of o.agent ? PROVIDERS : [o.provider]) {
    let p: ReturnType<typeof providerOf>;
    try {
      p = providerOf(provider);
    } catch (e) {
      if (e instanceof SecretError && o.agent) continue;
      throw e;
    }
    const w = p?.entries.find(([k]) => Number(k) === o.port)?.[1];
    if (p && w && pidAlive(w.pid)) return { provider, token: p.token, w };
  }
  return null;
}

/**
 * A registered window of `provider` on `port` that still holds `root`, or that server's agent `agent` on `root`: proved
 * with its provider's token, the /info there checked.
 */
async function proved(o: Window, fetchFn: typeof fetch): Promise<Proved> {
  const e = entryOf(o);
  if (!e || (!o.agent && !sameRoot(e.w.root, o.root)) || (o.agent && !AGENT_ID.test(o.agent))) return { error: 'no such window' };
  const n = await proveListener({ dial: o.port, timeoutMs: 1500, token: e.token, fetchFn });
  if (n === null) return { error: 'window not answering' };
  const bearer = `Bearer ${helperCredential(e.token, o.port, n)}`;
  const base = o.agent ? `/a/${o.agent}` : '';
  const j = await infoAt(o.port, base, bearer, fetchFn, 1500);
  if (!j || (o.agent ? !sameRoot(j.root, o.root) : j.root !== e.w.root)) return { error: 'window not answering' };
  return { provider: e.provider, token: e.token, nonce: n, bearer, root: j.root, base };
}

/** The login URL of that window; with `session`, the page there opens that session once logged in (web landing.ts). */
export async function enterUrl(o: Window & { session?: string }, fetchFn: typeof fetch = fetch): Promise<EnterResult> {
  const r = await proved(o, fetchFn);
  if ('error' in r) return r;
  return { url: `http://127.0.0.1:${o.port}${r.base}/#t=${loginCredential(r.token, o.port, r.nonce)}${o.session ? `&s=${o.session}` : ''}` };
}

export type SessionRow = { id: string; title: string; at: number; archived?: true };
export type SessionsResult = { current: string | null; sessions: SessionRow[] } | { error: 'no such window' | 'window not answering' };

/** That window's sessions (its GET /sessions) in its folder: one in a subfolder is that folder's (its switch would move the window). */
export async function sessionsOf(o: Window, fetchFn: typeof fetch = fetch): Promise<SessionsResult> {
  const r = await proved(o, fetchFn);
  if ('error' in r) return r;
  try {
    const res = await fetchFn(`http://127.0.0.1:${o.port}${r.base}/sessions`, { headers: { authorization: r.bearer }, signal: AbortSignal.timeout(3000), redirect: 'error' });
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
 * stays; an agent beside a window's closes alone (POST /a/<id>/control/close). The listener is proved first, so the token
 * goes only to one that holds that provider's access token.
 */
export async function stopAt(o: Window, fetchFn: typeof fetch = fetch): Promise<StopResult> {
  const r = await proved(o, fetchFn);
  if ('error' in r) return r;
  // the server's provider's: an agent's provider may be another
  const control = readSecret(path.join(providerStateDir(stateBaseDir(), r.provider), 'control-token'));
  if (!control) return { error: 'refused' };
  try {
    // redirect: 'error': a 307/308 would carry the token on to wherever it points
    const res = await fetchFn(`http://127.0.0.1:${o.port}${r.base}/control/${o.agent ? 'close' : 'stop'}`, { method: 'POST', headers: { [CONTROL_HEADER]: control }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    return res.ok ? { ok: true } : { error: 'refused' };
  } catch {
    return { error: 'window not answering' };
  }
}

/** Header ⏻, before this window stops itself: every other live window of every provider; how many stopped and failed. */
export async function stopOthers(own: Own, fetchFn: typeof fetch = fetch): Promise<{ stopped: number; failed: number }> {
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
      if (port === own.port || !pidAlive(w.pid)) continue; // one listener a port: this page's own server, whichever agent asks
      targets.push({ provider, port, root: w.root });
    }
  }
  const results = await Promise.all(targets.map((w) => stopAt(w, fetchFn)));
  const stopped = results.filter((r) => 'ok' in r).length;
  return { stopped, failed: results.length - stopped };
}
