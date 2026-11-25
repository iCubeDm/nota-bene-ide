import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fakeBackend } from './agent/fake.ts';
import { attachAgent } from './attach.ts';
import { accessToken, proofFor } from './auth.ts';
import { controlToken } from './system.ts';
import { registerWindow } from './windows.ts';
import { launchServer } from './testing.ts';

// The launcher's attach (epic 383, step 2c): a folder opens as an agent of the running server.

let tmp: string;
const prev = { home: process.env.NOTA_BENE_HOME, agent: process.env.NOTA_BENE_AGENT };
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-attach-')));
  for (const d of ['home', 'dist', 'a', 'b']) fs.mkdirSync(path.join(tmp, d));
  fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = path.join(tmp, 'home');
  process.env.NOTA_BENE_AGENT = 'claude';
  controlToken();
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  for (const [k, v] of [['NOTA_BENE_HOME', prev.home], ['NOTA_BENE_AGENT', prev.agent]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function server(): Promise<number> {
  const s = await launchServer({
    cwd: path.join(tmp, 'a'), port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist'),
    backends: () => fakeBackend([]),
  });
  closers.push(s.close);
  const port = Number(new URL(s.url).port);
  registerWindow(port, path.join(tmp, 'a'), process.pid);
  return port;
}

it('no running server: null', async () => {
  expect(await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume' })).toBeNull();
});

it('an older server (no /control/open: 404) is passed over', async () => {
  const token = accessToken();
  const old = http.createServer((req, res) => {
    const m = /^\/hello\?c=([0-9a-f]+)$/.exec(req.url ?? '');
    if (m) res.setHeader('content-type', 'application/json').end(JSON.stringify({ proof: proofFor(token, port, 'f0'.repeat(16), m[1]!), n: 'f0'.repeat(16) }));
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => old.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise((r) => old.close(() => r())));
  const port = (old.address() as { port: number }).port;
  registerWindow(port, path.join(tmp, 'a'), process.pid);
  expect(await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume' })).toBeNull();
});

it('opens the folder as an agent of the running server, then finds it there', async () => {
  const port = await server();
  const first = await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume' });
  expect(first).toMatchObject({ port, opened: true, shown: false });
  expect(first!.agent).toMatch(/^codex-[a-z2-7]{6}$/);
  expect(first!.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/a/${first!.agent}/#t=[0-9a-f]{64}$`));
  const again = await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume' });
  expect(again).toMatchObject({ port, agent: first!.agent, opened: false });
});

it('a tab of the server shows the agent (shown): the launcher opens no browser', async () => {
  const token = accessToken();
  const srv = http.createServer((req, res) => {
    const m = /^\/hello\?c=([0-9a-f]+)$/.exec(req.url ?? '');
    if (m) res.setHeader('content-type', 'application/json').end(JSON.stringify({ proof: proofFor(token, port, 'f0'.repeat(16), m[1]!), n: 'f0'.repeat(16) }));
    else if (req.url === '/control/open') res.setHeader('content-type', 'application/json').end(JSON.stringify({ agent: 'codex-abcdef', opened: true, shown: true }));
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const port = (srv.address() as { port: number }).port;
  registerWindow(port, path.join(tmp, 'a'), process.pid);
  expect(await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume' })).toMatchObject({ port, agent: 'codex-abcdef', opened: true, shown: true });
});

it('port: only that server is asked; another one opens nothing', async () => {
  const port = await server();
  expect(await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume', port: port + 1 })).toBeNull();
  expect(await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume', under: port })).toBeNull();
  expect(await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume', port })).toMatchObject({ port, opened: true });
});

it('a refused ask (no such folder) throws', async () => {
  await server();
  await expect(attachAgent({ root: path.join(tmp, 'gone'), provider: 'codex', mode: 'resume' })).rejects.toThrow(/no such folder/);
});
