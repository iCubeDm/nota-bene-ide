import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';
import { fromThisMachine, openAllowed, osCommand, osFileRoutes, safeName, UPLOAD_PREFIX } from './osFiles.ts';
import { listDir } from './files.ts';

let dir: string;
let root: string;
let rootNow: string;
let server: http.Server;
let port: number;
let origin: string;
const spawned: { cmd: string; args: string[] }[] = [];
// the hard link the upload settles with: a test swaps it for a file system without links
let link: (from: string, to: string) => void = (a, b) => fs.linkSync(a, b);
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
  fs.writeFileSync(path.join(root, 'payload.terminal'), 'x');
  fs.symlinkSync('payload.terminal', path.join(root, 'README.pdf'));
  fs.writeFileSync(path.join(root, 'page.html'), '<script></script>');
  fs.writeFileSync(path.join(root, 'report.pdf'), '%PDF');
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.writeFileSync(path.join(dir, 'outside', 'secret.txt'), 's');
  fs.symlinkSync(path.join(dir, 'outside'), path.join(root, 'escape'));
  server = http.createServer(httpHandler({
    hub: new EventHub(), webDist: dir, allowedHosts, allowedOrigins, info: () => ({}),
    extra: osFileRoutes({ root: () => rootNow, hub: new EventHub(), platform: 'darwin', spawn: (cmd, args) => void spawned.push({ cmd, args }), maxBytes: 64, link: (a, b) => link(a, b) }),
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

beforeEach(() => { spawned.length = 0; link = (a, b) => fs.linkSync(a, b); });
const temps = () => fs.readdirSync(path.join(root, 'attachments')).filter((n) => n.startsWith(UPLOAD_PREFIX));

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

  it('an upload the page aborts mid-body leaves no temp file behind (the write stream is closed and removed)', async () => {
    const before = fs.readdirSync(path.join(root, 'attachments')).sort();
    await new Promise<void>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/attach-file?name=cut.bin', headers: { origin, 'content-length': '60' } });
      r.on('error', () => resolve());
      r.write(Buffer.alloc(20));
      setTimeout(() => { r.destroy(); resolve(); }, 50);
    });
    await expect.poll(() => fs.readdirSync(path.join(root, 'attachments')).sort(), { timeout: 2000 }).toEqual(before);
  });

  it('two uploads of one name at once get two names', async () => {
    const [a, b] = await Promise.all([call('/attach-file?name=twin.txt', 'a'), call('/attach-file?name=twin.txt', 'b')]);
    expect(new Set([a.json?.path, b.json?.path])).toEqual(new Set(['attachments/twin.txt', 'attachments/twin (2).txt']));
  });

  it('without hard links (FAT/exFAT answers EISDIR): a name is reserved exclusively, then the upload renamed over it', async () => {
    link = () => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }); };
    const [a, b] = await Promise.all([call('/attach-file?name=fat.txt', 'one'), call('/attach-file?name=fat.txt', 'two')]);
    expect(new Set([a.json?.path, b.json?.path])).toEqual(new Set(['attachments/fat.txt', 'attachments/fat (2).txt']));
    const got = [fs.readFileSync(path.join(root, 'attachments', 'fat.txt'), 'utf8'), fs.readFileSync(path.join(root, 'attachments', 'fat (2).txt'), 'utf8')];
    expect(got.sort()).toEqual(['one', 'two']);
    expect(temps()).toEqual([]);
  });

  it('a temp file is not listed in the tree; a stale one (over an hour old) is swept by the next upload', async () => {
    const stale = path.join(root, 'attachments', `${UPLOAD_PREFIX}old`);
    const fresh = path.join(root, 'attachments', `${UPLOAD_PREFIX}new`);
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    const old = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(stale, old, old);
    expect((await listDir(path.join(root, 'attachments'), root)).map((e) => e.name).filter((n) => n.startsWith(UPLOAD_PREFIX))).toEqual([]);
    await call('/attach-file?name=sweep.txt', 'x');
    expect(temps()).toEqual([`${UPLOAD_PREFIX}new`]);
    fs.rmSync(fresh);
  });

  it('a file named attachments: 409 with its own code', async () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-osfiles-root-')));
    fs.writeFileSync(path.join(other, 'attachments'), 'x');
    rootNow = other;
    try {
      const r = await call('/attach-file?name=x.txt', 'x');
      expect(r.status).toBe(409);
      expect(r.json?.error).toBe('attachments-not-folder');
    } finally {
      rootNow = root;
      fs.rmSync(other, { recursive: true, force: true });
    }
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

  it('open: a document opens in its default app; anything not on the list of document kinds is refused (reveal still works)', async () => {
    expect((await post('/os/open', 'docs/notes.md')).status).toBe(200);
    expect(spawned).toEqual([{ cmd: 'open', args: [path.join(root, 'docs', 'notes.md')] }]);
    for (const p of ['run.sh', 'tool', 'Some.app', 'docs', 'page.html', 'payload.terminal']) {
      const r = await post('/os/open', p);
      expect(r.status, p).toBe(403);
      expect(r.json?.error, p).toBe('refused');
    }
    expect(spawned).toHaveLength(1);
    expect((await post('/os/reveal', 'run.sh')).status).toBe(200);
  });

  it('open: a symlink is judged and opened by what it points at (README.pdf -> payload.terminal is refused)', async () => {
    const r = await post('/os/open', 'README.pdf');
    expect(r.status).toBe(403);
    expect(r.json?.error).toBe('refused');
    expect(spawned).toEqual([]);
    fs.symlinkSync('report.pdf', path.join(root, 'alias.pdf'));
    expect((await post('/os/open', 'alias.pdf')).status).toBe(200);
    expect(spawned).toEqual([{ cmd: 'open', args: [path.join(root, 'report.pdf')] }]);
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
    // explorer splits `/select,` at a comma: such a path opens its folder instead
    expect(osCommand('win32', 'reveal', 'C:\\p,q\\a.txt', false)).toEqual({ cmd: 'explorer.exe', args: ['C:\\p,q'] });
    expect(osCommand('win32', 'reveal', 'C:\\p\\a,b', true)).toEqual({ cmd: 'explorer.exe', args: ['C:\\p'] });
    expect(osCommand('linux', 'reveal', '/p/a.txt', false)).toEqual({ cmd: 'xdg-open', args: ['/p'] });
    expect(osCommand('linux', 'reveal', '/p/dir', true)).toEqual({ cmd: 'xdg-open', args: ['/p/dir'] });
    expect(osCommand('linux', 'open', '/p/a.txt', false)).toEqual({ cmd: 'xdg-open', args: ['/p/a.txt'] });
  });

  it('openAllowed: documents and media only; programs, scripts, pages that run script, unknown kinds refused', () => {
    for (const n of ['a.md', 'a.pdf', 'a.mp4', 'a.png', 'a.txt', 'a.json', 'a.csv', 'a.docx', 'a.xlsx', 'a.pptx', 'a.odt', 'a.rtf', 'a.pages', 'a.key', 'a.mp3', 'a.ts', 'A.PDF']) {
      expect(openAllowed(n, 'darwin'), n).toBe(true);
    }
    for (const n of ['a.app', 'a.command', 'a.sh', 'a.exe', 'a.bat', 'a.ps1', 'a.jar', 'a.py', 'a.js', 'a.terminal', 'a.html', 'a.svg', 'a.zip', 'a.docm', 'Makefile', 'a.weird']) {
      expect(openAllowed(n, 'darwin'), n).toBe(false);
    }
  });

  it('openAllowed on Windows: trailing dots and spaces are dropped first, and a colon (a stream) is refused', () => {
    expect(openAllowed('evil.exe.', 'win32')).toBe(false);
    expect(openAllowed('evil.exe. . ', 'win32')).toBe(false);
    expect(openAllowed('note.txt.', 'win32')).toBe(true);
    expect(openAllowed('note.txt:evil.exe', 'win32')).toBe(false);
    expect(openAllowed('C:\\p\\note.txt', 'win32')).toBe(true);
  });

  it('safeName: the last part, no control or reserved characters, never empty or a dot name', () => {
    expect(safeName('a/b/c.txt')).toBe('c.txt');
    expect(safeName('a\\b\\c.txt')).toBe('c.txt');
    expect(safeName('..')).toBe('file');
    expect(safeName('')).toBe('file');
    expect(safeName('x\u0000y:z?.txt')).toBe('x_y_z_.txt');
    expect(safeName('.env')).toBe('.env');
    const bytes = (x: string) => Buffer.byteLength(x);
    for (const ch of ['a', 'Я', '文', '😀']) {
      const n = safeName(ch.repeat(300) + '.txt');
      expect(bytes(n), ch).toBeLessThanOrEqual(240);
      expect(n.endsWith('.txt'), ch).toBe(true);
      expect(n.isWellFormed(), ch).toBe(true);
      expect(n.startsWith(ch.repeat(10)), ch).toBe(true);
    }
    expect(safeName('a\ud800b.txt')).toBe('a\ufffdb.txt');
  });
});
