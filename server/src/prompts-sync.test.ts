import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { PromptEntry, ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import { startServer } from './server.ts';

let home: string;
let dist: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-psync-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-psync-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

async function boot(extra: { resume?: string; fork?: boolean } = {}) {
  const s = await startServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello' }, { text: 'again' }]), webDist: dist, oneTab: false, ...extra });
  closers.push(s.close);
  return s;
}
type Client = { ws: WebSocket; events: ServerEvent[] };
async function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  closers.push(async () => { ws.terminate(); });
  return { ws, events };
}
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const results = (c: Client) => c.events.filter((e) => e.kind === 'agent' && e.e.t === 'turn-end').length;
const post = (s: { url: string }, body: unknown) =>
  fetch(`${s.url}/prompts`, { method: 'POST', headers: { 'content-type': 'application/json', origin: s.url }, body: JSON.stringify(body) });
const list = async (s: { url: string }) => (await (await fetch(`${s.url}/prompts`)).json()) as { session: string | null; prompts: PromptEntry[] };
const onDisk = (id: string) => path.join(home, 'prompts', `${id}.jsonl`);

describe('prompt history on the server', () => {
  it('the first prompt of a new session waits in memory and is stored under its id once it has one', async () => {
    const s = await boot();
    const c = await connect(s.url);
    expect((await post(s, { session: null, id: 'p1', text: 'first', src: 'typed' })).status).toBe(204);
    expect(fs.existsSync(onDisk('fake-session'))).toBe(false);
    expect((await list(s)).prompts.map((p) => p.id)).toEqual(['p1']);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'first' }));
    await until(() => results(c) === 1);
    expect(fs.readFileSync(onDisk('fake-session'), 'utf8')).toContain('"id":"p1"');
    expect(await list(s)).toMatchObject({ session: 'fake-session', prompts: [{ id: 'p1', text: 'first' }] });
  });

  it('a /clear carries the history to the new session id', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => results(c) === 1);
    expect((await post(s, { session: 'fake-session', id: 'p1', text: 'hi', src: 'typed' })).status).toBe(204);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: '/clear' }));
    await until(() => results(c) === 2);
    const now = await list(s);
    expect(now.session).not.toBe('fake-session');
    expect(now.prompts.map((p) => p.id)).toEqual(['p1']);
    // the old file stays; the two histories are separate files from here on
    expect(fs.existsSync(onDisk('fake-session'))).toBe(true);
  });

  it('a fork: prompts posted under the source id before its first init reach the new id, with the carried ones', async () => {
    fs.mkdirSync(path.join(home, 'prompts'), { recursive: true });
    fs.writeFileSync(onDisk('src-sess'), `${JSON.stringify({ v: 1, id: 'p1', ts: 1, text: 'before', src: 'typed' })}\n`);
    const s = await boot({ resume: 'src-sess', fork: true });
    const c = await connect(s.url);
    expect((await post(s, { session: 'src-sess', id: 'p2', text: 'in the fork', src: 'typed' })).status).toBe(204);
    expect(fs.readFileSync(onDisk('src-sess'), 'utf8')).not.toContain('p2');
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'in the fork' }));
    await until(() => results(c) === 1);
    const now = await list(s);
    expect(now.session).toMatch(/^src-sess-fork-/);
    expect(now.prompts.map((x) => x.id)).toEqual(['p1', 'p2']);
    expect(fs.readFileSync(onDisk('src-sess'), 'utf8')).not.toContain('p2');
  });
});
