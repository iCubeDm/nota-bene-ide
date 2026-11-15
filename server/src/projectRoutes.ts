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
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';
import { HIDDEN } from './platform.ts';
import { enterUrl, listProjects, PROVIDERS } from './projects.ts';
import { readRecent } from './recent.ts';
import { stateBaseDir } from './state.ts';
import { readJson } from './system.ts';

/** Runs the launcher with `args`; resolves to its exit code and the first line it printed. */
export type Launch = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; firstLine: string }>;
export type Agents = () => Promise<{ agents: AgentProvider[]; default: AgentProvider }>;

const LAUNCH_MS = 30_000;
const MAX_DIRS = 500;
/** What a launcher this server started must not inherit: they describe this server's own launch. */
const LAUNCH_STATE = ['NOTA_BENE_SUPERVISED', 'NOTA_BENE_LAUNCHER_PID', 'NOTA_BENE_NONCE', 'NOTA_BENE_AGENT', 'NOTA_BENE_INNER', 'NOTA_BENE_LOCKED',
  'NOTA_BENE_AUTOPORT', 'NOTA_BENE_HANDOVER', 'NOTA_BENE_HANDOVER_NONCE', 'NOTA_BENE_UPDATED_FROM'];
const OPENED = /^(?:opened|already-open) (http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64})$/;

export function launchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of LAUNCH_STATE) delete out[k];
  return out;
}

/** A folder name the starter may create: one path segment, no NUL, no edge spaces, at most 255 bytes. */
export function validName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name)
    && name.trim() === name && Buffer.byteLength(name, 'utf8') <= 255;
}

const isProvider = (p: unknown): p is AgentProvider => (PROVIDERS as unknown[]).includes(p);

function launcherOf(repoDir: string): Launch {
  const bin = path.join(repoDir, 'bin', 'nota-bene.mjs');
  return (args, env) => new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], ...HIDDEN });
    let out = '', err = '';
    p.stdout.on('data', (d: Buffer) => { if (out.length < 8192) out += d; });
    p.stderr.on('data', (d: Buffer) => { if (err.length < 8192) err += d; });
    const timer = setTimeout(() => { p.kill(); resolve({ code: -1, firstLine: 'the launcher did not answer in time' }); }, LAUNCH_MS);
    const first = (s: string) => s.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, firstLine: e.message }); });
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, firstLine: first(out) || first(err) }); });
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
  /** the checkout or package the server runs from: its launcher starts the new windows */
  repoDir: string;
  launch?: Launch;
  agents?: Agents;
}): Record<string, RequestListener> {
  const launch = o.launch ?? launcherOf(o.repoDir);
  const agents = o.agents ?? defaultAgents();
  const warned = new Set<string>();
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
    // never echo a line that carries a login: an unexpected success line is a failure without its text
    text(res, 502, r.firstLine && !r.firstLine.includes('#t=') ? r.firstLine : `the launcher exited with ${r.code}`);
  };

  return {
    '/system/projects': (req, res) => {
      if (!only('GET', req, res)) return;
      const warn = (m: string) => { if (!warned.has(m)) { warned.add(m); reportError(o.hub, '/system/projects', new Error(m)); } };
      listProjects({ port: o.port(), provider: o.provider }, undefined, warn).then((l) => json(res, 200, l), (e) => fail(res, '/system/projects', e));
    },

    '/system/projects/enter': post('/system/projects/enter', async (b, res) => {
      if (!isProvider(b.provider) || !Number.isInteger(b.port) || typeof b.root !== 'string') return text(res, 400, 'bad request');
      const r = await enterUrl({ provider: b.provider, port: b.port as number, root: b.root });
      if ('url' in r) return json(res, 200, r);
      text(res, r.error === 'no such window' ? 404 : 409, r.error);
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
      json(res, 200, { path: dir, parent: parent === dir ? null : parent, home: os.homedir(), dirs });
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
