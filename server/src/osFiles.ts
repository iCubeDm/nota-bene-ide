// Files between the project and the computer (issue 461).
//   POST /attach-file?name=<file name>   any file, streamed into `<project>/attachments/` (made on demand; a clash gets
//                                        ` (2)`); answers `{path}`, the project-relative path the composer inserts
//   POST /os/reveal {path}               shows a project file or folder in Finder / Explorer / the folder on Linux
//   POST /os/open {path}                 opens a project file in its default app; executables, scripts and bundles refused
// All three are key tier (auth.ts: every route is unless `cookieRoute` says otherwise). Reveal and Open act on this
// computer's desktop, so they are honoured only for the page on this machine: a loopback peer without a Bearer. The phone
// relay always sends the window's helper Bearer (remote/device.ts), and its `goodPath` does not forward `/os/` at all.
// Commands are spawned without a shell, the path as one argument.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { EventHub } from './hub.ts';
import { reportError } from './errors.ts';
import { resolveInRoot } from './files.ts';
import { renameRetry } from './platform.ts';

/** a generous cap for one file (a long video): the body is streamed to disk, never held */
export const MAX_FILE_BYTES = 8 * 1024 ** 3;
const ATTACH_DIR = 'attachments';

type Spawner = (cmd: string, args: string[]) => void;

/** Runs a desktop command detached, without a shell; a missing command is reported, never thrown. */
function defaultSpawn(onError: (e: unknown) => void): Spawner {
  return (cmd, args) => {
    const child = nodeSpawn(cmd, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    child.on('error', onError);
    child.unref();
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The page on this machine: a loopback peer that did not authenticate with a Bearer (the relay and helpers do). */
export function fromThisMachine(req: Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string | undefined } }): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? '') && req.headers.authorization === undefined;
}

// what a double click would run rather than show: programs, scripts, installers, bundles, shortcuts that point elsewhere
const RUNS = new Set([
  'app', 'command', 'tool', 'terminal', 'workflow', 'action', 'scpt', 'scptd', 'applescript', 'osax', 'prefpane', 'pkg', 'mpkg', 'kext',
  'sh', 'bash', 'zsh', 'csh', 'tcsh', 'ksh', 'fish', 'py', 'pyw', 'pyc', 'pl', 'rb', 'php', 'jar', 'js', 'jse', 'mjs', 'cjs',
  'exe', 'com', 'bat', 'cmd', 'msi', 'msp', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh', 'scr', 'pif', 'cpl', 'hta', 'reg', 'lnk', 'url', 'inf',
  'webloc', 'inetloc', 'fileloc', 'desktop', 'appimage', 'run', 'bin', 'out',
]);

/** Open refuses this name: its extension runs something. */
export function openRefused(name: string): boolean {
  const ext = path.extname(name).slice(1).toLowerCase();
  return RUNS.has(ext);
}

/** The command that reveals or opens `abs` on `platform` (no shell: `cmd` and its arguments). */
export function osCommand(platform: NodeJS.Platform, action: 'reveal' | 'open', abs: string, isDir: boolean): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: action === 'reveal' ? ['-R', abs] : [abs] };
  // explorer takes `/select,<path>` as one argument
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [action === 'reveal' ? `/select,${abs}` : abs] };
  // Linux has no common "select this file": the folder that holds it
  return { cmd: 'xdg-open', args: [action === 'reveal' && !isDir ? path.dirname(abs) : abs] };
}

/** A file name to store an upload under: its last part, no control or reserved characters, at most 200 characters. */
export function safeName(raw: string): string {
  let n = raw.split(/[\\/]/).pop() ?? '';
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  if (n === '' || n === '.' || n === '..') return 'file';
  if (n.length > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n;
}

/** `name`, then `stem (2).ext`, `stem (3).ext`, ... */
function candidate(name: string, n: number): string {
  if (n === 1) return name;
  const ext = path.extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${stem} (${n})${ext && ext !== name ? ext : ''}`;
}

const NO_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS']);

/** Moves the finished `tmp` to a free name in `dir`: a hard link refuses a taken name atomically; without links, a check and a rename. */
function settle(tmp: string, dir: string, name: string): string {
  for (let n = 1; n < 10_000; n++) {
    const want = candidate(name, n);
    const to = path.join(dir, want);
    try {
      fs.linkSync(tmp, to);
      fs.rmSync(tmp, { force: true });
      return want;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') continue;
      if (!NO_LINKS.has(code)) throw e;
      if (fs.existsSync(to)) continue;
      renameRetry(tmp, to);
      return want;
    }
  }
  throw new Error('no free name');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > 64 * 1024) return null;
    chunks.push(c);
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

class TooLarge extends Error {}

export function osFileRoutes(o: {
  root: () => string;
  hub: EventHub;
  /** tests: the platform whose commands are used, and a spawner that records instead of opening Finder */
  platform?: NodeJS.Platform;
  spawn?: Spawner;
  maxBytes?: number;
}): Record<string, RequestListener> {
  const platform = o.platform ?? process.platform;
  const max = o.maxBytes ?? MAX_FILE_BYTES;
  const run = o.spawn ?? defaultSpawn((e) => reportError(o.hub, 'os', e));
  const fail = (req: IncomingMessage, res: ServerResponse, e: unknown) => {
    reportError(o.hub, (req.url ?? '').split('?')[0]!, e);
    if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    else res.destroy();
  };

  const desktop = (action: 'reveal' | 'open'): RequestListener => (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (!fromThisMachine(req)) {
      req.resume();
      return json(res, 403, { error: 'local-only' });
    }
    void (async () => {
      try {
        const b = await jsonBody(req);
        if (!b || typeof b.path !== 'string' || !b.path) return json(res, 400, { error: 'bad request' });
        const abs = resolveInRoot(o.root(), b.path);
        if (abs === null) return json(res, 403, { error: 'outside project' });
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          return json(res, 404, { error: 'not found' });
        }
        // a folder (an .app bundle among them) or an executable file would run or browse rather than open a document
        if (action === 'open' && (!st.isFile() || openRefused(abs) || (platform !== 'win32' && (st.mode & 0o111) !== 0))) {
          return json(res, 403, { error: 'refused' });
        }
        const { cmd, args } = osCommand(platform, action, abs, st.isDirectory());
        run(cmd, args);
        json(res, 200, { ok: true });
      } catch (e) {
        fail(req, res, e);
      }
    })();
  };

  return {
    '/attach-file': (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const raw = new URL(req.url ?? '/', 'http://x').searchParams.get('name');
      if (!raw) {
        req.resume();
        return json(res, 400, { error: 'name required' });
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > max) {
        req.resume();
        return json(res, 413, { error: 'file too large' });
      }
      const dir = resolveInRoot(o.root(), ATTACH_DIR);
      if (dir === null) {
        req.resume();
        return json(res, 403, { error: 'outside project' });
      }
      void (async () => {
        let tmp: string | null = null;
        try {
          fs.mkdirSync(dir, { recursive: true });
          // made now: the realpath check again, so a folder swapped for a symlink after the first one is still refused
          if (resolveInRoot(o.root(), ATTACH_DIR) === null || !fs.statSync(dir).isDirectory()) {
            req.resume();
            return json(res, 403, { error: 'outside project' });
          }
          tmp = path.join(dir, `.nb-upload-${randomBytes(6).toString('hex')}`);
          let size = 0;
          const cap = new Transform({
            transform(chunk: Buffer, _enc, done) {
              size += chunk.length;
              done(size > max ? new TooLarge() : null, chunk);
            },
          });
          // the request is piped in by hand: a refusal mid-body unpipes it and drains the rest, so the 413 can still be read
          const closed = new Promise<never>((_, reject) => req.once('aborted', () => reject(Object.assign(new Error('aborted'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }))));
          closed.catch(() => {});
          req.pipe(cap);
          try {
            await Promise.race([pipeline(cap, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o644 })), closed]);
          } catch (e) {
            req.unpipe(cap);
            req.resume();
            throw e;
          }
          const name = settle(tmp, dir, safeName(raw));
          tmp = null;
          json(res, 200, { path: `${ATTACH_DIR}/${name}` });
        } catch (e) {
          if (e instanceof TooLarge) {
            setTimeout(() => { if (!req.complete) req.destroy(); }, 2000).unref();
            if (!res.headersSent) json(res, 413, { error: 'file too large' });
          } else if ((e as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE' || req.destroyed) {
            res.destroy(); // the page cancelled the upload
          } else fail(req, res, e);
        } finally {
          if (tmp) fs.rmSync(tmp, { force: true });
        }
      })();
    },
    '/os/reveal': desktop('reveal'),
    '/os/open': desktop('open'),
  };
}
