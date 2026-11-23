import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { isAttachmentAnchor, isSessionId, parseClientMessage, PROTOCOL, TAKEN_OVER_CODE } from '@nota-bene/shared';
import type { ClientMessage, Comment, RemoteState, ServerEvent, Stats } from '@nota-bene/shared';
import type { ProviderBackend as AgentBackend } from './agent/types.ts';
import { parseProvider, type AgentProvider } from './agent/provider.ts';
import { guard, reportError } from './errors.ts';
import { HistoryArchive, historyRoutes } from './archive.ts';
import { subagentRoutes } from './subagent.ts';
import { taskOutputRoutes } from './taskOutput.ts';
import { AttachmentStore, attachmentRoutes } from './attachments.ts';
import { ProjectIconStore, projectIconRoutes } from './projectIcon.ts';
import { MarkFiles, markRoutes } from './marks.ts';
import { CommentStore } from './comments.ts';
import { PromptStore, promptRoutes } from './prompts.ts';
import { EventHub, type EmitInput } from './hub.ts';
import { complete, fileRoutes } from './fileRoutes.ts';
import { osFileRoutes } from './osFiles.ts';
import { tmpDirNames } from './tmpImage.ts';
import { readPrefs } from './prefs.ts';
import { agentPrefix, httpHandler, isAllowedHost, pathOf } from './http.ts';
import { SwitchError, createSessionManager, trackedCommand } from './session.ts';
import type { IdleConfig } from './idle.ts';
import { archiveRoute, deleteRoute, launchTarget, listSessionsView, renameRoute, seenRoute } from './sessions.ts';
import { readArchived, setArchived } from './archivedSessions.ts';
import { markSeen, readSeen } from './seen.ts';
import { codeChecker } from './codeStamp.ts';
import { AGENT_ID, agentContext, envAgentContext, forgetSession, launchAgentId, newAgentId, stateBaseDir, type AgentContext } from './state.ts';
import { AuditLog } from './audit.ts';
import { moveWindow, readKeptAgents, writeKeptAgents } from './windows.ts';
import { pidAlive, samePath } from './platform.ts';
import { controlToken, describeVersion, listWindows, readJson, systemRoutes } from './system.ts';
import { overlapWatch } from './overlap.ts';
import { RESTART, restartGate } from './restartGate.ts';
import { compactOrder } from './compactOrder.ts';
import { TurnMarks, changesWork } from './turnMarks.ts';
import { projectRoutes } from './projectRoutes.ts';
import { updateCheck } from './update.ts';
import { updater } from './updater.ts';
import { runtimeDir } from './runtime.ts';
import { hostClient } from './dictation/hostClient.ts';
import { dictationRoutes } from './dictation/routes.ts';
import type { PairOutcome, RemoteKeeper } from './remote/keeper.ts';
import { remoteRoutes } from './remote/routes.ts';
import { voiceRoutes } from './voice/routes.ts';
import { whisperPhase } from './dictation/install.ts';
import { CutExporter } from './cut/exporter.ts';
import { findFfmpeg } from './cut/ffmpeg.ts';
import { CutPeaks } from './cut/peaks.ts';
import { CutReverse } from './cut/reverse.ts';
import { cutRoutes } from './cut/routes.ts';
import { usageRoutes } from './usage/routes.ts';
import { attachAgent } from './attach.ts';
import { startFold } from './fold.ts';
import { CHALLENGE_RE, KEY_PROTOCOL, accessToken, authenticated, isNonce, loginRoute, newNonce, proofFor } from './auth.ts';

/** how long a newcomer waits for the owner to close before it is told `occupied` (R-M7-6) */
export const TAKEOVER_GRACE_MS = 700;
/** ping period for the owner socket (R-M7-7) */
export const HEARTBEAT_MS = 30_000;

// Process-wide handlers are registered once; each running server's hub is in this set.
const hubs = new Set<EventHub>();
let attaches = 0; // orders the owners' attaches across a server's agents: the launcher moves the last one (Agent.shownSince)
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
  backend: AgentBackend;
  resume?: string;
  fork?: boolean;
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
  /** every stats update; main.ts records the limit readings from it, tests leave the real store alone */
  onStats?: (s: Stats) => void;
  onLimit?: (info: unknown) => void;
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
  /** a backend for another agent of `provider` (main.ts; tests pass fakes); absent = no agent beyond the first */
  backends?: (provider: AgentProvider) => AgentBackend;
  /**
   * The launcher's server (main.ts): its extra agents are kept beside its registry entry (`<port>.agents.json`), and a
   * relaunch of the same launch (this launcher pid: a crash; this nonce: a restart or an update) reopens them under their ids
   */
  keep?: { launcherPid?: number };
  /** epic 383 (main.ts, a launcher's window on a port it picked): alone, idle and with no tab, it hands its folder to a server below and ends (fold.ts) */
  fold?: { everyMs: number };
};

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
type Shared = {
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
  /** the window's agent's id, and every agent's (their /info lists them: the switcher's rows, projects.ts) */
  primaryId: string;
  agents: () => { id: string; provider: AgentProvider }[];
  /** some agent but this one is not in a pause */
  othersBusy: (id: string) => boolean;
  /** epic 383 2e: the agents' edits and turns, for the warning when two edit one file at once */
  overlap: ReturnType<typeof overlapWatch>;
  /** POST /a/<id>/control/close, set once the server is up: 200, or 409 for the window's own agent */
  closeAgent: (id: string) => number;
  /** POST /control/open, set once the server is up */
  controlOpen: (body: unknown) => Promise<{ status: number; body: unknown }>;
};

type Agent = {
  id: string;
  provider: AgentProvider;
  hub: EventHub;
  handler: http.RequestListener;
  /** a request already known to be this agent's `/ws` */
  upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  root(): string;
  /** its session's id (none before the first turn) */
  session(): string | null;
  /** not a pause: its turn, a question, a switch, a `! cmd` run or a task */
  notPaused(): boolean;
  /** its sockets that ask for a pending restart in their own pause (gh-422) */
  askers(): number;
  /** when its owner socket, a page that follows the launcher (`go=1`), attached (a growing count); 0 with no such owner */
  shownSince(): number;
  /** any socket owns it (a page, the phone, another computer's page) */
  owned(): boolean;
  /** sends that owner to the agent `id` (protocol 30 `open-agent`) */
  show(id: string): void;
  restartChanged(pending: boolean): void;
  onSwitch(fn: (restart: boolean) => void): void;
  /** a turn the exit cuts stays marked */
  freeze(): void;
  close(): Promise<void>;
};

/** An agent of the server `s`: its session, stores, routes, socket and one-tab rule. */
async function startAgent(s: Shared, a: AgentOptions): Promise<Agent> {
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
      // the agent's work (not a switch, whose ↻ ends its own turn): a turn, a question or approval, a running task
      working: () => (manager.busy() && !manager.switching()) || hub.tasksRunning() > 0,
      session: () => manager.info().id,
    });
    const manager = await createSessionManager({
      stateDir: agent.stateDir,
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
    // its turns and edits, for the warning when another agent edits the same file in an overlapping turn
    hub.tap((ev) => {
      if (ev.kind === 'user') s.overlap.turn(a.id, true);
      else if (ev.kind !== 'agent') return;
      else if (ev.e.t === 'turn-start') s.overlap.turn(a.id, true);
      else if (ev.e.t === 'turn-end') s.overlap.turn(a.id, false);
      else void s.overlap.event(a.id, root(), ev.e).catch((e: unknown) => reportError(hub, 'overlap', e));
    });
    // not a pause: a turn, a waiting question or approval, a switch, a `! cmd` run or a task of the agent still running.
    // The update's hand-over (77) and a pending restart (75) wait for the same pause
    const notPaused = () => manager.busy() || manager.shellRunning() || hub.tasksRunning() > 0 || hub.reportDue();
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
    const sessionsRoute: http.RequestListener = (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      const { id } = manager.info();
      listSessionsView({ backend: a.backend, current: id, root: root(), archived: readArchived(agent.stateDir) }).then(
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
    const handler = httpHandler({
      hub,
      open: s.open,
      ...(authorize ? { authorize } : {}),
      allowedHosts,
      allowedOrigins,
      extra: {
        ...fileRoutes({
          root, hub, complete: (q) => complete({ session: manager, root: root() }, q),
          selfBusy: () => manager.busy(), ...(audit ? { audit: (ev, f) => audit.write(ev, f) } : {}),
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
          // another live window of this provider on it (a terminal CLI cannot be seen: the dialog says so)
          openElsewhere: async (id) => (await listWindows(s.port())).some((w) => !w.current && w.state === 'live' && w.session?.toLowerCase() === id),
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
        // the header's Stop window (⏻), as Settings → Windows stops another one: 0 tells a launcher to unregister and exit
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
        ...usageRoutes({ hub }),
        ...dictationRoutes({ hub }),
        ...cutRoutes({ hub, exporter: cutExporter, peaks: cutPeaks, reverse: cutReverse, root }),
        ...remoteRoutes({ hub, keeper: o.remote }),
        ...projectRoutes({ hub, port: () => s.port(), provider: agent.provider, ...(a.id === s.primaryId ? {} : { agent: a.id }), repoDir, ...(o.remote ? { computers: () => o.remote!.computers() } : {}) }),
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
      info: () => {
        const { id, root, title, model } = manager.info();
        // busy and clients: for another window's Settings → Windows; pending, last, replies: the phone's list
        return { agent: a.id, root, session: id, title, model, supervised: supervised(), codeChanged: codeChanged(), busy: manager.busy(), restartPending: restart.pending(), pending: manager.pending(), ...hub.summary(id ? readSeen(agent.stateDir)[id.toLowerCase()] ?? 0 : 0), clients: hub.clients(), icon: projectIcons.versionOrNull(root), agents: s.agents() };
      },
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

    const oneTab = o.oneTab ?? true;
    const graceMs = o.takeoverGraceMs ?? TAKEOVER_GRACE_MS;
    // the owner socket (R-M7-5); only used with oneTab. `alive`: false while a ping waits for its pong
    let owner: { ws: WebSocket; alive: boolean; tab: string | null; since: number } | null = null;
    const heartbeat = oneTab
      ? setInterval(() => {
        if (!owner) return;
        if (!owner.alive) { owner.ws.terminate(); return; } // the previous ping got no pong (R-M7-7)
        owner.alive = false;
        try { owner.ws.ping(); } catch { /* socket gone: its close handler follows */ }
      }, o.heartbeatMs ?? HEARTBEAT_MS)
      : null;
    heartbeat?.unref();
    undo.push(() => { if (heartbeat) clearInterval(heartbeat); });

    // the hello every socket gets, owner or not
    const sendHello = (ws: WebSocket) => {
      try {
        const { lang, uiScale, theme, whisper, dictationLang } = readPrefs(); // the user's UI language, scale and theme, shared by every window; absent until chosen
        ws.send(JSON.stringify({ kind: 'hello', protocol: PROTOCOL, capabilities: { ...caps, ffmpeg: cutExporter.available(), ...(whisper === true && whisperPhase() === 'ready' ? { dictation: 'whisper' as const } : {}) }, ...(lang ? { lang } : {}), ...(uiScale ? { uiScale } : {}), ...(theme ? { theme } : {}), ...(dictationLang ? { dictationLang } : {}), tmpDirs: tmpDirNames() }));
      } catch (e) {
        reportError(hub, 'hello', e);
      }
    };

    // the owner's wiring: replay (via the hub), state frames, hello. Returns nothing; the message handler is shared
    const attachOwner = (ws: WebSocket, tab: string | null) => {
      const hubDetach = hub.attach({ send: (d) => ws.send(d), buffered: () => ws.bufferedAmount });
      let detached = false;
      if (asksInPause.has(ws)) {
        askers.add(ws);
        ws.on('close', () => askers.delete(ws));
      }
      const detach = () => { if (!detached) { detached = true; hubDetach(); askers.delete(ws); } };
      detachers.set(ws, detach);
      if (oneTab) {
        const me = { ws, alive: true, tab, since: follows.has(ws) ? ++attaches : 0 };
        owner = me;
        ws.on('pong', () => { me.alive = true; });
      }
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
        if (owner?.ws === ws) owner = null;
        ownerGone.emit('gone');
      });
    };
    const detachers = new WeakMap<WebSocket, () => void>();
    const ownerGone = new EventEmitter();

    // the owner's messages
    const handleOwner = (ws: WebSocket, msg: ClientMessage) => {
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
            // the agent gets the ORIGINAL input back: a client never rewrites the input of an approved tool call
            manager.answer(msg.id, msg.allow, msg.response);
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

    // a newer socket takes the window (R-M7-5): the owner is told and closed with 4001, then the newcomer attaches as on a connect
    const takeover = (ws: WebSocket, tab: string | null) => {
      const old = owner;
      if (old) {
        owner = null;
        detachers.get(old.ws)?.(); // no more frames to it, not even those between now and its close
        try {
          old.ws.send(JSON.stringify({ kind: 'taken-over' }));
        } catch { /* already dying */ }
        role.set(old.ws, 'occupied'); // a message it already had in flight is not the owner's any more
        old.ws.close(TAKEN_OVER_CODE);
      }
      attachOwner(ws, tab);
      role.set(ws, 'owner');
    };
    const role = new WeakMap<WebSocket, 'pending' | 'occupied' | 'owner'>();
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
      // this page instance's id (in memory on the page): the same tab reconnecting after a drop is not a second tab
      const params = new URL(req.url ?? '/', 'http://x').searchParams;
      const tab = params.get('tab') || null;
      // a page that is occupied or taken reconnects passive: with no owner it must not win the window by being first
      // (a restart drops both tabs); it is told `occupied` and takes over only on the user's click
      const passive = params.get('passive') === '1';
      if (params.get('pause') === '1') asksInPause.add(ws);
      if (params.get('held') === '1') holds.add(ws);
      if (params.get('go') === '1') follows.add(ws);
      const conn = ++conns;
      audit?.write('ws-open', { conn, tab, passive });
      ws.on('close', (code) => audit?.write('ws-close', { conn, code }));
      ws.on('error', (e) => reportError(hub, 'ws', e));
      ws.on('message', guard(hub, 'ws', (data) => {
        const r = role.get(ws);
        if (r === 'pending') return; // still waiting out the grace: nothing it says counts yet
        const msg = parseClientMessage(String(data));
        if (r === 'occupied') {
          if (!('error' in msg) && msg.type === 'takeover') {
            audit?.write('client', { conn, type: 'takeover' });
            takeover(ws, tab);
          }
          return; // everything else from an occupied socket is ignored
        }
        if ('error' in msg) {
          reportError(hub, 'ws', msg.error);
          // a comment op that can never be applied: answered, so the client drops it instead of sending it forever (issue 494)
          if (msg.opId !== undefined) ws.send(JSON.stringify({ kind: 'comment-refused', opId: msg.opId, reason: 'invalid' }));
          return;
        }
        if (msg.type === 'takeover') return; // the owner has nothing to take
        audit?.client(msg, conn);
        handleOwner(ws, msg);
      }));
      if (oneTab && !passive && owner && tab !== null && owner.tab === tab) {
        // the owner's own reconnect (its old socket is a zombie the server has not noticed yet): out with the old, no grace
        const old = owner;
        owner = null;
        detachers.get(old.ws)?.();
        old.ws.terminate();
      }
      if (!oneTab || (!owner && !passive)) {
        role.set(ws, 'owner');
        attachOwner(ws, tab);
        return;
      }
      // an owner exists: a reloading tab's old socket closes within the grace, so wait before answering occupied (R-M7-6)
      role.set(ws, 'pending');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        clearTimeout(timer);
        ownerGone.off('gone', onGone);
        ws.off('close', onClose);
        if (ws.readyState !== ws.OPEN) return;
        if (!owner && !passive) {
          role.set(ws, 'owner');
          attachOwner(ws, tab);
          return;
        }
        role.set(ws, 'occupied');
        try {
          ws.send(JSON.stringify({ kind: 'occupied' }));
        } catch (e) {
          reportError(hub, 'occupied', e);
        }
        sendHello(ws);
      };
      const onGone = () => settle();
      const onClose = () => { clearTimeout(timer); ownerGone.off('gone', onGone); };
      ownerGone.on('gone', onGone);
      ws.on('close', onClose);
      timer = setTimeout(settle, graceMs);
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
      notPaused,
      askers: () => askers.size,
      owned: () => !!owner && owner.ws.readyState === owner.ws.OPEN,
      shownSince: () => (owner && owner.ws.readyState === owner.ws.OPEN ? owner.since : 0),
      show: (id) => {
        try {
          owner?.ws.send(JSON.stringify({ kind: 'open-agent', agent: id }));
        } catch (e) {
          reportError(hub, 'open-agent', e);
        }
      },
      restartChanged: (pending) => {
        hub.emit({ kind: 'restart-pending', pending }, { store: false });
        order.check(); // cancelled: what it held goes on
      },
      onSwitch: (fn) => manager.onSwitch((_id, { restart: same }) => fn(same)),
      freeze: () => turnMarks.freeze(),
      close,
    };
  } catch (e) {
    for (const f of undo.reverse()) { try { f(); } catch { /* the start's own error is the one to report */ } }
    hubs.delete(hub);
    throw e;
  }
}

/**
 * The server: one listener, login and process for its agents (epic 383). It starts with the agent of `o.cwd` and
 * `o.backend`, whose routes also answer at the top; `open` adds another, under `/a/<id>/` only.
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
    // a picture per project folder, shared by every provider's windows of it: the base state folder, never the project
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
      primaryId: launchAgentId(agent.provider, nonce),
      agents: () => [...agents.values()].map((x) => ({ id: x.id, provider: x.provider })),
      othersBusy: (id) => [...agents.values()].some((x) => x.id !== id && x.notPaused()),
      // each of the two feeds names the file (in its own folder's terms) and the other agent
      overlap: overlapWatch({
        found: ({ file, agents: pair }) => {
          for (const [me, other] of [pair, [pair[1], pair[0]]] as const) {
            const x = agents.get(me), y = agents.get(other);
            if (!x || !y) continue;
            const rel = path.relative(x.root(), file);
            x.hub.emit({ kind: 'edit-overlap', file: rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file, agent: y.id, provider: y.provider });
          }
        },
      }),
    };
    // the first agent: the window's, addressed as /a/<id>/ and at the top (the phone and older pages)
    const primary = await startAgent(s, {
      agent, id: s.primaryId, cwd: o.cwd, backend: o.backend,
      ...(o.resume ? { resume: o.resume } : {}), ...(o.fork ? { fork: true } : {}),
      ...(o.onStats ? { onStats: o.onStats } : {}), ...(o.onLimit ? { onLimit: o.onLimit } : {}),
    });
    agents.set(primary.id, primary);
    /** the request's agent, its prefix taken off `req.url`; undefined: no such agent */
    const agentOf = (req: http.IncomingMessage): Agent | undefined => {
      const p = agentPrefix(req.url ?? '/');
      if (!p) return primary;
      const found = agents.get(p.id);
      if (found) req.url = p.rest;
      return found;
    };
    /** the kept agents a relaunch is still reopening (below): a request for one waits, so a tab reloaded meanwhile gets its page */
    const reopening = new Map<string, Promise<void>>();
    const reopened = (req: http.IncomingMessage) => reopening.get(agentPrefix(req.url ?? '/')?.id ?? '');
    const server = http.createServer(function serve(req, res) {
      const found = agentOf(req);
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
      void primary.close(); // not awaited: the launcher waits for this exit (98), not for the backend's close
      throw e; // syscall 'listen': main exits with 98, the launcher's "port taken" code
    }

    // a listening server's own errors (a socket error before any request) are reported, never thrown out of its emit
    server.on('error', (e) => report('server', e));
    const port = (server.address() as AddressInfo).port;
    const stopFold = o.fold ? startFold({
      port, everyMs: o.fold.everyMs,
      quiet: () => agents.size === 1 && primary.hub.clients() === 0 && !primary.notPaused() && !restart.pending(),
      what: () => { const id = primary.session(); return { root: primary.root(), provider: primary.provider, ...(id ? { session: id } : {}) }; },
      attach: attachAgent,
      stop: () => { audit?.write('fold'); exitWith(0); }, // as Stop: the launcher unregisters the window
    }) : () => {};
    ownPort = port;
    if (audit) {
      audit.port = port;
      audit.write('server-start', { root: primary.root(), agent: agent.provider, node: process.version, supervised: supervised() });
    }
    // a supervised window keeps its registry entry's root current, so a relaunch reopens the folder it switched to
    primary.onSwitch((same) => {
      if (same || !supervised()) return;
      try {
        moveWindow(port, primary.root(), process.pid, process.ppid); // keeps the release it runs: prune must not remove it
      } catch (e) {
        reportError(primary.hub, 'windows', e);
      }
    });
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

    let closing: Promise<void> | null = null;
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
    /** another agent (epic 383): its own id, minted, under `/a/<id>/` only */
    /** the extra agents into `<port>.agents.json` (o.keep) */
    const keep = () => {
      if (!o.keep) return;
      try {
        const extra = [...agents.values()].filter((a) => a !== primary).map((a) => ({ id: a.id, provider: a.provider, root: a.root() }));
        writeKeptAgents(port, { ...(o.keep.launcherPid !== undefined ? { launcherPid: o.keep.launcherPid } : {}), nonce, agents: extra });
      } catch (e) {
        reportError(primary.hub, 'windows', e);
      }
    };
    const openAgent = async (x: { provider: AgentProvider; cwd: string; backend: AgentBackend; resume?: string; fork?: boolean; id?: string }): Promise<string> => {
      if (closing || exiting) throw new Error('the server is stopping');
      if (x.id !== undefined && agents.has(x.id)) throw new Error(`agent ${x.id} is open already`);
      let id = x.id ?? '';
      while (!id || agents.has(id)) id = newAgentId(x.provider);
      const added = await startAgent(s, { agent: agentContext(x.provider), id, cwd: x.cwd, backend: x.backend, ...(x.resume ? { resume: x.resume } : {}), ...(x.fork ? { fork: true } : {}) });
      if (closing || exiting) {
        await added.close(); // the close has already gone through the map: this one would outlive it
        throw new Error('the server is stopping');
      }
      agents.set(id, added);
      added.onSwitch((same) => { if (!same) keep(); });
      keep();
      return id;
    };
    // POST /control/open {root, provider?, mode?: 'resume' | 'new', session?, fork?, show?}: the agent of that folder and provider,
    // the one open unless a new or a named session is asked for. The launcher's way into a running server; `show: false`
    // (its --no-open) moves no tab
    s.controlOpen = async (body) => {
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
      if (!o.backends) return { status: 501, body: 'this server opens no other agents' };
      const target = launchTarget({ dir: root, resume: b.session as string | undefined, fork: b.fork === true, new: b.mode === 'new', native: provider !== 'claude' }, agentContext(provider).stateDir);
      const id = await openAgent({ provider, cwd: root, backend: o.backends(provider), ...target });
      return { status: 200, body: { agent: id, opened: true, ...shown(agents.get(id)!) } };
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
    // an agent beside the window's closes alone (the switcher's Close project); its session stays, its folder under Recent
    s.closeAgent = (id) => {
      const a = agents.get(id);
      if (!a || a === primary) return 409;
      agents.delete(id);
      s.overlap.forget(id);
      keep();
      void a.close();
      return 200;
    };
    // a relaunch of the same launch: the agents it had, each resuming its folder's last session; a fresh one starts with none
    const kept = o.keep ? readKeptAgents(port) : null;
    const same = kept && ((o.keep!.launcherPid !== undefined && kept.launcherPid === o.keep!.launcherPid) || kept.nonce === nonce);
    const backends = o.backends;
    const reopen = same && backends ? kept.agents : [];
    const settled = new Map(reopen.map((k) => [k.id, Promise.withResolvers<void>()]));
    for (const [id, p] of settled) reopening.set(id, p.promise);
    for (const k of reopen) {
      try {
        const provider = parseProvider(k.provider);
        if (!AGENT_ID.test(k.id) || !k.id.startsWith(`${provider}-`)) throw new Error(`not an agent id: ${k.id}`);
        if (!fs.statSync(k.root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`the folder of agent ${k.id} is gone: ${k.root}`);
        const target = launchTarget({ dir: k.root, native: provider !== 'claude' }, agentContext(provider).stateDir);
        await openAgent({ provider, cwd: k.root, backend: backends!(provider), id: k.id, ...target });
      } catch (e) {
        reportError(primary.hub, 'agents', e); // that one is dropped: its folder is gone, or its backend would not start
      } finally {
        reopening.delete(k.id);
        settled.get(k.id)!.resolve();
      }
    }
    keep();
    return { url: `http://127.0.0.1:${port}`, close: () => close!(), open: openAgent };
  } catch (e) {
    audit?.close();
    throw e;
  }
}
