// The project switcher's and the starter's routes (phase 1): the projects list, the move to another window, the folder
// picker, the installed agents, and opening or creating a folder in a new window.
//
// A new window is started the way a terminal does it: this server runs its own launcher (`bin/nota-bene.mjs --detach
// --no-open`), which prints one line, `opened URL` or `already-open URL`, the URL carrying the window's login. That line goes
// only into the answer to the page; neither it nor the launcher's other output is ever logged or reported.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { defaultChoice, detectAgents } from './agent/choice.ts';
import type { AgentProvider } from './agent/provider.ts';
import { isSessionId } from '@nota-bene/shared';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';
import { HIDDEN } from './platform.ts';
import { enterUrl, listProjects, PROVIDERS, remoteRows, sessionsOf, stopAt, stopOthers, type Computer } from './projects.ts';
import { forgetRecent, readRecent } from './recent.ts';
import { AGENT_ID, stateBaseDir } from './state.ts';
import { readJson } from './system.ts';

/** Runs the launcher with `args`; resolves to its exit code and the first line it printed. */
export type Launch = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; firstLine: string }>;
export type Agents = () => Promise<{ agents: AgentProvider[]; default: AgentProvider }>;

const LAUNCH_MS = 30_000;
const STILL_STARTING = 'still starting';
const MAX_DIRS = 500;
/** What a launcher this server started must not inherit: they describe this server's own launch. */
const LAUNCH_STATE = ['NOTA_BENE_SUPERVISED', 'NOTA_BENE_LAUNCHER_PID', 'NOTA_BENE_NONCE', 'NOTA_BENE_AGENT', 'NOTA_BENE_INNER', 'NOTA_BENE_LOCKED',
  'NOTA_BENE_AUTOPORT', 'NOTA_BENE_HANDOVER', 'NOTA_BENE_HANDOVER_NONCE', 'NOTA_BENE_UPDATED_FROM',
  'NOTA_BENE_PLUGIN_VERSION']; // issue 457: a window opened from the projects rail was not opened by /nb
// an agent of the running server (epic 383) is under its /a/<id>/
const OPENED = /^(?:opened|already-open) (http:\/\/127\.0\.0\.1:\d+\/(?:a\/[a-z]+-[a-z2-7]{6}\/)?#t=[0-9a-f]{64})$/;

export function launchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of LAUNCH_STATE) delete out[k];
  return out;
}

/**
 * A folder name the starter may create: one path segment, no edge spaces, at most 255 bytes, and nothing Windows refuses
 * (its reserved characters and device names, control characters, a trailing dot), on every system, so a project moves.
 */
export function validName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[/\\:*?"<>|\x00-\x1f]/.test(name)
    && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) && !name.endsWith('.')
    && name.trim() === name && Buffer.byteLength(name, 'utf8') <= 255;
}

const isProvider = (p: unknown): p is AgentProvider => (PROVIDERS as unknown[]).includes(p);

/**
 * The launcher of `repoDir`. Its line is read to the end of its stdout ('close', not 'exit': the output may still be in
 * flight when the process ends). A launch slower than `waitMs` (a rebuild, a lock wait) is left running: its window comes
 * up by itself and shows under Running; killing it would stop only the launcher in front, not its detached child.
 */
export function launcherOf(repoDir: string, waitMs = LAUNCH_MS): Launch {
  const bin = path.join(repoDir, 'bin', 'nota-bene.mjs');
  return (args, env) => new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], ...HIDDEN });
    let out = '', err = '';
    p.stdout.on('data', (d: Buffer) => { if (out.length < 8192) out += d; });
    p.stderr.on('data', (d: Buffer) => { if (err.length < 8192) err += d; });
    const timer = setTimeout(() => {
      p.stdout.destroy();
      p.stderr.destroy();
      p.unref();
      resolve({ code: -1, firstLine: STILL_STARTING });
    }, waitMs);
    const first = (s: string) => s.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, firstLine: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, firstLine: first(out) || first(err) }); });
  });
}

function defaultAgents(): Agents {
  let found: Promise<AgentProvider[]> | null = null;
  return async () => {
    found ??= detectAgents(process.env).then((f) => f.filter((x) => !x.tooOld).map((x) => x.agent));
    const agents = await found;
    if (agents.length === 0) return { agents, default: 'claude' };
    const last = readRecent(stateBaseDir()).find((e) => agents.includes(e.provider))?.provider;
    return { agents, default: defaultChoice(agents, last) };
  };
}

const RECENT_PLACES = 5;
const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** The starter's places: home, Desktop when it is a folder, then the parents of recent projects (newest first, once each). */
function places(): { path: string; kind: 'home' | 'desktop' | 'recent' }[] {
  const home = os.homedir();
  const out: { path: string; kind: 'home' | 'desktop' | 'recent' }[] = [{ path: home, kind: 'home' }];
  const desktop = path.join(home, 'Desktop');
  if (isDir(desktop)) out.push({ path: desktop, kind: 'desktop' });
  const seen = new Set(out.map((p) => p.path));
  let n = 0;
  for (const e of readRecent(stateBaseDir())) {
    const parent = path.dirname(e.root);
    if (n >= RECENT_PLACES || seen.has(parent) || parent === e.root || !isDir(parent)) continue;
    seen.add(parent);
    out.push({ path: parent, kind: 'recent' });
    n++;
  }
  return out;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}
const only = (method: string, req: IncomingMessage, res: ServerResponse): boolean => {
  if (req.method === method || (method === 'GET' && req.method === 'HEAD')) return true;
  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: method === 'GET' ? 'GET, HEAD' : method });
  res.end('method not allowed');
  return false;
};
const badBody = (e: unknown) => e instanceof SyntaxError || (e instanceof Error && e.message === 'body too large');

export function projectRoutes(o: {
  hub: EventHub;
  /** this server's port (known after listen) */
  port: () => number;
  provider: AgentProvider;
  /** epic 383: this agent's id when it is not the window's own (its rows are told apart by it) */
  agent?: string;
  /** the checkout or package the server runs from: its launcher starts the new windows */
  repoDir: string;
  launch?: Launch;
  agents?: Agents;
  /** issue 297: the paired computers online and their windows (the connector's, remote/keeper.ts); none when absent */
  computers?: () => Promise<Computer[]>;
}): Record<string, RequestListener> {
  const launch = o.launch ?? launcherOf(o.repoDir);
  const agents = o.agents ?? defaultAgents();
  const warned = new Set<string>();
  const own = () => ({ port: o.port(), provider: o.provider, ...(o.agent ? { agent: o.agent } : {}) });
  /** a row of the list as the page sends it back: a window, or an agent with its id; null for anything else */
  const rowOf = (b: Record<string, unknown>) => {
    if (!isProvider(b.provider) || !Number.isInteger(b.port) || typeof b.root !== 'string') return null;
    if (b.agent !== undefined && (typeof b.agent !== 'string' || !AGENT_ID.test(b.agent))) return null;
    return { provider: b.provider, port: b.port as number, root: b.root, ...(b.agent ? { agent: b.agent as string } : {}) };
  };
  const fail = (res: ServerResponse, where: string, e: unknown) => {
    reportError(o.hub, where, e);
    if (!res.headersSent) text(res, 500, 'internal error');
  };
  /** POST routes: the body as an object, or 400; errors go to the hub under `where` */
  const post = (where: string, handle: (b: Record<string, unknown>, res: ServerResponse) => Promise<void>): RequestListener => (req, res) => {
    if (!only('POST', req, res)) return;
    void readJson(req).then((b) => handle(b as Record<string, unknown>, res)).catch((e: unknown) => (badBody(e) ? text(res, 400, 'bad request') : fail(res, where, e)));
  };
  const open = async (res: ServerResponse, dir: string, provider: AgentProvider, fresh: boolean) => {
    const r = await launch([dir, '--agent', provider, ...(fresh ? ['--new'] : []), '--detach', '--no-open'], launchEnv(process.env));
    const m = r.code === 0 ? OPENED.exec(r.firstLine) : null;
    if (m) return json(res, 200, { url: m[1] });
    if (r.code === -1 && r.firstLine === STILL_STARTING) return text(res, 504, STILL_STARTING);
    // never echo a line that carries a login: an unexpected success line is a failure without its text
    text(res, 502, r.firstLine && !r.firstLine.includes('#t=') ? r.firstLine : `the launcher exited with ${r.code}`);
  };

  return {
    '/system/projects': (req, res) => {
      if (!only('GET', req, res)) return;
      const warn = (m: string) => { if (!warned.has(m)) { warned.add(m); reportError(o.hub, '/system/projects', new Error(m)); } };
      // a paired computer that cannot be asked (no connector, a broken hosts.json) lists nothing, as one offline
      const computers = (o.computers?.() ?? Promise.resolve([])).catch(() => []);
      Promise.all([listProjects(own(), undefined, warn), computers])
        .then(([l, c]) => json(res, 200, { ...l, running: [...l.running, ...remoteRows(c)] }), (e) => fail(res, '/system/projects', e));
    },

    '/system/projects/enter': post('/system/projects/enter', async (b, res) => {
      const w = rowOf(b);
      if (!w) return text(res, 400, 'bad request');
      // a session id, or `new`: the page there starts a new session (web landing.ts)
      if (b.session !== undefined && b.session !== 'new' && !isSessionId(b.session)) return text(res, 400, 'bad request');
      const r = await enterUrl({ ...w, ...(b.session ? { session: b.session } : {}) });
      if ('url' in r) return json(res, 200, r);
      text(res, r.error === 'no such window' ? 404 : 409, r.error);
    }),

    '/system/projects/sessions': post('/system/projects/sessions', async (b, res) => {
      const w = rowOf(b);
      if (!w) return text(res, 400, 'bad request');
      const r = await sessionsOf(w);
      if (!('error' in r)) return json(res, 200, r);
      text(res, r.error === 'no such window' ? 404 : 409, r.error);
    }),

    // a project's window from the list; this window's own stop is POST /stop (its header)
    '/system/projects/stop': post('/system/projects/stop', async (b, res) => {
      const w = rowOf(b);
      if (!w) return text(res, 400, 'bad request');
      // this page's server stops from its header; any of its agents closes from here, this page's own too (issue 639)
      if (w.port === o.port() && !w.agent) return text(res, 409, 'this window');
      const r = await stopAt(w);
      if ('ok' in r) return json(res, 200, r);
      text(res, r.error === 'no such window' ? 404 : r.error === 'refused' ? 502 : 409, r.error);
    }),

    // the header's Stop Nota Bene: every other window first, then the page stops this one (POST /stop)
    '/system/projects/stop-others': (req, res) => {
      if (!only('POST', req, res)) return;
      stopOthers(own()).then((r) => json(res, 200, r), (e) => fail(res, '/system/projects/stop-others', e));
    },

    // a folder out of Recent (✕ on its row); launching it again brings it back (recent.ts)
    '/system/projects/forget': post('/system/projects/forget', async (b, res) => {
      if (typeof b.root !== 'string' || !path.isAbsolute(b.root)) return text(res, 400, 'bad request');
      forgetRecent(stateBaseDir(), b.root);
      json(res, 200, { ok: true });
    }),

    '/system/agents': (req, res) => {
      if (!only('GET', req, res)) return;
      agents().then((a) => json(res, 200, a), (e) => fail(res, '/system/agents', e));
    },

    '/system/folders': post('/system/folders', async (b, res) => {
      const p = b.path === undefined ? os.homedir() : b.path;
      if (typeof p !== 'string' || !path.isAbsolute(p)) return text(res, 400, 'bad request');
      const dir = path.resolve(p);
      let entries: fs.Dirent[];
      try {
        if (!fs.statSync(dir).isDirectory()) return text(res, 404, 'not a folder');
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return text(res, 404, 'not a folder');
        if (code === 'EACCES' || code === 'EPERM') return text(res, 403, 'not readable');
        throw e;
      }
      const isDir = (d: fs.Dirent) => {
        if (d.isDirectory()) return true;
        if (!d.isSymbolicLink()) return false;
        try {
          return fs.statSync(path.join(dir, d.name)).isDirectory();
        } catch {
          return false;
        }
      };
      const dirs = entries
        .filter((d) => (b.hidden === true || !d.name.startsWith('.')) && isDir(d))
        .map((d) => ({ name: d.name, git: fs.existsSync(path.join(dir, d.name, '.git')) }))
        .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }))
        .slice(0, MAX_DIRS);
      const parent = path.dirname(dir);
      json(res, 200, { path: dir, parent: parent === dir ? null : parent, home: os.homedir(), dirs, places: places() });
    }),

    '/system/projects/open': post('/system/projects/open', async (b, res) => {
      if (typeof b.dir !== 'string' || !path.isAbsolute(b.dir) || !isProvider(b.provider)) return text(res, 400, 'bad request');
      await open(res, path.resolve(b.dir), b.provider, b.new === true);
    }),

    '/system/projects/create': post('/system/projects/create', async (b, res) => {
      if (typeof b.parent !== 'string' || !path.isAbsolute(b.parent) || !validName(b.name) || !isProvider(b.provider)) return text(res, 400, 'bad request');
      const dir = path.join(path.resolve(b.parent), b.name);
      try {
        fs.mkdirSync(dir);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return text(res, 409, 'exists');
        if (code === 'ENOENT' || code === 'ENOTDIR') return text(res, 404, 'not a folder');
        if (code === 'EACCES' || code === 'EPERM') return text(res, 403, 'not writable');
        throw e;
      }
      if (b.git === true) {
        const ok = await new Promise<boolean>((resolve) => execFile('git', ['init', '-q'], { cwd: dir, timeout: 10_000, ...HIDDEN }, (e) => resolve(!e)));
        if (!ok) return text(res, 502, 'git init failed');
      }
      await open(res, dir, b.provider, true);
    }),
  };
}
