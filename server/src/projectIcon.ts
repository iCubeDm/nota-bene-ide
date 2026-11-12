import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { reportError } from './errors.ts';
import { renameRetry } from './platform.ts';
import type { EventHub } from './hub.ts';
import { readCapped, refuseTooLarge } from './attachments.ts';

// A picture per project folder, set from the phone: the phone resizes to 256x256 before it uploads, so this cap is generous.
export const MAX_ICON_BYTES = 256 * 1024;

export type IconType = 'image/png' | 'image/jpeg' | 'image/webp';
const EXT: Record<IconType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const TYPE_OF_EXT: Record<string, IconType> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** The image type of [b] from its first bytes (png, jpeg, webp), else null: the declared type is never trusted. */
export function sniffIcon(b: Buffer): IconType | null {
  const at = (i: number, m: number[]) => b.length >= i + m.length && m.every((x, k) => b[i + k] === x);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

const missing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');

/**
 * `<dir>/<sha256 of the root>.<version>.<ext>`: the version (the first 16 hex of the picture's hash) is in the name, so the
 * window list can carry it without reading a file. The folder is in the state directory, never in the project.
 */
export class ProjectIconStore {
  private readonly dir: string;

  constructor(o: { dir: string }) {
    this.dir = o.dir;
  }

  /** The hash of the root's native real path (so a symlinked path or another spelling of the case is the same folder),
   *  else of the path as given. */
  private key(root: string): string {
    let real = root;
    try {
      real = fs.realpathSync.native(root);
    } catch { /* a root that is gone: its own path */ }
    return createHash('sha256').update(real).digest('hex');
  }

  private files(root: string): string[] {
    const prefix = `${this.key(root)}.`;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((f) => f.startsWith(prefix) && /^[0-9a-f]{64}\.[0-9a-f]{16}\.(png|jpg|webp)$/.test(f));
    } catch (e) {
      if (missing(e)) return [];
      throw e;
    }
    // newest first: if two processes wrote at once, the later picture is the one served
    return names
      .map((f) => ({ f, t: this.mtime(f) }))
      .sort((x, y) => y.t - x.t || (x.f < y.f ? -1 : 1))
      .map((x) => x.f);
  }

  private mtime(f: string): number {
    try {
      return fs.statSync(path.join(this.dir, f)).mtimeMs;
    } catch {
      return 0; // removed meanwhile
    }
  }

  /** Temp files of a write that never finished (a crash between write and rename), an hour old or more. */
  private sweep(): void {
    const old = Date.now() - 60 * 60 * 1000;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const f of names) if (f.includes('.tmp') && this.mtime(f) < old) fs.rmSync(path.join(this.dir, f), { force: true });
  }

  /** The picture's version, or null when the folder has none. */
  version(root: string): string | null {
    const f = this.files(root)[0];
    return f ? f.split('.')[1]! : null;
  }

  /** For `/info`, which must not fail because the folder cannot be read. */
  versionOrNull(root: string): string | null {
    try {
      return this.version(root);
    } catch {
      return null;
    }
  }

  get(root: string): { bytes: Buffer; mediaType: IconType; version: string } | null {
    const f = this.files(root)[0];
    if (!f) return null;
    const [, version, ext] = f.split('.') as [string, string, string];
    const mediaType = TYPE_OF_EXT[ext];
    if (!mediaType) return null;
    try {
      return { bytes: fs.readFileSync(path.join(this.dir, f)), mediaType, version };
    } catch (e) {
      if (missing(e)) return null; // removed between the listing and the read
      throw e;
    }
  }

  /** Replaces the folder's picture; returns its version. */
  put(root: string, bytes: Buffer, mediaType: IconType): string {
    const version = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const name = `${this.key(root)}.${version}.${EXT[mediaType]}`;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, `${name}.tmp${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      renameRetry(tmp, path.join(this.dir, name));
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    this.sweep();
    // only pictures not newer than ours: a later one of another process stays
    const ours = this.mtime(name);
    for (const f of this.files(root)) if (f !== name && this.mtime(f) <= ours) fs.rmSync(path.join(this.dir, f), { force: true });
    return version;
  }

  remove(root: string): void {
    for (const f of this.files(root)) fs.rmSync(path.join(this.dir, f), { force: true });
  }
}

function plain(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * `/project-icon` (protocol 15), key tier like every route: GET/HEAD the picture of the window's project folder (404 when
 * none, the version as its ETag), PUT raw png/jpeg/webp bytes (answers `{icon: version}`), DELETE (204, idempotent).
 * The window list (`/info.icon`) carries the version, so the phone and any other client notice a change on the next poll.
 */
export function projectIconRoutes(o: { store: ProjectIconStore; root: () => string; hub?: EventHub }): Record<string, RequestListener> {
  const fail = (req: IncomingMessage, res: ServerResponse, e: unknown) => {
    if (o.hub) reportError(o.hub, req.url ?? '/project-icon', e);
    if (!res.headersSent) plain(res, 500, e instanceof Error ? e.message : String(e));
    else res.destroy();
  };
  return {
    '/project-icon': (req, res) => {
      const method = req.method ?? '';
      try {
        if (method === 'GET' || method === 'HEAD') {
          const found = o.store.get(o.root());
          if (!found) return plain(res, 404, 'not found');
          const etag = `"${found.version}"`;
          const headers = {
            etag,
            'cache-control': 'private, no-cache',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "sandbox; default-src 'none'",
            'cross-origin-resource-policy': 'same-origin',
          };
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, headers);
            return void res.end();
          }
          res.writeHead(200, { 'content-type': found.mediaType, 'content-length': found.bytes.length, ...headers });
          return void res.end(method === 'HEAD' ? undefined : found.bytes);
        }
        if (method === 'DELETE') {
          o.store.remove(o.root());
          res.writeHead(204);
          return void res.end();
        }
        if (method !== 'PUT') return plain(res, 405, 'method not allowed', { allow: 'GET, HEAD, PUT, DELETE' });
      } catch (e) {
        return fail(req, res, e);
      }
      const declared = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (!(declared in EXT)) return plain(res, 415, 'unsupported media type');
      void (async () => {
        try {
          const bytes = await readCapped(req, MAX_ICON_BYTES);
          if (bytes === null) return refuseTooLarge(req, res, 'icon too large');
          if (sniffIcon(bytes) !== declared) return plain(res, 415, 'the bytes are not the declared image type');
          const icon = o.store.put(o.root(), bytes, declared as IconType);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ icon }));
        } catch (e) {
          fail(req, res, e);
        }
      })();
    },
  };
}
