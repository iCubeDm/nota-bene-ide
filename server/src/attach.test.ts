import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fakeBackend } from './agent/fake.ts';
import { attachAgent } from './attach.ts';
import { startServer } from './server.ts';
import { controlToken } from './system.ts';
import { registerWindow } from './windows.ts';

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

async function server(opensAgents: boolean): Promise<number> {
  const s = await startServer({
    cwd: path.join(tmp, 'a'), port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist'),
    ...(opensAgents ? { backends: () => fakeBackend([]) } : {}),
  });
  closers.push(s.close);
  const port = Number(new URL(s.url).port);
  registerWindow(port, path.join(tmp, 'a'), process.pid);
  return port;
}

it('no running server: null', async () => {
  expect(await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume' })).toBeNull();
});

it('a server that opens no other agents is passed over', async () => {
  await server(false);
  expect(await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume' })).toBeNull();
});

it('opens the folder as an agent of the running server, then finds it there', async () => {
  const port = await server(true);
  const first = await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume' });
  expect(first).toMatchObject({ port, opened: true });
  expect(first!.agent).toMatch(/^codex-[a-z2-7]{6}$/);
  expect(first!.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/a/${first!.agent}/#t=[0-9a-f]{64}$`));
  const again = await attachAgent({ root: path.join(tmp, 'b'), provider: 'codex', mode: 'resume' });
  expect(again).toMatchObject({ port, agent: first!.agent, opened: false });
});

it('a refused ask (no such folder) throws', async () => {
  await server(true);
  await expect(attachAgent({ root: path.join(tmp, 'gone'), provider: 'codex', mode: 'resume' })).rejects.toThrow(/no such folder/);
});
