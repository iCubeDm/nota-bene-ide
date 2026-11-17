// Files between the project and the computer (issue 461).
//   POST /attach-file?name=<file name>   any file, streamed into `<project>/attachments/` (made on demand; a clash gets
//                                        ` (2)`); answers `{path}`, the project-relative path the composer inserts
//   POST /os/reveal {path}               shows a project file or folder in Finder / Explorer / the folder on Linux
//   POST /os/open {path}                 opens a project file in its default app: document and media kinds only
// All three are key tier (auth.ts: every route is unless `cookieRoute` says otherwise). Reveal and Open act on this
// computer's desktop, so they are honoured only for a loopback peer without an Authorization header (the page). The phone
// relay always sends the window's helper Bearer (remote/device.ts), and its `goodPath` does not forward `/os/` at all;
// a helper or script with a Bearer is refused too. Commands are spawned without a shell, the real path as one argument.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { EventHub } from './hub.ts';
import { reportError } from './errors.ts';
import { resolveInRoot, UPLOAD_PREFIX } from './files.ts';
import { underState } from './stateGuard.ts';

export { UPLOAD_PREFIX };
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

// what Open may hand to the default app: documents and media whose app shows them rather than runs them. Not html or svg
// (a browser runs their script as file://), not code a launcher would run (js, py, sh, ...), not macro documents (docm, ...)
const DOCUMENTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'ico', 'psd',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'mid', 'midi',
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpg', 'mpeg',
  'pdf', 'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'ts', 'tsx', 'c', 'h', 'cc', 'cpp', 'hpp', 'rs', 'go', 'java', 'kt', 'swift', 'css', 'scss', 'sql', 'diff', 'patch',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key', 'epub',
  'glb', 'gltf', 'obj', 'stl', 'blend',
]);

/**
 * Open may hand this file to its default app: its kind is on the document list. On Windows trailing dots and spaces are
 * dropped first (the system drops them: `evil.exe.` is `evil.exe`) and a colon (an alternate data stream) is refused.
 */
export function openAllowed(file: string, platform: NodeJS.Platform): boolean {
  let name = (platform === 'win32' ? path.win32 : path.posix).basename(file);
  if (platform === 'win32') {
    name = name.replace(/[. ]+$/, '');
    if (name.includes(':')) return false;
  }
  const dot = name.lastIndexOf('.');
  return dot > 0 && DOCUMENTS.has(name.slice(dot + 1).toLowerCase());
}

/** The command that reveals or opens `abs` on `platform` (no shell: `cmd` and its arguments). */
export function osCommand(platform: NodeJS.Platform, action: 'reveal' | 'open', abs: string, isDir: boolean): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: action === 'reveal' ? ['-R', abs] : [abs] };
  // explorer takes `/select,<path>` as one argument
  if (platform === 'win32') {
    // explorer takes `/select,<path>` as one argument, but splits it at a comma: such a path opens its folder instead
    // (a comma in a folder above it can still confuse explorer; accepted)
    if (action === 'reveal') return { cmd: 'explorer.exe', args: [abs.includes(',') ? path.win32.dirname(abs) : `/select,${abs}`] };
    return { cmd: 'explorer.exe', args: [abs] };
  }
  // Linux has no common "select this file": the folder that holds it
  return { cmd: 'xdg-open', args: [action === 'reveal' && !isDir ? path.dirname(abs) : abs] };
}

/** the longest stored name in UTF-8 bytes: under the 255 of most file systems, with room for ` (9999)` */
const NAME_BYTES = 240;

/** The first code points of `s` that fit in `max` UTF-8 bytes (never half a character). */
function fitBytes(s: string, max: number): string {
  let out = '';
  let used = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (used + b > max) break;
    out += ch;
    used += b;
  }
  return out;
}

/** A file name to store an upload under: its last part, no control or reserved characters, at most 240 UTF-8 bytes. */
export function safeName(raw: string): string {
  let n = (raw.split(/[\\/]/).pop() ?? '').toWellFormed(); // a lone surrogate becomes U+FFFD
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  if (n === '' || n === '.' || n === '..') return 'file';
  if (Buffer.byteLength(n) > NAME_BYTES) {
    const ext = fitBytes(path.extname(n), 20);
    n = fitBytes(n.slice(0, n.length - path.extname(n).length), NAME_BYTES - Buffer.byteLength(ext)) + ext;
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

type Link = (from: string, to: string) => void;

/**
 * Moves the finished `tmp` to a free name in `dir`. A hard link refuses a taken name atomically. Any other link error
 * (FAT/exFAT answer EISDIR, some shares EPERM) while `tmp` is still there means no hard links: the name is then reserved
 * with an exclusive create and `tmp` renamed over it, so two uploads of one name still get two names.
 */
function settle(tmp: string, dir: string, name: string, link: Link): string {
  let links = true;
  for (let n = 1; n < 10_000; n++) {
    const want = candidate(name, n);
    const to = path.join(dir, want);
    if (links) {
      try {
        link(tmp, to);
        fs.rmSync(tmp, { force: true });
        return want;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        if (!fs.existsSync(tmp)) throw e;
        links = false;
      }
    }
    let fd: number;
    try {
      fd = fs.openSync(to, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    fs.closeSync(fd);
    try {
      renameRetry(tmp, to);
    } catch (e) {
      fs.rmSync(to, { force: true });
      throw e;
    }
    return want;
  }
  throw new Error('no free name');
}

const STALE_MS = 3600_000;

/** Temp files of uploads that never finished (a crash): removed once they are an hour old. */
function sweep(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(UPLOAD_PREFIX));
  } catch {
    return;
  }
  const before = Date.now() - STALE_MS;
  for (const n of names) {
    try {
      const f = path.join(dir, n);
      if (fs.lstatSync(f).mtimeMs < before) fs.rmSync(f, { force: true });
    } catch { /* gone meanwhile */ }
  }
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
  /** tests: the hard link uploads settle with (a file system without links) */
  link?: Link;
}): Record<string, RequestListener> {
  const link: Link = o.link ?? ((a, b) => fs.linkSync(a, b));
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
        // the real path, once: a symlink is judged, checked and opened as what it points at (README.pdf -> x.terminal)
        let real: string;
        let st: fs.Stats;
        try {
          real = fs.realpathSync.native(abs);
          st = fs.statSync(real);
        } catch {
          return json(res, 404, { error: 'not found' });
        }
        const realRoot = fs.realpathSync.native(o.root());
        if ((real !== realRoot && !real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)) || underState(real)) {
          return json(res, 403, { error: 'outside project' });
        }
        // a folder (an .app bundle among them), an executable file or a kind not on the document list is not opened
        if (action === 'open' && (!st.isFile() || !openAllowed(real, platform) || (platform !== 'win32' && (st.mode & 0o111) !== 0))) {
          return json(res, 403, { error: 'refused' });
        }
        const { cmd, args } = osCommand(platform, action, real, st.isDirectory());
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
          try {
            fs.mkdirSync(dir, { recursive: true });
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e;
          }
          if (!fs.statSync(dir).isDirectory()) {
            req.resume();
            return json(res, 409, { error: 'attachments-not-folder' });
          }
          // made now: the realpath check again, so a folder swapped for a symlink after the first one is still refused
          if (resolveInRoot(o.root(), ATTACH_DIR) === null) {
            req.resume();
            return json(res, 403, { error: 'outside project' });
          }
          sweep(dir);
          // beside its final name (one file system, so the link or rename is a move); its prefix keeps it out of the tree
          tmp = path.join(dir, `${UPLOAD_PREFIX}${randomBytes(6).toString('hex')}`);
          let size = 0;
          const cap = new Transform({
            transform(chunk: Buffer, _enc, done) {
              size += chunk.length;
              done(size > max ? new TooLarge() : null, chunk);
            },
          });
          const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o644 });
          const shut = new Promise<void>((r) => out.once('close', () => r()));
          // the page went away mid-body: destroying `cap` settles the pipeline and closes the file
          const onClose = () => { if (!req.complete) cap.destroy(Object.assign(new Error('aborted'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })); };
          req.once('close', onClose);
          // the request is piped in by hand: a refusal mid-body unpipes it and drains the rest, so the 413 can still be read
          req.pipe(cap);
          try {
            await pipeline(cap, out);
          } catch (e) {
            req.unpipe(cap);
            req.resume();
            out.destroy();
            await shut; // the fd is closed before the temp file is removed
            throw e;
          } finally {
            req.off('close', onClose);
          }
          const name = settle(tmp, dir, safeName(raw), link);
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
