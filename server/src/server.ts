import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { isSessionId } from '@nota-bene/shared';
import type { RemoteState, Stats } from '@nota-bene/shared';
import type { ProviderBackend as AgentBackend } from './agent/types.ts';
import { parseProvider, type AgentProvider } from './agent/provider.ts';
import { hubs, startAgent, type Agent, type Shared } from './agent.ts';
import { reportError } from './errors.ts';
import { ProjectIconStore } from './projectIcon.ts';
import { EventHub, type EmitInput } from './hub.ts';
import { agentPrefix, httpHandler, isAllowedHost, pathOf } from './http.ts';
import type { IdleConfig } from './idle.ts';
import { launchTarget } from './sessions.ts';
import { codeChecker } from './codeStamp.ts';
import { AGENT_ID, agentContext, agentPath, envAgentContext, newAgentId, stateBaseDir, type AgentContext } from './state.ts';
import { AuditLog } from './audit.ts';
import { moveWindow, readKeptAgents, writeKeptAgents } from './windows.ts';
import { pidAlive, samePath } from './platform.ts';
import type { SelfAgent } from './projects.ts';
import { controlRoute, controlToken, describeVersion } from './system.ts';
import { RESTART, restartGate } from './restartGate.ts';
import { projectRoutes } from './projectRoutes.ts';
import { updateCheck } from './update.ts';
import { updater } from './updater.ts';
import { runtimeDir } from './runtime.ts';
import { hostClient } from './dictation/hostClient.ts';
import type { PairOutcome, RemoteKeeper } from './remote/keeper.ts';
import { attachAgent } from './attach.ts';
import { startFold } from './fold.ts';
import { CHALLENGE_RE, accessToken, authenticated, isNonce, loginCredential, loginRoute, newNonce, proofFor } from './auth.ts';

// Process-wide handlers are registered once.
let handlersInstalled = false;

function installProcessHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const report = (e: unknown) => {
    if (hubs.size === 0) console.error('[server]', e);
    for (const h of hubs) reportError(h, 'server', e);
  };
  process.on('uncaughtException', report);
  process.on('unhandledRejection', report);
}

export type ServerOptions = {
  cwd: string;
  port: number;
  resume?: string;
  fork?: boolean;
  /** a start with no agent: the server's home page, where a project is opened (`nota-bene` with no folder); `cwd` is then no project */
  home?: boolean;
  /** the launch agent's id (main.ts --id: the e2e fixtures' page address is fixed); default: a minted one */
  id?: string;
  /** called by POST /restart-server and /control/stop (tests stub it) */
  exit?: (code: number) => void;
  /** the checkout the server runs from (Settings → About's version); default: two levels above this file */
  repoDir?: string;
  webDist: string;
  /** the ffmpeg binary of the video editor's export, looked up at each use (tests stub it); default: findFfmpeg */
  ffmpeg?: () => string | null;
  allowedOrigins?: string[];
  /** idle compaction timing and the settings.json check (tests shorten / stub them) */
  idle?: IdleConfig;
  idleOffInSettings?: () => boolean;
  /** what records an agent's stats updates and limit hits, by its provider (issue 675: every agent, not the first alone);
   *  main.ts gives Claude's, tests leave the real store alone */
  usage?: (provider: AgentProvider) => { onStats?: (s: Stats) => void; onLimit?: (info: unknown) => void };
  /** the `! cmd` runner's timing and environment (tests shorten the timeout and the kill delay) */
  shell?: { timeoutMs?: number; killMs?: number; env?: () => NodeJS.ProcessEnv };
  /**
   * TEST ONLY: serve without the access token. The default, and the only thing main.ts and the launcher ever do, is auth
   * on (see auth.ts). There is deliberately no CLI flag or env var for this.
   */
  insecureNoAuth?: boolean;
  /** this launch's nonce (public; auth.ts): the launcher makes it so a relaunch keeps it. Default: a fresh one */
  nonce?: string;
  /** issue 457: the /nb plugin version whose launcher opened this window (main.ts takePluginVersion) */
  pluginVersion?: string;
  /** the audit log of system events (audit.ts); absent = none (tests). `dir` / `enabled`: tests */
  audit?: { dir?: string; enabled?: () => boolean };
  /** one tab at a time (R-M7-5); default true. Tests that need several live sockets pass false */
  oneTab?: boolean;
  /** tests shorten the reload grace (R-M7-6) and the heartbeat (R-M7-7) */
  takeoverGraceMs?: number;
  heartbeatMs?: number;
  /** tests shorten how often a pending restart looks for a pause with no page open (restartGate, gh-422) */
  restartEveryMs?: number;
  /** keeps the remote-access connector running and serves /remote (main.ts); absent = none (tests), /remote answers 503 */
  remote?: RemoteKeeper;
  /** which agent this is and where its data lives (main.ts); default: the one NOTA_BENE_AGENT chose */
  agent?: AgentContext;
  /** a backend for an agent of `provider` (main.ts; tests pass fakes) */
  backends: (provider: AgentProvider) => AgentBackend;
  /**
   * The launcher's server (main.ts): its agents are kept beside its registry entry (`<port>.agents.json`), and a
   * relaunch of the same launch (this launcher pid: a crash; this nonce: a restart or an update) reopens them under their ids
   */
  keep?: { launcherPid?: number };
  /** epic 383 (main.ts, a launcher's window on a port it picked): alone, idle and with no tab, it hands its folder to a server below and ends (fold.ts) */
  fold?: { everyMs: number };
};

/**
 * The server: one listener, login and process for its agents (epic 383), each under `/a/<id>/`. It starts with the agent
 * of `o.cwd`, or (`o.home`) with none; `open` adds another.
 */
export async function startServer(o: ServerOptions): Promise<{ url: string; close(): Promise<void>; open(x: { provider: AgentProvider; cwd: string; backend: AgentBackend; resume?: string; fork?: boolean }): Promise<string> }> {
  installProcessHandlers();
  const agents = new Map<string, Agent>();
  const sum = (f: (a: Agent) => number) => [...agents.values()].reduce((n, a) => n + f(a), 0);
  const report = (where: string, e: unknown) => {
    if (agents.size === 0) console.error(`[${where}]`, e); // before the first agent is up
    for (const a of agents.values()) reportError(a.hub, where, e);
  };
  hostClient.reportTo(report); // the Whisper host's trouble is every agent's to show
  const audit = o.audit ? new AuditLog({ port: o.port, ...o.audit }) : null;
  audit?.prune();
  try {
    // the secrets first: a refused one (loose mode, foreign owner, ...) must stop the start before the agent is spawned
    // the access token: read once at start (a rotated file takes effect at the next start). Auth is on unless a test says no
    const token = o.insecureNoAuth ? null : accessToken();
    // made at start, never by a request: an unauthenticated /control/* must not be able to create the file
    const control = controlToken();
    // the agent's folder is made and checked here too, so a refused one stops the start as the secrets do
    const agent = o.agent ?? envAgentContext();
    // a picture per project folder, shared by every agent on it: the state folder, never the project
    const projectIcons = new ProjectIconStore({ dir: path.join(stateBaseDir(), 'project-icons') });
    // supervised = our launcher is still our parent: an orphan (launcher killed) must not offer a restart nobody catches.
    // Windows never reparents, so the parent must also still be there: its IPC channel open (main.ts watchLauncher), or
    // without one (an older launcher) its pid alive
    const supervised = () => process.env.NOTA_BENE_SUPERVISED === '1'
      && process.ppid === Number(process.env.NOTA_BENE_LAUNCHER_PID)
      && (process.channel ? process.connected : pidAlive(process.ppid));
    const codeChanged = codeChecker({ repoDir: o.repoDir ?? path.resolve(import.meta.dirname, '..', '..') });
    const nonce = o.nonce !== undefined && isNonce(o.nonce) ? o.nonce : newNonce();
    const authorize = token === null ? undefined : (req: http.IncomingMessage, needKey: boolean) => authenticated(req.headers, token, ownPort, nonce, needKey);
    const allowedHosts: string[] = []; // filled after listen, once the port is known
    const allowedOrigins: string[] = [...(o.allowedOrigins ?? [])];
    let ownPort = 0; // set after listen
    let close: (() => Promise<void>) | undefined; // set once the server listens; an exit before that only waits out its timer
    // the exit after a reply (restart-server 75, stop 0): close what can be closed, but never hang on it
    let exiting = false;
    const exitWith = (code: number) => {
      if (exiting) return; // the first exit wins
      exiting = true;
      for (const a of agents.values()) a.freeze(); // a turn this exit cuts stays marked: the close below ends it
      audit?.write('server-exit', { code });
      void Promise.race([close?.() ?? Promise.resolve(), new Promise<void>((r) => setTimeout(r, 2000))]).then(() => {
        setTimeout(() => (o.exit ?? process.exit)(code), 100);
      });
    };
    // the in-app update: this window's notice, install and hand-over to a newer version (exit 77 in a pause)
    const repoDir = o.repoDir ?? path.resolve(import.meta.dirname, '..', '..');
    const newer = updateCheck();
    const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
    const realpathOr = (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } };
    // not a pause: any agent's turn, question, switch, `! cmd` run or task. The update's hand-over (77) and a pending
    // restart (75) wait for the same pause
    const notPaused = () => [...agents.values()].some((a) => a.notPaused());
    const win = updater({
      version: () => describeVersion(repoDir),
      canUpdate: process.env.NOTA_BENE_HANDOVER === '1',
      busy: notPaused,
      tabs: () => sum((a) => a.hub.clients()),
      exit: exitWith,
      newer,
      fromRuntime: real(repoDir).startsWith(real(runtimeDir()) + path.sep),
      updatedFrom: process.env.NOTA_BENE_UPDATED_FROM,
      pluginVersion: o.pluginVersion,
    });
    // gh-422: "Restart the server" while the agent works waits for the next pause (exit 75 then)
    const restart = restartGate({
      busy: notPaused,
      // only a page that will ask in its pause holds the server's own rule back: the phone and an older bundle never ask
      tabs: () => sum((a) => a.askers()),
      exit: exitWith,
      changed: (pending) => { for (const a of agents.values()) a.restartChanged(pending); },
      everyMs: o.restartEveryMs,
    });
    /** a request to restart: at once in a pause (true), else pending (false) */
    const requestRestart = () => restart.request() === 'now';
    const authRoute = loginRoute(token, () => ownPort, nonce);
    // GET /hello?c=<hex>: the one thing a helper may ask before it trusts a port. Answers only the proof that this server holds the
    // token for the port it is bound to and the given challenge: no root, no state, nothing to replay (the port is in the proof)
    const helloRoute: http.RequestListener = (req, res) => {
      const plain = (status: number, body: string) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      };
      if (req.method !== 'GET') return plain(405, 'method not allowed');
      const c = new URL(req.url ?? '/', 'http://x').searchParams.get('c') ?? '';
      if (token === null || !CHALLENGE_RE.test(c)) return plain(400, 'bad request');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ proof: proofFor(token, ownPort, nonce, c), n: nonce }));
    };
    const s: Shared = {
      o, audit, ...(authorize ? { authorize } : {}), allowedHosts, allowedOrigins, open: { '/auth': authRoute, '/hello': helloRoute }, control,
      port: () => ownPort, projectIcons, supervised, codeChanged, repoDir, newer, win, restart, requestRestart, exiting: () => exiting, exitWith,
      controlOpen: async () => ({ status: 503, body: 'starting' }),
      closeAgent: () => 409,
      agents: () => [...agents.values()].map((x) => ({ id: x.id, provider: x.provider, root: x.root() })),
      live: () => [...agents.values()].map((x) => ({ id: x.id, root: x.root(), session: x.session(), working: x.working() })),
      othersBusy: (id) => [...agents.values()].some((x) => x.id !== id && x.notPaused()),
      self: {
        info: () => ({ ...homeInfo(), extra: [...agents.values()].map((x) => ({ ...x.info(), agent: x.id, provider: x.provider })) }),
        agent: (id) => { const x = agents.get(id); return x ? selfAgent(x) : null; },
        open: async (dir, provider, fresh) => {
          const r = await s.controlOpen({ root: dir, provider, mode: fresh ? 'new' : 'resume', show: false });
          const x = r.status === 200 ? agents.get((r.body as { agent: string }).agent) : undefined;
          if (!x) throw new Error(typeof r.body === 'string' ? r.body : 'the agent did not open');
          return selfAgent(x);
        },
      },
    };
    const selfAgent = (x: Agent): SelfAgent => ({
      root: x.root(),
      // the login of this launch, as the launcher's (attach.ts): the page may be asking from another origin
      url: (session) => `http://127.0.0.1:${ownPort}${agentPath(x.id)}/#${[...(token === null ? [] : [`t=${loginCredential(token, ownPort, nonce)}`]), ...(session ? [`s=${session}`] : [])].join('&')}`,
      sessions: x.sessions,
      close: () => void s.closeAgent(x.id),
    });
    const homeInfo = () => ({ root: folder, agents: s.agents(), supervised: supervised(), codeChanged: codeChanged(), busy: notPaused(), restartPending: restart.pending(), clients: sum((a) => a.hub.clients()) });
    // issue 639: the server's project folder, which its home answers with (the registry's root, the launcher's "already
    // open"): the launch's, then wherever the agent it came from switches while no other agent is left on it
    let folder = o.cwd;
    const roots = new Map<string, string>(); // each agent's folder at its last look, for that move
    /** keeps the agents in `<port>.agents.json` (o.keep), for a relaunch of the same launch; set once the port is known */
    let keep = () => {};
    /** an agent the server starts or reopens joins it: its folder, its session and the kept list follow it */
    const adopt = (a: Agent) => {
      agents.set(a.id, a);
      roots.set(a.id, a.root());
      a.onSwitch((same) => {
        const was = roots.get(a.id);
        roots.set(a.id, a.root());
        if (same) return;
        keep();
        if (was !== folder || samePath(a.root(), folder) || [...agents.values()].some((x) => x !== a && samePath(x.root(), folder))) return;
        folder = a.root();
        if (!supervised()) return;
        try {
          moveWindow(ownPort, folder, process.pid, process.ppid); // keeps the release it runs: prune must not remove it
        } catch (e) {
          reportError(a.hub, 'windows', e);
        }
      });
      a.onSessionId(keep); // its own session comes back with it (two agents may share a folder)
    };
    // a relaunch of the same launch reopens the agents it had (below), each resuming its own session; a fresh one starts with
    // the launch's agent, an ordinary one under /a/<id>/ (issue 639)
    const kept = o.keep && o.port ? readKeptAgents(o.port) : null;
    // a launch whose agents were all closed comes back with none (its home, issue 639)
    const same = !!kept && ((o.keep!.launcherPid !== undefined && kept.launcherPid === o.keep!.launcherPid) || kept.nonce === nonce);
    const reopen = same ? kept!.agents : [];
    let closing: Promise<void> | null = null;
    /** an agent (epic 383): its own id, minted unless one is kept, under `/a/<id>/` */
    const openAgent = async (x: { provider: AgentProvider; cwd: string; backend: AgentBackend; resume?: string; fork?: boolean; id?: string }): Promise<string> => {
      if (closing || exiting) throw new Error('the server is stopping');
      if (x.id !== undefined && agents.has(x.id)) throw new Error(`agent ${x.id} is open already`);
      let id = x.id ?? '';
      while (!id || agents.has(id)) id = newAgentId(x.provider);
      const added = await startAgent(s, { agent: agentContext(x.provider), id, cwd: x.cwd, backend: x.backend, ...(x.resume ? { resume: x.resume } : {}), ...(x.fork ? { fork: true } : {}), ...o.usage?.(x.provider) });
      if (closing || exiting) {
        await added.close(); // the close has already gone through the map: this one would outlive it
        throw new Error('the server is stopping');
      }
      adopt(added);
      keep();
      return id;
    };
    const launchAgent = () => openAgent({
      provider: agent.provider, cwd: o.cwd, backend: o.backends(agent.provider),
      ...(o.resume ? { resume: o.resume } : {}), ...(o.fork ? { fork: true } : {}), ...(o.id ? { id: o.id } : {}),
    });
    if (!same && !o.home) await launchAgent();
    // issue 639: what has no agent prefix is the server's own: the app shell, the login, its folder and agents, /control/*
    const homeHub = new EventHub();
    const home = httpHandler({
      hub: homeHub, open: s.open, ...(authorize ? { authorize } : {}), allowedHosts, allowedOrigins, webDist: o.webDist, controlToken: () => control,
      info: homeInfo,
      extra: {
        // the switcher's, the starter's: the home page lists the projects and opens them (issue 639)
        ...projectRoutes({ hub: homeHub, port: () => s.port(), self: s.self, ...(o.remote ? { computers: () => o.remote!.computers() } : {}) }),
        '/control/': controlRoute({
          hub: homeHub,
          control: {
            supervised, exiting: () => exiting,
            restartServer: () => { if (requestRestart()) exitWith(RESTART); },
            restartServerNow: () => exitWith(RESTART),
            cancelRestart: () => void restart.cancel(),
            stop: () => exitWith(0), // the launcher treats 0 as "stop" and unregisters the window
            open: (b) => s.controlOpen(b),
          },
        }),
      },
    });
    /** the request's agent, its prefix taken off `req.url`; null: no prefix (home's), undefined: no such agent */
    const agentOf = (req: http.IncomingMessage): Agent | null | undefined => {
      const p = agentPrefix(req.url ?? '/');
      if (!p) return null;
      const found = agents.get(p.id);
      if (found) req.url = p.rest;
      return found;
    };
    /** the kept agents a relaunch is still reopening (below): a request for one waits, so a tab reloaded meanwhile gets its page */
    const reopening = new Map<string, Promise<void>>();
    const reopened = (req: http.IncomingMessage) => reopening.get(agentPrefix(req.url ?? '/')?.id ?? '');
    const server = http.createServer(function serve(req, res) {
      const found = agentOf(req);
      if (found === null) return home(req, res);
      if (found) return found.handler(req, res);
      const wait = reopened(req);
      if (wait) return void wait.then(() => serve(req, res));
      // the Host check before any answer that depends on the agents there are
      res.writeHead(isAllowedHost(req.headers.host, allowedHosts) ? 404 : 403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('no such agent');
    });
    // the socket is `/ws`, at the top or under an agent's prefix; anything else is no upgrade of ours
    server.on('upgrade', function upgrade(req, socket, head) {
      const found = agentOf(req);
      const wait = found ? undefined : reopened(req);
      if (wait) return void wait.then(() => upgrade(req, socket, head));
      if (!found || pathOf(req.url ?? '/') !== '/ws') {
        const status = !isAllowedHost(req.headers.host, allowedHosts) ? '403 Forbidden' : found ? '400 Bad Request' : '404 Not Found';
        socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
        return;
      }
      found.upgrade(req, socket, head);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (e) {
      for (const a of agents.values()) void a.close(); // not awaited: the launcher waits for this exit (98), not for the backend's close
      throw e; // syscall 'listen': main exits with 98, the launcher's "port taken" code
    }

    // a listening server's own errors (a socket error before any request) are reported, never thrown out of its emit
    server.on('error', (e) => report('server', e));
    const port = (server.address() as AddressInfo).port;
    const only = () => (agents.size === 1 ? [...agents.values()][0] : undefined); // fold: a window alone in its server
    const stopFold = o.fold ? startFold({
      port, everyMs: o.fold.everyMs,
      quiet: () => agents.size === 1 && only()!.hub.clients() === 0 && !only()!.notPaused() && !restart.pending(),
      what: () => { const a = only()!; const id = a.session(); return { root: a.root(), provider: a.provider, ...(id ? { session: id } : {}) }; },
      attach: attachAgent,
      stop: () => { audit?.write('fold'); exitWith(0); }, // as Stop: the launcher unregisters the window
    }) : () => {};
    ownPort = port;
    if (audit) {
      audit.port = port;
      audit.write('server-start', { root: folder, agent: agent.provider, node: process.version, supervised: supervised() });
    }
    // never `localhost`: that host name is the desktop proxies' (remote/proxy.ts), and cookies are scoped by host only
    allowedHosts.push(`127.0.0.1:${port}`);
    allowedOrigins.push(`http://127.0.0.1:${port}`);
    const keeper = o.remote;
    const each = (ev: EmitInput) => { for (const a of agents.values()) a.hub.emit(ev, { store: false }); };
    const remoteState = (state: RemoteState) => each({ kind: 'remote', state });
    const remotePair = (p: PairOutcome) => each({ kind: 'remote-pair', ...p });
    const remoteWarn = (m: string) => report('remote', new Error(m));
    if (keeper) {
      keeper.on('state', remoteState);
      keeper.on('pair', remotePair);
      keeper.on('warn', remoteWarn);
      keeper.start();
    }

    close = () => (closing ??= (async () => {
      audit?.write('server-stop');
      audit?.close();
      win.stop();
      restart.stop();
      stopFold();
      hostClient.close(); // the Whisper host drops this window's jobs
      if (keeper) {
        keeper.stop(); // the connector goes on for the other windows
        keeper.off('state', remoteState);
        keeper.off('pair', remotePair);
        keeper.off('warn', remoteWarn);
      }
      // the port closes at once, as the agents stop: a backend that is slow to close must not leave it answering
      await Promise.all([...[...agents.values()].map((a) => a.close()), new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })]);
    })());
    keep = () => {
      if (!o.keep) return;
      try {
        const all = [...agents.values()].map((a) => {
          const session = a.session();
          return { id: a.id, provider: a.provider, root: a.root(), ...(session ? { session } : {}) };
        });
        writeKeptAgents(port, { ...(o.keep.launcherPid !== undefined ? { launcherPid: o.keep.launcherPid } : {}), nonce, agents: all });
      } catch (e) {
        report('windows', e);
      }
    };
    // POST /control/open {root, provider?, mode?: 'resume' | 'new', session?, fork?, show?}: the agent of that folder and provider,
    // the one open unless a new or a named session is asked for. The launcher's way into a running server; `show: false`
    // (its --no-open) moves no tab
    const openOne = async (body: unknown): Promise<{ status: number; body: unknown }> => {
      const b = (body ?? {}) as { root?: unknown; provider?: unknown; mode?: unknown; session?: unknown; fork?: unknown; show?: unknown };
      const shown = b.show === false ? () => ({}) : showIn;
      let provider: AgentProvider;
      try { provider = parseProvider(b.provider === undefined ? undefined : String(b.provider)); } catch { return { status: 400, body: 'bad provider' }; }
      if (typeof b.root !== 'string' || !path.isAbsolute(b.root)) return { status: 400, body: 'root must be an absolute path' };
      let root: string;
      try { root = fs.realpathSync.native(b.root); } catch { return { status: 400, body: 'no such folder' }; }
      if (!fs.statSync(root).isDirectory()) return { status: 400, body: 'not a folder' };
      if (b.mode !== undefined && b.mode !== 'resume' && b.mode !== 'new') return { status: 400, body: 'bad mode' };
      if (b.session !== undefined && !isSessionId(b.session)) return { status: 400, body: 'bad session' };
      // the folder's agent, or (a named session) the one that has that session: a retry opens no second one (fold.ts)
      if (b.mode !== 'new') {
        const have = [...agents.values()].find((a) => a.provider === provider && samePath(realpathOr(a.root()), root)
          && (b.session === undefined || a.session()?.toLowerCase() === String(b.session).toLowerCase()));
        if (have) return { status: 200, body: { agent: have.id, opened: false, ...shown(have) } };
      }
      const target = launchTarget({ dir: root, resume: b.session as string | undefined, fork: b.fork === true, new: b.mode === 'new', native: provider !== 'claude' }, agentContext(provider).stateDir);
      const id = await openAgent({ provider, cwd: root, backend: o.backends(provider), ...target });
      return { status: 200, body: { agent: id, opened: true, ...shown(agents.get(id)!) } };
    };
    // one at a time: two asks for one folder (a double click, a page and a launcher) open one agent
    let opened: Promise<unknown> = Promise.resolve();
    s.controlOpen = (body) => {
      const r = opened.then(() => openOne(body));
      opened = r.catch(() => {});
      return r;
    };
    // `shown`: a tab on this computer shows the agent: one already did, or the last one attached moves to it (the launcher
    // then opens no browser); none: the launcher opens one
    // an agent another device holds (the phone) is no place to move a tab: it would land there occupied
    const showIn = (a: Agent): { shown?: true } => {
      if (a.shownSince()) return { shown: true };
      if (a.owned()) return {};
      const tab = [...agents.values()].reduce<Agent | null>((m, x) => (x.shownSince() > (m?.shownSince() ?? 0) ? x : m), null);
      if (!tab) return {};
      tab.show(a.id);
      return { shown: true };
    };
    // an agent closes alone (the switcher's Close project, its tab's ✕); its session stays, its folder under Recent. The
    // server's last one too: its home lists the projects to open one again (issue 639)
    s.closeAgent = (id) => {
      const a = agents.get(id);
      if (!a) return 409;
      agents.delete(id);
      keep();
      void a.close();
      return 200;
    };
    const settled = new Map(reopen.map((k) => [k.id, Promise.withResolvers<void>()]));
    for (const [id, p] of settled) reopening.set(id, p.promise);
    for (const k of reopen) {
      try {
        const provider = parseProvider(k.provider);
        if (!AGENT_ID.test(k.id) || !k.id.startsWith(`${provider}-`)) throw new Error(`not an agent id: ${k.id}`);
        if (!fs.statSync(k.root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`the folder of agent ${k.id} is gone: ${k.root}`);
        const target = launchTarget({ dir: k.root, ...(k.session ? { resume: k.session } : {}), native: provider !== 'claude' }, agentContext(provider).stateDir);
        await openAgent({ provider, cwd: k.root, backend: o.backends(provider), id: k.id, ...target });
      } catch (e) {
        report('agents', e); // that one is dropped: its folder is gone, or its backend would not start
      } finally {
        reopening.delete(k.id);
        settled.get(k.id)!.resolve();
      }
    }
    if (reopen.length && !agents.size && !o.home) await launchAgent(); // none came back: the launch's own, as a fresh launch
    keep();
    return { url: `http://127.0.0.1:${port}`, close: () => close!(), open: openAgent };
  } catch (e) {
    audit?.close();
    throw e;
  }
}
