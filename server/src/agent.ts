// One agent of a server (epic 383): a provider's session line in a folder, with its stores, routes, socket and one-tab rule,
// under `/a/<id>/`. The server (server.ts) starts it and gives it what its agents share.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { isAttachmentAnchor, parseClientMessage, PROTOCOL } from '@nota-bene/shared';
import type { ClientMessage, Comment, ServerEvent, Stats } from '@nota-bene/shared';
import type { ProviderBackend as AgentBackend } from './agent/types.ts';
import type { AgentProvider } from './agent/provider.ts';
import type { ServerOptions } from './server.ts';
import { guard, reportError } from './errors.ts';
import { HistoryArchive, historyRoutes } from './archive.ts';
import { subagentRoutes } from './subagent.ts';
import { taskOutputRoutes } from './taskOutput.ts';
import { AttachmentStore, attachmentRoutes } from './attachments.ts';
import { ProjectIconStore, projectIconRoutes } from './projectIcon.ts';
import { MarkFiles, markRoutes } from './marks.ts';
import { CommentStore } from './comments.ts';
import { PromptStore, promptRoutes } from './prompts.ts';
import { EventHub } from './hub.ts';
import { complete, fileRoutes } from './fileRoutes.ts';
import { osFileRoutes } from './osFiles.ts';
import { tmpDirNames } from './tmpImage.ts';
import { readPrefs } from './prefs.ts';
import { httpHandler, isAllowedHost } from './http.ts';
import { SwitchError, createSessionManager, trackedCommand } from './session.ts';
import { archiveRoute, deleteRoute, listSessionsView, renameRoute, seenRoute } from './sessions.ts';
import { readArchived, setArchived } from './archivedSessions.ts';
import { markSeen, readSeen } from './seen.ts';
import { forgetSession, type AgentContext } from './state.ts';
import { AuditLog } from './audit.ts';
import { clipAsk } from './session/permissions.ts';
import { listProjects, type ProbedInfo, type Self } from './projects.ts';
import { readJson, systemRoutes } from './system.ts';
import { RESTART, restartGate } from './restartGate.ts';
import { compactOrder } from './compactOrder.ts';
import { TurnMarks, changesWork } from './turnMarks.ts';
import { projectRoutes } from './projectRoutes.ts';
import { updateCheck } from './update.ts';
import { updater } from './updater.ts';
import { dictationRoutes } from './dictation/routes.ts';
import { remoteRoutes } from './remote/routes.ts';
import { voiceRoutes } from './voice/routes.ts';
import { whisperPhase } from './dictation/install.ts';
import { CutExporter } from './cut/exporter.ts';
import { findFfmpeg } from './cut/ffmpeg.ts';
import { CutPeaks } from './cut/peaks.ts';
import { CutReverse } from './cut/reverse.ts';
import { cutRoutes } from './cut/routes.ts';
import { usageRoutes } from './usage/routes.ts';
import { KEY_PROTOCOL } from './auth.ts';

/** ping period of every socket: one whose last ping got no pong is ended (R-M7-7) */
export const HEARTBEAT_MS = 30_000;

// every running agent's hub: the process-wide handlers report to them (server.ts)
export const hubs = new Set<EventHub>();
let attaches = 0; // orders the attaches of the pages that follow (`go=1`) across a server's agents: the launcher moves the last one (Agent.shownSince)

/** One agent of a server (epic 383): a provider's session line in a folder, today's window minus the process. */
export type AgentOptions = {
  agent: AgentContext;
  id: string;
  cwd: string;
  backend: AgentBackend;
  resume?: string;
  fork?: boolean;
  onStats?: (s: Stats) => void;
  onLimit?: (info: unknown) => void;
};

/** What a server's agents share: the listener and its login, the process's exit, its update and its restart. */
export type Shared = {
  o: ServerOptions;
  audit: AuditLog | null;
  authorize?: (req: http.IncomingMessage, needKey: boolean) => boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
  /** the routes anyone may reach: /auth, /hello */
  open: Record<string, http.RequestListener>;
  control: string;
  port: () => number;
  projectIcons: ProjectIconStore;
  supervised: () => boolean;
  codeChanged: () => boolean;
  repoDir: string;
  newer: ReturnType<typeof updateCheck>;
  win: ReturnType<typeof updater>;
  restart: ReturnType<typeof restartGate>;
  requestRestart: () => boolean;
  exiting: () => boolean;
  exitWith: (code: number) => void;
  /** every agent (their /info and home's list them: the switcher's rows, projects.ts) */
  agents: () => { id: string; provider: AgentProvider; root: string }[];
  /** every agent's folder, session and whether it is at work (issue 676: an agent's guards read its neighbours here, not over HTTP) */
  live: () => { id: string; root: string; session: string | null; working: boolean }[];
  /** some agent but this one is not in a pause */
  othersBusy: (id: string) => boolean;
  /** POST /a/<id>/control/close, set once the server is up: 200, or 409 for the server's last agent */
  closeAgent: (id: string) => number;
  /** POST /control/open, set once the server is up */
  controlOpen: (body: unknown) => Promise<{ status: number; body: unknown }>;
  /** the server as its own pages' project routes ask it (issue 691) */
  self: Self;
};

export type Agent = {
  id: string;
  provider: AgentProvider;
  hub: EventHub;
  handler: http.RequestListener;
  /** a request already known to be this agent's `/ws` */
  upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  root(): string;
  /** its session's id (none before the first turn) */
  session(): string | null;
  /** its /info */
  info(): ProbedInfo;
  /** its GET /sessions */
  sessions(): Promise<{ current: string | null; sessions: unknown[] }>;
  /** at work, its /info's `busy`: a turn, a waiting question or approval, a switch or a running task */
  working(): boolean;
  /** not a pause: at work, a `! cmd` run, or a finished task's report still due */
  notPaused(): boolean;
  /** its sockets that ask for a pending restart in their own pause (gh-422) */
  askers(): number;
  /** when its newest page that follows the launcher (`go=1`) attached (a growing count); 0 with no such page */
  shownSince(): number;
  /** sends that page to the agent `id` (protocol 30 `open-agent`) */
  show(id: string): void;
  restartChanged(pending: boolean): void;
  onSwitch(fn: (restart: boolean) => void): void;
  /** the conversation got an id, or another one (its first, a /clear) */
  onSessionId(fn: () => void): void;
  /** a turn the exit cuts stays marked */
  freeze(): void;
  close(): Promise<void>;
};


/** An agent of the server `s`: its session, stores, routes, socket and one-tab rule. */
export async function startAgent(s: Shared, a: AgentOptions): Promise<Agent> {
  const { o, audit, authorize, allowedHosts, allowedOrigins, projectIcons, supervised, codeChanged, repoDir, newer, win, restart, requestRestart, exitWith } = s;
  const agent = a.agent;
  const hub = new EventHub();
  hubs.add(hub);
  audit && hub.tap((ev) => audit.server(ev));
  // what a start that fails part-way has already made, undone in reverse (a second agent's failure leaves the server up)
  const undo: (() => void)[] = [];
  try {
    const attachments = new AttachmentStore({ dir: path.join(agent.stateDir, 'attachments') });
    const archive = new HistoryArchive({ dir: path.join(agent.stateDir, 'history'), report: (e) => reportError(hub, 'archive', e) });
    // gh-422: the mark of a turn the server is in the middle of, so the start after a cut one can say so
    const turnMarks = new TurnMarks({
      dir: path.join(agent.stateDir, 'turns-open'),
      // a turn to mark: the agent at work (`working` below), but not in a switch alone (its ↻ ends its own turn)
      working: () => (manager.busy() && !manager.switching()) || hub.tasksRunning() > 0,
      session: () => manager.info().id,
    });
    const manager = await createSessionManager({
      stateDir: agent.stateDir,
      provider: agent.provider,
      hub,
      turnCut: (id) => turnMarks.take(id),
      attachments,
      archive,
      backend: a.backend,
      ...(a.onStats ? { onStats: a.onStats } : {}),
      ...(a.onLimit ? { onLimit: a.onLimit } : {}),
      cwd: a.cwd,
      ...(a.resume ? { resume: a.resume } : {}),
      ...(a.resume && a.fork && a.backend.capabilities.fork ? { fork: true } : {}),
      ...(o.idle ? { idle: o.idle } : {}),
      ...(o.idleOffInSettings ? { idleOffInSettings: o.idleOffInSettings } : {}),
      ...(o.shell ? { shell: o.shell } : {}),
      // a voice message whose transcript failed never reaches the agent: the comments it carried are pending again
      onDropped: (id) => { store.markPending(manager.info().id, id); broadcastComments(); },
    });
    undo.push(() => { manager.close(); void a.backend.close?.().catch(() => {}); });
    const store = new CommentStore({ dir: path.join(agent.stateDir, 'comments') });
    // comments are live state, not history: never stored in the replay, a new socket gets the set directly
    const currentComments = () => store.get(manager.info().id);
    /** the current session's set with its revision (protocol 19); `ack` names the ops this change applied */
    const commentsEvent = (ack?: string): Extract<ServerEvent, { kind: 'comments' }> => {
      const { items, rev } = store.state(manager.info().id);
      return { kind: 'comments', items, rev, ...(ack ? { ack: [ack] } : {}) };
    };
    const broadcastComments = (ack?: string) => hub.emit(commentsEvent(ack), { store: false });
    // the web's prompt history: a new session's first prompts wait in memory for its id (as comments do); a /clear or a fork
    // keeps the history, so the new id gets a copy of the previous one's
    const prompts = new PromptStore({ dir: path.join(agent.stateDir, 'prompts'), report: (e) => reportError(hub, 'prompts', e) });
    hub.tap((ev) => { if (changesWork(ev)) turnMarks.schedule(); });
    manager.onSessionId((id, prev) => {
      turnMarks.schedule();
      if (prev === null) store.adopt(id);
      broadcastComments();
      try {
        if (prev !== null) prompts.carry(prev, id);
        prompts.adopt(id); // a fork or an id-less /clear too: its first prompts waited in memory
      } catch (e) {
        reportError(hub, 'prompts', e);
      }
    });
    manager.onSwitch((_, { restart }) => {
      if (!restart) prompts.dropPending();
      // the unsent set of a new session (in memory, no id yet) stays behind: it must not be adopted by another
      // session. A restart keeps the same session (and root), so it keeps the set too
      if (!restart) store.dropPending();
      broadcastComments();
    });
    // the one source of the project root: a switch changes it, so every route reads it per request
    const root = () => manager.info().root;
    // the two answers to "is this agent busy" (issue 689). At work: a turn, a waiting question or approval, a switch or a
    // running task; what the lists show and what holds a checkout
    const working = () => manager.busy() || hub.tasksRunning() > 0;
    // not a pause: at work, a `! cmd` run, or a finished task's report still due. The update's hand-over (77), a pending
    // restart (75) and an ordered compaction wait for the pause
    const notPaused = () => working() || manager.shellRunning() || hub.reportDue();
    // this server's agents and the other servers' (issue 680), each with its folder, session and work
    const running = async (): Promise<{ id?: string; root: string; session: string | null; working: boolean }[]> => [
      ...s.live(),
      ...(await listProjects({ port: s.port(), agent: a.id, self: s.self })).running
        .filter((r) => r.port !== s.port()).map((r) => ({ root: r.root, session: r.session, working: r.state === 'working' || r.state === 'waiting' })),
    ];
    // issue 499: a compaction ordered while the agent works waits for the next pause, after a pending restart; the sends
    // of pages that understand it (`held=1`) wait behind both
    const order = compactOrder({
      dir: path.join(agent.stateDir, 'compact-pending'),
      session: () => manager.archiveId(),
      busy: notPaused,
      switching: () => manager.switching(),
      // only while this agent is the one in the way (no other is working): an idle project never waits for another's turn
      restartPending: () => restart.pending() && !s.othersBusy(a.id),
      // the user's /compact, with the instructions typed after it, as a typed one goes in a pause
      compact: (text) => void manager.send({ id: randomUUID(), text }),
      send: (m) => void manager.send(m),
      changed: () => hub.emit({ kind: 'compact-pending', ...order.view() }, { store: false }),
      report: (e) => reportError(hub, 'compact', e),
      everyMs: o.restartEveryMs,
    });
    undo.push(() => order.stop());
    order.enter(manager.archiveId()); // the start: what this session's last run left pending goes on
    manager.onSessionId(() => order.moved());
    manager.onSwitch((_id, { restart: same }) => { if (!same) order.enter(manager.archiveId()); });
    const marks = new MarkFiles({ root, stateDir: () => agent.stateDir });
    // the video editor's export (epic 406): ffmpeg is looked up again at each connect and start, so one installed later is found
    const cutExporter = new CutExporter({ root, ...(o.ffmpeg ? { ffmpeg: o.ffmpeg } : {}) });
    cutExporter.ffmpegState(); // warm: ffmpeg's version is asked now, in the background, so the first hello already knows it
    // the waveforms need any ffmpeg that decodes, not one new enough for the export
    const cutPeaks = new CutPeaks({ root, ffmpeg: o.ffmpeg ?? (() => findFfmpeg()) });
    const cutReverse = new CutReverse({ root, ffmpeg: o.ffmpeg ?? (() => findFfmpeg()), stateDir: () => agent.stateDir });
    undo.push(() => { cutExporter.dispose(); cutPeaks.dispose(); cutReverse.dispose(); });
    // a deleted session: Nota Bene's own data of it goes too, each part on its own (a failure is reported, the rest still goes)
    const forgetDeleted = (id: string) => {
      const parts: [string, () => void][] = [
        ['history', () => archive.forget(id)], ['prompts', () => prompts.forget(id)], ['comments', () => store.forget(id)],
        ['archived', () => setArchived(id, false, agent.stateDir)], ['last session', () => void forgetSession(agent.stateDir, id)], ['compact-pending', () => order.forget(id)],
      ];
      for (const [what, drop] of parts) {
        try { drop(); } catch (e) { reportError(hub, `sessions/delete ${what}`, e); }
      }
    };
    const sessions = () => listSessionsView({ backend: a.backend, current: manager.info().id, root: root(), archived: readArchived(agent.stateDir) });
    const sessionsRoute: http.RequestListener = (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      sessions().then(
        (view) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify(view));
        },
        (e) => {
          reportError(hub, 'sessions', e);
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(e instanceof Error ? e.message : String(e));
        },
      );
    };
    const info = () => {
      const { id, root, title, model } = manager.info();
      const asks = manager.asks();
      // busy (a turn or a running task, issue 667) and clients: for the lists of
      // projects; pending, last, replies: the phone's list
      return { agent: a.id, root, session: id, title, model, supervised: supervised(), codeChanged: codeChanged(), busy: working(), restartPending: restart.pending(), pending: manager.pending(), ...hub.summary(id ? readSeen(agent.stateDir)[id.toLowerCase()] ?? 0 : 0), clients: hub.clients(), icon: projectIcons.versionOrNull(root), agents: s.agents(), ...(asks.length ? { asks: asks.map(clipAsk) } : {}) };
    };
    const handler = httpHandler({
      hub,
      open: s.open,
      ...(authorize ? { authorize } : {}),
      allowedHosts,
      allowedOrigins,
      extra: {
        ...fileRoutes({
          root, hub, complete: (q) => complete({ session: manager, root: root() }, q),
          // the other servers' may fail to list: this server's own agents always count
          working: async () => (await running().catch(() => s.live())).filter((w) => w.working).map((w) => w.root), ...(audit ? { audit: (ev, f) => audit.write(ev, f) } : {}),
        }),
        ...attachmentRoutes(attachments, hub),
        // issue 461: any file into the project's attachments/, and Show in Finder / Open (this machine's page only)
        ...osFileRoutes({ root, hub }),
        ...voiceRoutes({ hub, store: attachments }),
        // the project folder's picture, set from the phone (protocol 15)
        ...projectIconRoutes({ store: projectIcons, root, hub }),
        // only the current conversation's archive: a page of another one (before a switch or a /clear) gets 409
        ...historyRoutes(archive, () => manager.archiveId(), hub),
        // the web's prompt history (HTTP only): the current conversation's sent prompts
        ...promptRoutes({ store: prompts, current: () => manager.info().id, own: () => manager.archiveId(), hub }),
        // a subagent's conversation (protocol 7); same rule: only the current conversation's
        ...subagentRoutes({ backend: a.backend, attachments, hub, current: () => manager.archiveId(), root }),
        // a shell task's output tail (protocol 8)
        ...taskOutputRoutes({ hub, current: () => manager.archiveId(), taskOutput: (id) => manager.taskOutput(id) }),
        ...markRoutes(marks, hub, {
          isSent: (id) => store.get(manager.info().id).some((c) => c.id === id && c.status === 'sent'),
        }),
        '/sessions': sessionsRoute,
        '/sessions/rename': renameRoute({ hub, rename: (id, title) => manager.rename(id, title) }),
        '/seen': seenRoute({ hub, current: () => manager.info().id, mark: (id, at) => markSeen(id, at, agent.stateDir) }),
        '/sessions/archive': archiveRoute({ hub, current: () => manager.info().id, set: (id, on) => setArchived(id, on, agent.stateDir) }),
        '/sessions/delete': deleteRoute({
          hub, current: () => manager.info().id, switching: () => manager.switching(),
          // another agent, of this server or another, on it (a terminal CLI cannot be seen: the dialog says so)
          openElsewhere: async (id) => (await running()).some((w) => w.id !== a.id && w.session?.toLowerCase() === id),
          remove: a.backend.capabilities.deleteSession && a.backend.deleteSession ? (id) => a.backend.deleteSession!(id) : undefined,
          forget: forgetDeleted,
        }),
        '/agent-account': (req, res) => {
          const run = async () => {
            if (!a.backend.account) { res.writeHead(404); res.end(); return; }
            if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405); res.end(); return; }
            const value = req.method === 'POST' ? await a.backend.login?.() : await a.backend.account();
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
          };
          void run().catch((e) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Codex unavailable' })); });
        },
        '/restart-server': (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
            res.end('method not allowed');
            return;
          }
          if (!supervised() || s.exiting()) {
            res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(s.exiting() ? 'exiting' : 'not supervised');
            return;
          }
          // `{now: true}`: Restart now, the running turn is cut. Otherwise at once in a pause, else pending
          void readJson(req).then((b) => {
            const now = (b as { now?: unknown }).now === true || requestRestart();
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            // answer first: the exit must not cut the reply; 75 tells the launcher to relaunch with --continue
            if (now) res.end('{"ok":true}', () => exitWith(RESTART));
            else res.end('{"ok":true,"pending":true}');
          }, () => {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('bad request');
          });
        },
        // the page's ask once it is in a pause too (as for the update); the exit checks the pause again after the reply
        '/restart-server/pause': (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
            res.end('method not allowed');
            return;
          }
          const r = restart.pause();
          if (r !== 'ok') {
            res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(r);
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"ok":true}', () => restart.replied());
        },
        '/restart-server/cancel': (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
            res.end('method not allowed');
            return;
          }
          restart.cancel();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"ok":true,"pending":false}');
        },
        // the header's Stop window (⏻): 0 tells a launcher to unregister and exit
        '/stop': (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
            res.end('method not allowed');
            return;
          }
          if (s.exiting()) {
            res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('exiting');
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"ok":true}', () => exitWith(0));
        },
        // issue 651: the home page's inbox answers an open ask, as the socket's `permission` message does
        '/permission': (req, res) => {
          if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' }).end('method not allowed');
          void readJson(req).then((b) => {
            const msg = parseClientMessage(JSON.stringify({ ...(b as object), type: 'permission' }));
            if ('error' in msg || msg.type !== 'permission') return void res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
            audit?.client(msg, 0);
            if (!manager.answer(msg.id, msg.allow, msg.response)) return void res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' }).end('already answered');
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end('{"ok":true}');
          }, () => void res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request'));
        },
        ...usageRoutes({ hub }),
        ...dictationRoutes({ hub }),
        ...cutRoutes({ hub, exporter: cutExporter, peaks: cutPeaks, reverse: cutReverse, root }),
        ...remoteRoutes({ hub, keeper: o.remote }),
        ...projectRoutes({ hub, port: () => s.port(), agent: a.id, self: s.self, ...(o.remote ? { computers: () => o.remote!.computers() } : {}) }),
        ...systemRoutes({
          updater: win, newer,
          hub, root, stateDir: agent.stateDir, modes: a.backend.capabilities.modes, port: () => s.port(), repoDir,
          control: {
            supervised,
            exiting: s.exiting,
            restartAgent: () => void manager.restart().catch(switchFailed),
            restartServer: () => { if (requestRestart()) exitWith(RESTART); },
            restartServerNow: () => exitWith(RESTART),
            cancelRestart: () => void restart.cancel(),
            stop: () => exitWith(0), // the launcher treats 0 as "stop" and unregisters the window
            open: (b) => s.controlOpen(b),
            close: () => s.closeAgent(a.id),
          },
        }),
      },
      webDist: o.webDist,
      controlToken: () => s.control,
      info,
    });
    const switchFailed = (e: unknown) => reportError(hub, e instanceof SwitchError ? e.where : 'switch', e);
    const wss = new WebSocketServer({
      noServer: true,
      // the page's key travels as the `nb.<key>` subprotocol (never in the URL); echo it or the browser drops the socket
      handleProtocols: (protocols) => [...protocols].find((p) => p.startsWith(KEY_PROTOCOL)) ?? false,
      verifyClient: ({ req }, done) => {
        const origin = req.headers.origin;
        const ok = isAllowedHost(req.headers.host, allowedHosts)
          && (origin === undefined || allowedOrigins.includes(origin));
        // an unset Origin (a script, a helper) is let in only with valid auth, and so is every browser page
        if (!ok) done(false, 403, 'forbidden');
        else if (authorize && !authorize(req, true)) done(false, 401, 'unauthorized');
        else done(true);
      },
    });
    // a client message the agent's capabilities forbid: a `server-error` (as the other refusals that are no `send`);
    // the web hides these controls, so this only fires for a stale page or a hand-made client
    const caps = a.backend.capabilities;
    const refuse = (what: string) => reportError(hub, 'capability', new Error(`${what}: the agent does not support it`));

    // issue 174: every socket is attached (a page, the phone, another computer's page). Each is pinged; one whose last
    // ping got no pong is ended (R-M7-7), so a dead one holds no update, fold or pending restart. `alive`: false while a ping waits
    const alive = new WeakMap<WebSocket, boolean>();
    const heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (alive.get(ws) === false) { ws.terminate(); continue; }
        alive.set(ws, false);
        try { ws.ping(); } catch { /* socket gone: its close handler follows */ }
      }
    }, o.heartbeatMs ?? HEARTBEAT_MS);
    heartbeat.unref();
    undo.push(() => clearInterval(heartbeat));
    // the pages that follow the launcher (`go=1`, protocol 30), by when they attached: `open-agent` goes to the newest
    const shown = new Map<WebSocket, number>();
    const newestShown = (): WebSocket | null => {
      let top: WebSocket | null = null;
      for (const [ws, since] of shown) if (ws.readyState === ws.OPEN && since > (top ? shown.get(top)! : 0)) top = ws;
      return top;
    };

    // the hello every socket gets
    const sendHello = (ws: WebSocket) => {
      try {
        const { lang, uiScale, theme, whisper, dictationLang } = readPrefs(); // the user's UI language, scale and theme, shared by every window; absent until chosen
        ws.send(JSON.stringify({ kind: 'hello', protocol: PROTOCOL, capabilities: { ...caps, ffmpeg: cutExporter.available(), ...(whisper === true && whisperPhase() === 'ready' ? { dictation: 'whisper' as const } : {}) }, ...(lang ? { lang } : {}), ...(uiScale ? { uiScale } : {}), ...(theme ? { theme } : {}), ...(dictationLang ? { dictationLang } : {}), tmpDirs: tmpDirNames() }));
      } catch (e) {
        reportError(hub, 'hello', e);
      }
    };

    // a socket's wiring: replay (via the hub), state frames, hello
    const attach = (ws: WebSocket) => {
      const hubDetach = hub.attach({ send: (d) => ws.send(d), buffered: () => ws.bufferedAmount });
      let detached = false;
      if (asksInPause.has(ws)) {
        askers.add(ws);
        ws.on('close', () => askers.delete(ws));
      }
      const detach = () => { if (!detached) { detached = true; hubDetach(); askers.delete(ws); } };
      detachers.set(ws, detach);
      ws.on('pong', () => alive.set(ws, true));
      if (follows.has(ws)) shown.set(ws, ++attaches);
      manager.clientAttached();
      try {
        ws.send(JSON.stringify(commentsEvent()));
      } catch (e) {
        reportError(hub, 'comments', e);
      }
      if (o.remote) {
        try {
          ws.send(JSON.stringify({ kind: 'remote', state: o.remote.state() }));
        } catch (e) {
          reportError(hub, 'remote', e);
        }
      }
      try {
        ws.send(JSON.stringify({ kind: 'restart-pending', pending: restart.pending() }));
        ws.send(JSON.stringify({ kind: 'compact-pending', ...order.view() }));
      } catch (e) {
        reportError(hub, 'restart', e);
      }
      try {
        ws.send(JSON.stringify({ kind: 'mode', mode: manager.mode() }));
      } catch (e) {
        reportError(hub, 'mode', e);
      }
      // a reload shows the model pill at once: the list and the current choice go with the other state
      try {
        const { model, effort } = manager.model();
        ws.send(JSON.stringify({ kind: 'models', models: manager.models() }));
        ws.send(JSON.stringify({ kind: 'model', model, ...(effort && { effort }) }));
      } catch (e) {
        reportError(hub, 'model', e);
      }
      try {
        ws.send(JSON.stringify({ kind: 'commands', commands: manager.commands() }));
      } catch (e) {
        reportError(hub, 'commands', e);
      }
      try {
        ws.send(JSON.stringify({ kind: 'idle-compact', state: manager.idleCompact() }));
      } catch (e) {
        reportError(hub, 'idle-compact', e);
      }
      try {
        ws.send(JSON.stringify({ kind: 'stats', stats: manager.stats() }));
      } catch (e) {
        reportError(hub, 'stats', e);
      }
      // a `! cmd` run in progress: the replay holds its start, this brings the output printed so far (live chunks follow)
      try {
        const snap = manager.shellSnapshot();
        if (snap) ws.send(JSON.stringify({ kind: 'shell-out', id: snap.id, text: snap.text, truncated: snap.truncated }));
      } catch (e) {
        reportError(hub, 'shell', e);
      }
      // what this server understands (see PROTOCOL); last, so the state above keeps its order
      sendHello(ws);
      ws.on('close', () => {
        detach();
        shown.delete(ws);
      });
    };
    const detachers = new WeakMap<WebSocket, () => void>();

    // a socket's messages
    const handle = (ws: WebSocket, msg: ClientMessage) => {
        switch (msg.type) {
          case 'send':
            // issue 499: a typed /compact while the agent works (or behind a pending order) is the pending compaction
            if (holds.has(ws) && caps.compact && !msg.commentIds?.length && !manager.switching() && trackedCommand(msg.text, manager.commands()) === 'compact'
              && (manager.busy() || order.holding())) {
              order.order(msg.text);
              ws.send(JSON.stringify({ kind: 'send-held', id: msg.id }));
              break;
            }
            {
              // before markSent: a refused send must not flip its comments to sent. Only the asking socket hears
              // of it (not stored, not broadcast). A /clear waits for nobody: refused behind a pending order (issue 499)
              const why = manager.refusal(msg.text) ?? (order.holding() && trackedCommand(msg.text, manager.commands()) === 'clear' ? 'busy' : null);
              if (why) {
                ws.send(JSON.stringify({ kind: 'send-refused', id: msg.id, reason: why }));
                break;
              }
            }
            if (msg.commentIds?.length) {
              // an attachment comment goes only in the message that carries its image; otherwise it stays pending.
              // A store that cannot be read must not block the send (markSent below reports the same failure)
              try {
                const have = new Set((msg.images ?? []).map((i) => i.id));
                if (currentComments().some((c) => c.status === 'pending' && msg.commentIds!.includes(c.id) && c.anchor && isAttachmentAnchor(c.anchor) && !have.has(c.anchor.image))) {
                  ws.send(JSON.stringify({ kind: 'send-refused', id: msg.id, reason: 'detached' }));
                  break;
                }
              } catch (e) {
                reportError(hub, 'comments', e);
              }
              // before the agent call: the UI flips to sent even if the agent later fails
              try {
                store.markSent(manager.info().id, msg.commentIds, msg.id);
                broadcastComments();
              } catch (e) {
                reportError(hub, 'comments', e); // the message itself must still go out
              }
            }
            {
              const send = { id: msg.id, text: msg.text, ...(msg.images?.length ? { images: msg.images } : {}), ...(msg.voice ? { voice: msg.voice, lang: msg.lang, ...(msg.detect ? { detect: true as const } : {}) } : {}) };
              // issue 499: behind a pending restart or compaction a send waits; a forced one (Send now) goes at once, as before
              if (holds.has(ws) && !msg.force && order.holding()) {
                order.hold({ ...send, ts: Date.now() });
                ws.send(JSON.stringify({ kind: 'send-held', id: msg.id }));
              } else manager.send({ ...send, ...(msg.force ? { force: true } : {}) });
            }
            break;
          case 'comments':
            // R14: a set in flight across a switch (or a /clear) must not land in the session that replaced it
            if (manager.switching() || msg.sessionId !== manager.info().id) {
              reportError(hub, 'comments', new Error('stale session'));
              break;
            }
            {
              const id = manager.info().id;
              let prev: Comment[];
              let merged: Comment[];
              try {
                prev = store.get(id);
                merged = store.merge(id, msg.items);
                broadcastComments();
              } catch (e) {
                reportError(hub, 'comments', e); // nothing stored, nothing broadcast; the socket stays up
                break;
              }
              try {
                marks.sync(prev, merged); // a deleted media comment takes its frame/layer files along
              } catch (e) {
                reportError(hub, 'marks', e); // the merge stands
              }
            }
            break;
          case 'comment-op':
            {
              // an op names the session it was made in, so work queued across a switch lands there; null is the
              // window's current session (a comment made before the session had an id, adopted since)
              const id = msg.sessionId ?? manager.info().id;
              let prev: Comment[];
              let refused: ReturnType<CommentStore['apply']>;
              try {
                prev = store.get(id);
                refused = store.apply(id, msg.ops);
              } catch (e) {
                reportError(hub, 'comments', e);
                // nothing stored: the client keeps the op and sends it again
                ws.send(JSON.stringify({ kind: 'comment-refused', opId: msg.opId, reason: 'failed' }));
                break;
              }
              if (refused) {
                ws.send(JSON.stringify({ kind: 'comment-refused', opId: msg.opId, reason: refused.reason, id: refused.id }));
                break;
              }
              // the window's set: everyone sees the change, the sender its ack; another session's set is no one's view,
              // and during a switch the switch's end sends the set
              if (id === manager.info().id && !manager.switching()) broadcastComments(msg.opId);
              else ws.send(JSON.stringify({ kind: 'comment-ack', opId: msg.opId }));
              try {
                marks.sync(prev, store.get(id)); // a deleted media comment takes its frame/layer files along
              } catch (e) {
                reportError(hub, 'marks', e); // the change stands
              }
            }
            break;
          case 'mode':
            if (!caps.modes.includes(msg.mode)) {
              refuse(`mode ${msg.mode}`);
              // the sender still waits for its ack (the pill went optimistic): answer with the mode as it stands
              hub.emit({ kind: 'mode', mode: manager.mode(), ...(msg.id && { ack: msg.id }) }, { store: false });
              break;
            }
            void manager.setMode(msg.mode, msg.id);
            break;
          case 'model':
            if (!caps.models) {
              refuse('model');
              // the sender still waits for its ack: answer with the model as it stands
              const cur = manager.model();
              hub.emit({ kind: 'model', model: cur.model, ...(cur.effort && { effort: cur.effort }), ...(msg.id && { ack: msg.id }) }, { store: false });
              break;
            }
            void manager.setModel({ model: msg.model, ...(msg.effort && { effort: msg.effort }) }, msg.id);
            break;
          case 'interrupt':
            manager.interrupt();
            break;
          case 'permission':
            // the agent gets the ORIGINAL input back: a client never rewrites the input of an approved tool call.
            // Another client may have answered first: this one alone hears so, as the HTTP route's 409
            if (!manager.answer(msg.id, msg.allow, msg.response)) ws.send(JSON.stringify({ kind: 'server-error', where: 'permission', message: 'already answered' }));
            break;
          case 'command':
            if (!caps[msg.name]) return refuse(`command ${msg.name}`);
            // issue 499: Compact while the agent works (or behind a pending restart) is ordered for the next pause
            if (msg.name === 'compact' && holds.has(ws) && !manager.switching() && (manager.busy() || order.holding())) order.order('/compact');
            // a /clear must not run ahead of a pending compaction and the sends held behind it
            else if (msg.name === 'clear' && order.holding()) reportError(hub, 'busy', new Error('a compaction or restart is pending; the command was not sent'));
            else manager.command(msg.name);
            break;
          case 'compact-cancel':
            order.cancel();
            break;
          case 'switch':
            manager.switch({ id: msg.id, dir: msg.dir }).catch(switchFailed);
            break;
          case 'activity':
            manager.activity();
            break;
          case 'task-stop':
            manager.stopTask(msg.id).catch((e) => reportError(hub, 'task', e));
            break;
          case 'task-background':
            if (caps.taskBackground === false) return refuse('foreground-to-background is unavailable for this provider');
            // false: the call is not a foreground task any more (it ended, or went to the background already)
            manager.backgroundTask(msg.toolUseId).then(
              (moved) => { if (!moved) reportError(hub, 'task', new Error('nothing to move to the background: the task is not running in the foreground')); },
              (e) => reportError(hub, 'task', e),
            );
            break;
          case 'shell-run': {
            // only the asking socket hears of a refusal (not stored): the page puts the draft back
            const why = manager.shellRun(msg.id, msg.cmd);
            if (why === 'running' || why === 'switching') ws.send(JSON.stringify({ kind: 'shell-refused', id: msg.id, reason: why }));
            break;
          }
          case 'shell-stop':
            manager.shellStop(msg.id);
            break;
          case 'idle-compact':
            if (!(caps.idleCompact && caps.compact)) return refuse('idle-compact');
            manager.setIdleCompact(msg.on);
            break;
          case 'restart':
            manager.restart().catch(switchFailed);
            break;
        }
    };

    // gh-422: sockets of a page (protocol 22+, `?pause=1`) that asks for a pending restart in its own pause; while one
    // is attached the server leaves that moment to it, otherwise its own pause rule restarts
    const asksInPause = new WeakSet<WebSocket>();
    // issue 499: sockets of a page (protocol 27+, `?held=1`) that knows `send-held`: only their sends are held
    const holds = new WeakSet<WebSocket>();
    // protocol 30: sockets of a page on this computer (`?go=1`, never the phone's) that moves to the agent the launcher opens
    const follows = new WeakSet<WebSocket>();
    const askers = new Set<WebSocket>();

    let conns = 0;
    wss.on('connection', (ws, req) => {
      const params = new URL(req.url ?? '/', 'http://x').searchParams;
      if (params.get('pause') === '1') asksInPause.add(ws);
      if (params.get('held') === '1') holds.add(ws);
      if (params.get('go') === '1') follows.add(ws);
      const conn = ++conns;
      audit?.write('ws-open', { conn });
      ws.on('close', (code) => audit?.write('ws-close', { conn, code }));
      ws.on('error', (e) => reportError(hub, 'ws', e));
      ws.on('message', guard(hub, 'ws', (data) => {
        const msg = parseClientMessage(String(data));
        if ('error' in msg) {
          reportError(hub, 'ws', msg.error);
          // a comment op that can never be applied: answered, so the client drops it instead of sending it forever (issue 494)
          if (msg.opId !== undefined) ws.send(JSON.stringify({ kind: 'comment-refused', opId: msg.opId, reason: 'invalid' }));
          return;
        }
        if (msg.type === 'takeover') return; // a client of a server before 39 (an older phone): there is nothing to take
        audit?.client(msg, conn);
        handle(ws, msg);
      }));
      attach(ws);
    });


    let closing: Promise<void> | null = null;
    const close = () => (closing ??= new Promise<void>((resolve) => {
      hubs.delete(hub);
      if (heartbeat) clearInterval(heartbeat);
      order.stop();
      turnMarks.freeze(); // a stop (SIGTERM, ⏻) during a turn keeps its mark: the close ends the turn
      manager.close();
      const backendClose = a.backend.close?.().catch((e) => reportError(hub, 'backend-close', e));
      cutExporter.dispose();
      cutPeaks.dispose();
      cutReverse.dispose();
      for (const c of wss.clients) c.terminate();
      wss.close(() => { void Promise.resolve(backendClose).then(() => resolve()); });
    }));
    return {
      id: a.id,
      provider: agent.provider,
      hub,
      handler,
      upgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)),
      root,
      session: () => manager.info().id,
      info,
      sessions,
      working,
      notPaused,
      askers: () => askers.size,
      shownSince: () => { const ws = newestShown(); return ws ? shown.get(ws)! : 0; },
      show: (id) => {
        try {
          newestShown()?.send(JSON.stringify({ kind: 'open-agent', agent: id }));
        } catch (e) {
          reportError(hub, 'open-agent', e);
        }
      },
      restartChanged: (pending) => {
        hub.emit({ kind: 'restart-pending', pending }, { store: false });
        order.check(); // cancelled: what it held goes on
      },
      onSwitch: (fn) => manager.onSwitch((_id, { restart: same }) => fn(same)),
      onSessionId: (fn) => manager.onSessionId(() => fn()),
      freeze: () => turnMarks.freeze(),
      close,
    };
  } catch (e) {
    for (const f of undo.reverse()) { try { f(); } catch { /* the start's own error is the one to report */ } }
    hubs.delete(hub);
    throw e;
  }
}
