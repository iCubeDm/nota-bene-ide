import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';
import { MAX_ICON_BYTES, ProjectIconStore, projectIconRoutes, sniffIcon } from './projectIcon.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('body-a')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('body-b')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-icon-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('sniffIcon', () => {
  it('knows png, jpeg and webp by their first bytes, nothing else', () => {
    expect(sniffIcon(PNG)).toBe('image/png');
    expect(sniffIcon(JPG)).toBe('image/jpeg');
    expect(sniffIcon(WEBP)).toBe('image/webp');
    expect(sniffIcon(Buffer.from('GIF89a....'))).toBeNull();
    expect(sniffIcon(Buffer.from('<svg xmlns=""></svg>'))).toBeNull();
    expect(sniffIcon(Buffer.alloc(0))).toBeNull();
  });
});

describe('ProjectIconStore', () => {
  it('keeps one picture per root, in its own folder, and never inside the project', () => {
    const s = new ProjectIconStore({ dir });
    expect(s.get('/p/one')).toBeNull();
    expect(s.version('/p/one')).toBeNull();
    const v = s.put('/p/one', PNG, 'image/png');
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(s.version('/p/one')).toBe(v);
    expect(s.get('/p/one')).toEqual({ bytes: PNG, mediaType: 'image/png', version: v });
    expect(s.get('/p/two')).toBeNull();
    // the file name is a hash of the root, not the path
    expect(fs.readdirSync(dir).every((f) => !f.includes('one'))).toBe(true);
  });

  it('a new picture replaces the old one (one file left) and changes the version', () => {
    const s = new ProjectIconStore({ dir });
    const a = s.put('/p', PNG, 'image/png');
    const b = s.put('/p', JPG, 'image/jpeg');
    expect(b).not.toBe(a);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect(s.get('/p')?.mediaType).toBe('image/jpeg');
  });

  it('remove deletes it, and removing nothing is fine', () => {
    const s = new ProjectIconStore({ dir });
    s.put('/p', WEBP, 'image/webp');
    s.remove('/p');
    expect(s.version('/p')).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(() => s.remove('/p')).not.toThrow();
  });
});

describe('ProjectIconStore robustness', () => {
  it.runIf(process.platform === 'win32')('versionOrNull: a folder that cannot be read is no icon, not an error (Windows: simulated EACCES)', () => {
    const s = new ProjectIconStore({ dir });
    s.put('/p', PNG, 'image/png');
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    try {
      expect(() => s.version('/p')).toThrow(/EACCES/);
      expect(s.versionOrNull('/p')).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  // macOS and Linux keep the JS realpath key, as before Windows support
  it.runIf(process.platform === 'win32')('Windows: the key is the native real path: another spelling of the case of the same folder finds the icon', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-icon-root-'));
    try {
      const s = new ProjectIconStore({ dir });
      const v = s.put(root, PNG, 'image/png');
      expect(s.version(fs.realpathSync.native(root))).toBe(v);
      const other = path.join(path.dirname(root), path.basename(root).toUpperCase());
      if (fs.existsSync(other)) expect(s.version(other)).toBe(v);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Windows: chmod 000 does not make a folder unreadable (variant above)
  it.skipIf(process.platform === 'win32')('versionOrNull: a folder that cannot be read is no icon, not an error', () => {
    const s = new ProjectIconStore({ dir });
    s.put('/p', PNG, 'image/png');
    fs.chmodSync(dir, 0o000);
    try {
      expect(() => s.version('/p')).toThrow();
      expect(s.versionOrNull('/p')).toBeNull();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('put sweeps stale temp files of a crashed write and keeps a fresh one', () => {
    const s = new ProjectIconStore({ dir });
    s.put('/p', PNG, 'image/png');
    const stale = path.join(dir, `${'a'.repeat(64)}.0123456789abcdef.png.tmp1-x`);
    const fresh = path.join(dir, `${'b'.repeat(64)}.0123456789abcdef.png.tmp2-y`);
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    s.put('/p', JPG, 'image/jpeg');
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('a put removes only versions that are not newer than its own (another process may have written a later one)', () => {
    const s = new ProjectIconStore({ dir });
    const a = s.put('/p', PNG, 'image/png');
    const file = fs.readdirSync(dir)[0]!;
    // a later picture of another process appears, newer than what the next put will write
    const later = file.replace(a, 'f'.repeat(16)).replace(/\.png$/, '.jpg');
    fs.writeFileSync(path.join(dir, later), JPG);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, later), future, future);
    s.put('/p', WEBP, 'image/webp');
    expect(fs.existsSync(path.join(dir, later))).toBe(true);
    expect(fs.existsSync(path.join(dir, file))).toBe(false);
    // and the newest one is what is served
    expect(s.version('/p')).toBe('f'.repeat(16));
  });

  it('the key is the realpath of the root: a symlinked path finds the same picture', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    const link = path.join(dir, 'link');
    fs.symlinkSync(real, link);
    const s = new ProjectIconStore({ dir: path.join(dir, 'icons') });
    const v = s.put(real, PNG, 'image/png');
    expect(s.version(link)).toBe(v);
    // a root that does not exist keeps its own path as the key
    expect(s.put('/no/such/root', JPG, 'image/jpeg')).toBe(s.version('/no/such/root'));
  });
});

describe('project icon route', () => {
  let server: http.Server;
  let base: string;
  let root: string;
  let store: ProjectIconStore;
  beforeEach(async () => {
    root = '/p/current';
    store = new ProjectIconStore({ dir: path.join(dir, 'icons') });
    const hosts: string[] = [];
    const origins: string[] = [];
    const hub = new EventHub();
    server = http.createServer(httpHandler({
      hub, webDist: dir, info: () => ({}), allowedHosts: hosts, allowedOrigins: origins,
      extra: projectIconRoutes({ store, root: () => root, hub }),
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    hosts.push(`127.0.0.1:${port}`);
    origins.push(base);
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const put = (body: Buffer, type: string) =>
    fetch(`${base}/project-icon`, { method: 'PUT', headers: { 'content-type': type, origin: base }, body: new Uint8Array(body) });

  it('PUT stores the current window\'s icon and answers its version; GET serves it with the version as etag', async () => {
    const r = await put(PNG, 'image/png');
    expect(r.status).toBe(200);
    const { icon } = (await r.json()) as { icon: string };
    expect(store.version('/p/current')).toBe(icon);
    const g = await fetch(`${base}/project-icon`);
    expect(g.status).toBe(200);
    expect(g.headers.get('content-type')).toBe('image/png');
    expect(g.headers.get('etag')).toBe(`"${icon}"`);
    expect(g.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await g.arrayBuffer())).toEqual(PNG);
    const again = await fetch(`${base}/project-icon`, { headers: { 'if-none-match': `"${icon}"` } });
    expect(again.status).toBe(304);
  });

  it('the icon belongs to the folder: another root has none', async () => {
    await put(PNG, 'image/png');
    root = '/p/other';
    expect((await fetch(`${base}/project-icon`)).status).toBe(404);
  });

  it('GET without an icon is 404', async () => {
    expect((await fetch(`${base}/project-icon`)).status).toBe(404);
  });

  it('415 for a type that is not png, jpeg or webp, and when the bytes are not what the type says', async () => {
    expect((await put(Buffer.from('GIF89a'), 'image/gif')).status).toBe(415);
    expect((await put(Buffer.from('<svg/>'), 'image/svg+xml')).status).toBe(415);
    expect((await put(JPG, 'image/png')).status).toBe(415);
    expect((await put(Buffer.from('not an image'), 'image/png')).status).toBe(415);
    expect(store.version('/p/current')).toBeNull();
  });

  it('413 above the cap, also for a chunked body, and nothing is stored', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_ICON_BYTES)]);
    expect((await put(big, 'image/png')).status).toBe(413);
    const chunk = new Uint8Array(64 * 1024);
    let n = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (n++ < 6) c.enqueue(chunk); else c.close(); } });
    const r = await fetch(`${base}/project-icon`, { method: 'PUT', headers: { 'content-type': 'image/png', origin: base }, body, duplex: 'half' } as RequestInit);
    expect(r.status).toBe(413);
    expect(store.version('/p/current')).toBeNull();
  });

  it('DELETE removes it (204, also when there is none)', async () => {
    await put(PNG, 'image/png');
    const d = await fetch(`${base}/project-icon`, { method: 'DELETE', headers: { origin: base } });
    expect(d.status).toBe(204);
    expect(store.version('/p/current')).toBeNull();
    expect((await fetch(`${base}/project-icon`, { method: 'DELETE', headers: { origin: base } })).status).toBe(204);
  });

  it('405 for other methods', async () => {
    const r = await fetch(`${base}/project-icon`, { method: 'POST', headers: { origin: base }, body: 'x' });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET, HEAD, PUT, DELETE');
  });

  it('a disk error gives 500 and the server keeps serving', async () => {
    fs.writeFileSync(path.join(dir, 'icons'), 'a file where the store folder should be');
    expect((await put(PNG, 'image/png')).status).toBe(500);
    expect((await fetch(`${base}/project-icon`)).status).toBe(404);
  });
});
