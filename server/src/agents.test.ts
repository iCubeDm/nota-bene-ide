import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import { startServer } from './server.ts';

// Several agents in one server (epic 383, step 2c): each its own folder, session, socket and one-tab rule; the top is the
// first one's, as a window's is today.

let tmp: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-agents-')));
  for (const d of ['home', 'dist', 'a', 'b']) fs.mkdirSync(path.join(tmp, d));
  fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = path.join(tmp, 'home');
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function socket(url: string): Promise<{ ws: WebSocket; events: ServerEvent[] }> {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`);
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  closers.push(async () => { ws.terminate(); });
  await until(() => events.some((e) => e.kind === 'hello'));
  return { ws, events };
}

const json = async (url: string) => (await fetch(url)).json() as Promise<{ agent: string; root: string }>;

it('a second agent has its own folder, socket, session and tab; the top stays the first one\'s', async () => {
  const one = fakeBackend([{ text: 'from a' }]);
  const two = fakeBackend([{ text: 'from b' }]);
  let closedTwo = false;
  two.close = async () => { closedTwo = true; };
  const s = await startServer({ insecureNoAuth: true, cwd: path.join(tmp, 'a'), port: 0, backend: one, webDist: path.join(tmp, 'dist') });
  closers.push(s.close);
  const b = await s.open({ provider: 'codex', cwd: path.join(tmp, 'b'), backend: two });
  expect(b).toMatch(/^codex-[a-z2-7]{6}$/);

  const top = await json(`${s.url}/info`);
  expect(top.root).toBe(path.join(tmp, 'a'));
  expect(await json(`${s.url}/a/${top.agent}/info`)).toMatchObject({ agent: top.agent, root: path.join(tmp, 'a') });
  expect(await json(`${s.url}/a/${b}/info`)).toMatchObject({ agent: b, root: path.join(tmp, 'b') });
  expect((await fetch(`${s.url}/a/codex-aaaaaa/info`)).status).toBe(404);

  // one tab per agent: a socket on each is the owner of its own
  const sa = await socket(s.url);
  const sb = await socket(`${s.url}/a/${b}`);
  expect(sa.events.map((e) => e.kind)).not.toContain('occupied');
  expect(sb.events.map((e) => e.kind)).not.toContain('occupied');
  sb.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'to b' }));
  await until(() => two.prompts.includes('to b'));
  await until(() => sb.events.some((e) => e.kind === 'user' && e.id === 'u1'));
  expect(one.prompts).not.toContain('to b');
  expect(sa.events.some((e) => e.kind === 'user')).toBe(false);

  // the agent keeps its data in its provider's folder, as a window of that provider does
  const post = await fetch(`${s.url}/a/${b}/sessions/archive`, { method: 'POST', headers: { origin: s.url, 'content-type': 'application/json' }, body: JSON.stringify({ id: '44444444-4444-4444-8444-444444444444', archived: true }) });
  expect(post.status).toBe(200);
  expect(fs.existsSync(path.join(tmp, 'home', 'providers', 'codex', 'archived-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(tmp, 'home', 'archived-sessions.json'))).toBe(false);
  await s.close();
  expect(closedTwo).toBe(true);
});
