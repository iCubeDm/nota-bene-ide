import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';
import { fromThisMachine, openRefused, osCommand, osFileRoutes, safeName } from './osFiles.ts';

let dir: string;
let root: string;
let rootNow: string;
let server: http.Server;
let port: number;
let origin: string;
const spawned: { cmd: string; args: string[] }[] = [];
const allowedHosts: string[] = [];
const allowedOrigins: string[] = [];

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-osfiles-')));
  root = path.join(dir, 'proj');
  rootNow = root;
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'notes.md'), 'n');
  fs.writeFileSync(path.join(root, 'run.sh'), 'echo');
  fs.writeFileSync(path.join(root, 'tool'), 'x');
  fs.chmodSync(path.join(root, 'tool'), 0o755);
  fs.mkdirSync(path.join(root, 'Some.app'));
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.writeFileSync(path.join(dir, 'outside', 'secret.txt'), 's');
  fs.symlinkSync(path.join(dir, 'outside'), path.join(root, 'escape'));
  server = http.createServer(httpHandler({
    hub: new EventHub(), webDist: dir, allowedHosts, allowedOrigins, info: () => ({}),
    extra: osFileRoutes({ root: () => rootNow, hub: new EventHub(), platform: 'darwin', spawn: (cmd, args) => void spawned.push({ cmd, args }), maxBytes: 64 }),
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  allowedHosts.push(`127.0.0.1:${port}`);
  allowedOrigins.push(origin);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => { spawned.length = 0; });

async function call(p: string, body: string | Uint8Array, headers: Record<string, string> = {}) {
  const r = await fetch(`${origin}${p}`, { method: 'POST', headers: { origin, ...headers }, body: body as BodyInit });
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, json: json as Record<string, unknown> | null, text };
}
const post = (route: string, rel: unknown, headers: Record<string, string> = {}) =>
  call(route, JSON.stringify({ path: rel }), { 'content-type': 'application/json', ...headers });

describe('POST /attach-file: any file, streamed into <project>/attachments/', () => {
  it('writes the body under its name, makes the folder, and answers the project-relative path', async () => {
    const r = await call('/attach-file?name=' + encodeURIComponent('clip one.mp3'), Buffer.from('abc'));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ path: 'attachments/clip one.mp3' });
    expect(fs.readFileSync(path.join(root, 'attachments', 'clip one.mp3'), 'utf8')).toBe('abc');
  });

  it('a name clash gets " (2)", then " (3)", before the extension', async () => {
    const a = await call('/attach-file?name=same.zip', 'one');
    const b = await call('/attach-file?name=same.zip', 'two');
    const c = await call('/attach-file?name=same.zip', 'three');
    expect([a.json?.path, b.json?.path, c.json?.path]).toEqual(['attachments/same.zip', 'attachments/same (2).zip', 'attachments/same (3).zip']);
    expect(fs.readFileSync(path.join(root, 'attachments', 'same (2).zip'), 'utf8')).toBe('two');
  });

  it('a path in the name keeps only its last part; no name is a 400', async () => {
    const r = await call('/attach-file?name=' + encodeURIComponent('../../evil.txt'), 'x');
    expect(r.json).toEqual({ path: 'attachments/evil.txt' });
    expect(fs.existsSync(path.join(dir, 'evil.txt'))).toBe(false);
    expect((await call('/attach-file', 'x')).status).toBe(400);
  });

  it('over the limit: 413 and nothing is left behind', async () => {
    const before = fs.readdirSync(path.join(root, 'attachments')).sort();
    const r = await call('/attach-file?name=big.bin', Buffer.alloc(200));
    expect(r.status).toBe(413);
    expect(fs.readdirSync(path.join(root, 'attachments')).sort()).toEqual(before);
  });

  it('over the limit while streaming (no length given): 413, nothing left behind', async () => {
    const before = fs.readdirSync(path.join(root, 'attachments')).sort();
    const body = new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(20)); c.close(); } });
    const r = await fetch(`${origin}/attach-file?name=stream.bin`, { method: 'POST', headers: { origin }, body, duplex: 'half' } as RequestInit);
    expect(r.status).toBe(413);
    await new Promise((res) => setTimeout(res, 50));
    expect(fs.readdirSync(path.join(root, 'attachments')).sort()).toEqual(before);
  });

  it('an attachments folder that is a symlink out of the project is refused', async () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-osfiles-root-')));
    fs.symlinkSync(path.join(dir, 'outside'), path.join(other, 'attachments'));
    rootNow = other;
    try {
      expect((await call('/attach-file?name=x.txt', 'x')).status).toBe(403);
      expect(fs.existsSync(path.join(dir, 'outside', 'x.txt'))).toBe(false);
    } finally {
      rootNow = root;
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('POST /os/reveal and /os/open', () => {
  it('reveal: `open -R <absolute path>` without a shell, for a file or a folder', async () => {
    expect((await post('/os/reveal', 'docs/notes.md')).status).toBe(200);
    expect((await post('/os/reveal', 'docs')).status).toBe(200);
    expect(spawned).toEqual([
      { cmd: 'open', args: ['-R', path.join(root, 'docs', 'notes.md')] },
      { cmd: 'open', args: ['-R', path.join(root, 'docs')] },
    ]);
  });

  it('open: a document opens in its default app; executables, scripts and bundles are refused (reveal still works)', async () => {
    expect((await post('/os/open', 'docs/notes.md')).status).toBe(200);
    expect(spawned).toEqual([{ cmd: 'open', args: [path.join(root, 'docs', 'notes.md')] }]);
    for (const p of ['run.sh', 'tool', 'Some.app', 'docs']) {
      const r = await post('/os/open', p);
      expect(r.status, p).toBe(403);
      expect(r.json?.error, p).toBe('refused');
    }
    expect(spawned).toHaveLength(1);
    expect((await post('/os/reveal', 'run.sh')).status).toBe(200);
  });

  it('confined to the project like /file: outside, through a symlink, absolute, missing', async () => {
    for (const p of ['../outside/secret.txt', 'escape/secret.txt', path.join(dir, 'outside', 'secret.txt')]) {
      expect((await post('/os/reveal', p)).status, p).toBe(403);
    }
    expect((await post('/os/reveal', 'nope.txt')).status).toBe(404);
    expect((await post('/os/reveal', 42)).status).toBe(400);
    expect(spawned).toEqual([]);
  });

  it('a Bearer request (the phone relay, a helper) is refused: only the page on this machine', async () => {
    const r = await post('/os/reveal', 'docs/notes.md', { authorization: 'Bearer x' });
    expect(r.status).toBe(403);
    expect(r.json?.error).toBe('local-only');
    expect(spawned).toEqual([]);
  });

  it('GET is not allowed', async () => {
    expect((await fetch(`${origin}/os/reveal`)).status).toBe(405);
  });
});

describe('helpers', () => {
  it('fromThisMachine: a loopback peer without a Bearer', () => {
    const r = (address: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: address }, headers }) as never;
    expect(fromThisMachine(r('127.0.0.1'))).toBe(true);
    expect(fromThisMachine(r('::1'))).toBe(true);
    expect(fromThisMachine(r('::ffff:127.0.0.1'))).toBe(true);
    expect(fromThisMachine(r('192.168.1.5'))).toBe(false);
    expect(fromThisMachine(r('127.0.0.1', { authorization: 'Bearer abc' }))).toBe(false);
  });

  it('osCommand per platform', () => {
    expect(osCommand('darwin', 'reveal', '/p/a.txt', false)).toEqual({ cmd: 'open', args: ['-R', '/p/a.txt'] });
    expect(osCommand('darwin', 'open', '/p/a.txt', false)).toEqual({ cmd: 'open', args: ['/p/a.txt'] });
    expect(osCommand('win32', 'reveal', 'C:\\p\\a.txt', false)).toEqual({ cmd: 'explorer.exe', args: ['/select,C:\\p\\a.txt'] });
    expect(osCommand('win32', 'open', 'C:\\p\\a.txt', false)).toEqual({ cmd: 'explorer.exe', args: ['C:\\p\\a.txt'] });
    expect(osCommand('linux', 'reveal', '/p/a.txt', false)).toEqual({ cmd: 'xdg-open', args: ['/p'] });
    expect(osCommand('linux', 'reveal', '/p/dir', true)).toEqual({ cmd: 'xdg-open', args: ['/p/dir'] });
    expect(osCommand('linux', 'open', '/p/a.txt', false)).toEqual({ cmd: 'xdg-open', args: ['/p/a.txt'] });
  });

  it('openRefused: executables, scripts, bundles, links; documents and media pass', () => {
    for (const n of ['a.app', 'a.command', 'a.sh', 'a.exe', 'a.bat', 'a.cmd', 'a.ps1', 'a.msi', 'a.jar', 'a.py', 'a.scpt', 'a.workflow', 'a.webloc', 'a.desktop', 'A.EXE', 'a.lnk', 'a.vbs', 'a.js']) {
      expect(openRefused(n), n).toBe(true);
    }
    for (const n of ['a.md', 'a.pdf', 'a.mp4', 'a.png', 'a.zip', 'a.txt', 'a.json', 'Makefile']) expect(openRefused(n), n).toBe(false);
  });

  it('safeName: the last part, no control or reserved characters, never empty or a dot name', () => {
    expect(safeName('a/b/c.txt')).toBe('c.txt');
    expect(safeName('a\\b\\c.txt')).toBe('c.txt');
    expect(safeName('..')).toBe('file');
    expect(safeName('')).toBe('file');
    expect(safeName('x\u0000y:z?.txt')).toBe('x_y_z_.txt');
    expect(safeName('.env')).toBe('.env');
    expect(safeName('a'.repeat(300) + '.txt').length).toBeLessThanOrEqual(200);
    expect(safeName('a'.repeat(300) + '.txt').endsWith('.txt')).toBe(true);
  });
});
