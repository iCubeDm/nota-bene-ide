// The project switcher's server side: the servers' agents with their state, the recent folders, and the login a tab needs
// to move to one of them.
//
// A server is proved with the token (servers.ts) before anything is sent to it, as the remote connector does
// (remote/discover.ts). The login is the launcher's (`loginTarget` in bin/nota-bene.mjs): derived from the token, that port
// and the nonce the listener proved. It goes only into the JSON
// answer to the page, which navigates to it; never into a log, an error or a URL query.
import type { HostWindow, LastMessage } from '@nota-bene/shared';
import { PROVIDERS, type AgentProvider } from './agent/provider.ts';
import path from 'node:path';
import { helperCredential, loginCredential, proveListener, readSecret } from './auth.ts';
import { readHidden, readRecent, type RecentEntry } from './recent.ts';
import { CONTROL_HEADER } from './system.ts';
import { infoAt, registry, SERVER_PROVIDER, serverAgents } from './servers.ts';
import { AGENT_ID, agentPath, serverStateDir, stateBaseDir } from './state.ts';
import { pidAlive, readKeptAgents, type WindowEntry } from './windows.ts';
import { wirePath } from './wirePath.ts';
import type { OpenAsk } from './session/permissions.ts';

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

const rooted = (i: Record<string, unknown> | null): i is ProbedInfo & Record<string, unknown> => typeof i?.root === 'string';

/** The listener on `port` proved with `token`, then its /info and its other agents' with that launch's helper bearer; null for anything else. */
export const probeWith: Probe = async (port, token) => {
  const n = await proveListener({ dial: port, timeoutMs: PROBE_MS, token });
  if (n === null) return null;
  const bearer = `Bearer ${helperCredential(token, port, n)}`;
  const { top, agents } = await serverAgents(port, bearer);
  if (!rooted(top)) return null;
  return { ...top, extra: agents.flatMap(({ id, provider, info }) => (id !== top.agent && rooted(info) ? [{ ...info, agent: id, provider }] : [])) };
};

const folder = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;
const sameRoot = (stored: string, given: string) => stored === given || wirePath(stored) === given;

/**
 * The asking page's own server (issue 691): it holds its agents, so nothing about them is asked over HTTP. Absent in the
 * connector, which is no server.
 */
export type Self = {
  /** what its /info answers, its agents' under `extra` */
  info(): ProbedInfo;
  /** its agent `id`, or null */
  agent(id: string): SelfAgent | null;
  /** the agent of that folder and provider, opened unless it is open (`fresh`: a new session in a new one); throws what the page is told */
  open(dir: string, provider: AgentProvider, fresh: boolean): Promise<SelfAgent>;
};
export type SelfAgent = {
  root: string;
  /** its page with the login; with `session`, that session opens there (web landing.ts) */
  url(session?: string): string;
  /** its GET /sessions */
  sessions(): Promise<{ current: string | null; sessions: unknown[] }>;
  close(): void;
};

/** The page asking (projectRoutes): its server's port and, for an agent's page, its id. */
export type Own = { port: number; agent?: string; self?: Self };

export async function listProjects(own: Own, probe: Probe = probeWith, warn: (m: string) => void = () => {}): Promise<ProjectsList> {
  const rows: RunningRow[] = [];
  const { token = '', entries = [] } = registry((e) => warn(e.message)) ?? {};
  await Promise.all(entries.map(async ([port, w]) => {
    const alive = pidAlive(w.pid);
    if (!alive && !(w.launcherPid !== undefined && pidAlive(w.launcherPid))) return; // stale: gone
    const info = !alive ? null : port === own.port && own.self ? own.self.info() : await probe(port, token);
    const live = info && info.root === w.root ? info : null;
    const stateOf = (i: ProbedInfo): ProjectState => (i.pending ? 'waiting' : i.busy ? 'working' : 'idle');
    const row = (p: AgentProvider, root: string, i: ProbedInfo | null, state: ProjectState, agent?: string): RunningRow => ({
      provider: p, port, root: wirePath(root), title: i?.title ?? null, session: i?.session ?? null, state,
      current: port === own.port && agent === own.agent, clients: i?.clients ?? 0,
      unseen: typeof i?.unseen === 'number' ? i.unseen : 0, last: i?.last ?? null, ...(agent ? { agent } : {}),
      ...(port === own.port && Array.isArray(i?.asks) && i.asks.length ? { asks: i.asks } : {}),
    });
    // its agents, each its own row (issue 639: the top is the server's home): as they answer, or while it restarts the
    // ones it keeps (they come back with it). The server's own row only for a server that is not answering, or an older
    // one whose top is its first agent
    const kept = alive ? null : readKeptAgents(port);
    // only its launcher's: the file outlives a Stop, and a later launch on this port does not reopen them
    const back = kept && kept.launcherPid === w.launcherPid ? kept.agents : [];
    if (live ? typeof live.agent === 'string' : !back.length) rows.push(row(SERVER_PROVIDER, w.root, live, !alive ? 'restarting' : !live ? 'silent' : stateOf(live)));
    if (live) for (const x of live.extra ?? []) rows.push(row(x.provider, x.root, x, stateOf(x), x.agent));
    for (const x of back) rows.push(row(x.provider, x.root, null, 'restarting', x.id));
  }));
  rows.sort((a, b) => folder(a.root).localeCompare(folder(b.root)) || a.root.localeCompare(b.root) || PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider));
  const up = new Set(rows.filter((r) => r.state !== 'restarting').map((r) => `${r.provider} ${r.root}`));
  const recent = readRecent(stateBaseDir()).map((e) => ({ ...e, root: wirePath(e.root), running: up.has(`${e.provider} ${wirePath(e.root)}`) }));
  return { running: rows, recent, hidden: readHidden(stateBaseDir()) };
}

/** A paired computer's windows as its host stream lists them (remote/hostLink.ts), for the switcher. */
export type Computer = { id: string; name: string; windows: HostWindow[] };

/**
 * The windows of the paired computers as rows (issue 297), the state from what the host stream says (`pending`, `busy`,
 * `unseen`: 0 from a host before protocol 41);
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
      current: current?.host === c.id && current.port === w.port && current.agent === w.agent, clients: 0,
      unseen: typeof w.unseen === 'number' ? w.unseen : 0, last,
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

/** `o` as an agent of the asking server itself: null when it has no such agent on that folder; undefined: another server's. */
function mine(o: Window, own: Own | undefined): SelfAgent | null | undefined {
  if (!own?.self || o.port !== own.port) return undefined;
  const a = o.agent ? own.self.agent(o.agent) : null;
  return a && sameRoot(a.root, o.root) ? a : null;
}
type Proved = { token: string; nonce: string; bearer: string; root: string; base: string } | { error: 'no such window' | 'window not answering' };

/** The live registry entry on `o.port`, with the token. An unusable token file throws: the asker hears of it. */
function entryOf(o: Window): { token: string; w: WindowEntry } | null {
  const r = registry();
  const w = r?.entries.find(([port]) => port === o.port)?.[1];
  return r && w && pidAlive(w.pid) ? { token: r.token, w } : null;
}

/**
 * A registered server on `port` that still holds `root`, or its agent `agent` on `root`: proved with the token, the /info
 * there checked.
 */
async function proved(o: Window, fetchFn: typeof fetch): Promise<Proved> {
  const e = entryOf(o);
  if (!e || (!o.agent && !sameRoot(e.w.root, o.root)) || (o.agent && !AGENT_ID.test(o.agent))) return { error: 'no such window' };
  const n = await proveListener({ dial: o.port, timeoutMs: 1500, token: e.token, fetchFn });
  if (n === null) return { error: 'window not answering' };
  const bearer = `Bearer ${helperCredential(e.token, o.port, n)}`;
  const base = o.agent ? agentPath(o.agent) : '';
  const j = await infoAt(o.port, base, bearer, fetchFn, 1500);
  if (!rooted(j) || (o.agent ? !sameRoot(j.root, o.root) : j.root !== e.w.root)) return { error: 'window not answering' };
  return { token: e.token, nonce: n, bearer, root: j.root, base };
}

/** The login URL of that window; with `session`, the page there opens that session once logged in (web landing.ts). */
export async function enterUrl(o: Window & { session?: string }, fetchFn: typeof fetch = fetch, own?: Own): Promise<EnterResult> {
  const a = mine(o, own);
  if (a !== undefined) return a ? { url: a.url(o.session) } : { error: 'no such window' };
  const r = await proved(o, fetchFn);
  if ('error' in r) return r;
  return { url: `http://127.0.0.1:${o.port}${r.base}/#t=${loginCredential(r.token, o.port, r.nonce)}${o.session ? `&s=${o.session}` : ''}` };
}

export type SessionRow = { id: string; title: string; at: number; archived?: true };
export type SessionsResult = { current: string | null; sessions: SessionRow[] } | { error: 'no such window' | 'window not answering' };

/** That window's sessions (its GET /sessions) in its folder: one in a subfolder is that folder's (its switch would move the window). */
export async function sessionsOf(o: Window, fetchFn: typeof fetch = fetch, own?: Own): Promise<SessionsResult> {
  const rows = (v: { current?: unknown; sessions?: unknown } | null, root: string): SessionsResult => {
    if (!v || !Array.isArray(v.sessions)) return { error: 'window not answering' };
    const sessions = (v.sessions as { id: string; title: string; at: number; cwd: string; archived?: true }[])
      .filter((x) => typeof x?.id === 'string' && x.cwd === root)
      .map((x) => ({ id: x.id, title: typeof x.title === 'string' ? x.title : '', at: typeof x.at === 'number' ? x.at : 0, ...(x.archived ? { archived: true as const } : {}) }));
    return { current: typeof v.current === 'string' ? v.current : null, sessions };
  };
  const a = mine(o, own);
  if (a !== undefined) return a ? rows(await a.sessions(), a.root) : { error: 'no such window' };
  const r = await proved(o, fetchFn);
  if ('error' in r) return r;
  try {
    const res = await fetchFn(`http://127.0.0.1:${o.port}${r.base}/sessions`, { headers: { authorization: r.bearer }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    return rows(res.ok ? ((await res.json()) as { current?: unknown; sessions?: unknown } | null) : null, r.root);
  } catch {
    return { error: 'window not answering' };
  }
}

export type StopResult = { ok: true } | { error: 'no such window' | 'window not answering' | 'refused' };

/**
 * Stops that window (its POST /control/stop, with the control token): its agent and launcher stop, the session
 * stays; an agent beside a window's closes alone (POST /a/<id>/control/close). The listener is proved first, so the token
 * goes only to one that holds the access token.
 */
export async function stopAt(o: Window, fetchFn: typeof fetch = fetch, own?: Own): Promise<StopResult> {
  const a = mine(o, own);
  if (a !== undefined) {
    a?.close();
    return a ? { ok: true } : { error: 'no such window' };
  }
  const r = await proved(o, fetchFn);
  if ('error' in r) return r;
  const control = readSecret(path.join(serverStateDir(), 'control-token'));
  if (!control) return { error: 'refused' };
  try {
    // redirect: 'error': a 307/308 would carry the token on to wherever it points
    const res = await fetchFn(`http://127.0.0.1:${o.port}${r.base}/control/${o.agent ? 'close' : 'stop'}`, { method: 'POST', headers: { [CONTROL_HEADER]: control }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    return res.ok ? { ok: true } : { error: 'refused' };
  } catch {
    return { error: 'window not answering' };
  }
}

/** Header ⏻, before this server stops itself: every other live server; how many stopped and failed. */
export async function stopOthers(own: Own, fetchFn: typeof fetch = fetch): Promise<{ stopped: number; failed: number }> {
  const targets: Window[] = [];
  for (const [port, w] of registry(() => {})?.entries ?? []) {
    if (port === own.port || !pidAlive(w.pid)) continue; // one listener a port: this page's own server, whichever agent asks
    targets.push({ provider: SERVER_PROVIDER, port, root: w.root });
  }
  const results = await Promise.all(targets.map((w) => stopAt(w, fetchFn)));
  const stopped = results.filter((r) => 'ok' in r).length;
  return { stopped, failed: results.length - stopped };
}
