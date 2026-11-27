import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import { agentServer } from './testing.ts';
import { readSeen } from './seen.ts';

let home: string;
let dist: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-clients-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-clients-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

async function boot(o: { heartbeat?: number; turns?: Parameters<typeof fakeBackend>[0]; resume?: string; sessions?: { id: string; cwd: string; lastModified: number }[] } = {}) {
  const s = await agentServer({ insecureNoAuth: true,
    cwd: '/proj', port: 0, backend: fakeBackend(o.turns ?? [{ text: 'hello' }], o.sessions ? { sessions: o.sessions } : {}), webDist: dist,
    ...(o.heartbeat ? { heartbeatMs: o.heartbeat } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
  });
  closers.push(s.close);
  return s;
}

type Client = { ws: WebSocket; events: ServerEvent[]; closed: Promise<number> };
/** the socket's address: the server answers upgrades at /ws only (a query, if any, stays) */
const wsUrl = (url: string): string => { const u = url.replace('http', 'ws'); return /\/ws(\?|$)/.test(u) ? u : u.replace(/(\?|$)/, '/ws$1'); };

async function connect(url: string, o: { autoPong?: boolean } = {}): Promise<Client> {
  const ws = new WebSocket(wsUrl(url), { autoPong: o.autoPong ?? true });
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  closers.push(async () => { ws.terminate(); });
  return { ws, events, closed };
}
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const kinds = (c: Client) => c.events.map((e) => e.kind);
const ends = (c: Client) => c.events.filter((e) => e.kind === 'agent' && e.e.t === 'turn-end').length;
const info = async (url: string) => (await fetch(`${url}/info`)).json() as Promise<{ clients: number; busy: boolean; unseen: number }>;

// issue 174: every socket of a window is attached and live (browser tabs, the phone, another computer's tab)
describe('every client', () => {
  it('two sockets both get the replay and every live event; either may send', async () => {
    const s = await boot({ turns: [{ text: 'one' }, { text: 'two' }] });
    const a = await connect(s.url);
    const b = await connect(s.url);
    await until(() => kinds(a).includes('hello') && kinds(b).includes('hello'));
    expect(kinds(a)).toContain('replay');
    expect(kinds(b)).toContain('replay');
    expect(kinds(b)).not.toContain('occupied');
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'from a' }));
    await until(() => b.events.some((e) => e.kind === 'user'));
    await until(() => ends(a) === 1 && ends(b) === 1);
    b.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: 'from b' }));
    await until(() => ends(a) === 2);
    expect((await info(s.url)).clients).toBe(2);
  });

  it('?tab= and ?passive=1 are ignored: a passive socket with no other is attached, beside another with the same tab', async () => {
    const s = await boot();
    const a = await connect(`${s.url}/ws?tab=t1&passive=1`);
    await until(() => kinds(a).includes('hello'));
    expect(kinds(a)).toContain('replay');
    const b = await connect(`${s.url}/ws?tab=t1`);
    await until(() => kinds(b).includes('hello'));
    expect(kinds(b)).toContain('replay');
    await new Promise((r) => setTimeout(r, 50));
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('a socket that answers no ping is terminated; the other stays and clients counts it no more', async () => {
    const s = await boot({ heartbeat: 30 });
    const live = await connect(s.url);
    const dead = await connect(s.url, { autoPong: false });
    await until(() => kinds(live).includes('hello') && kinds(dead).includes('hello'));
    expect(await dead.closed).toBe(1006);
    await new Promise((r) => setTimeout(r, 100));
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
    expect((await info(s.url)).clients).toBe(1);
  });

  it('two answers to one ask reach the agent once; the second socket alone hears "already answered"', async () => {
    const s = await boot({ turns: [{ text: 'ok', ask: { toolName: 'Bash', input: { command: 'ls' } } }] });
    const a = await connect(s.url);
    const b = await connect(s.url);
    await until(() => kinds(a).includes('hello') && kinds(b).includes('hello'));
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'run' }));
    await until(() => kinds(b).includes('permission'));
    const p = b.events.find((e) => e.kind === 'permission') as Extract<ServerEvent, { kind: 'permission' }>;
    a.ws.send(JSON.stringify({ type: 'permission', id: p.id, allow: true }));
    await until(() => kinds(b).includes('permission-done'));
    b.ws.send(JSON.stringify({ type: 'permission', id: p.id, allow: false }));
    await until(() => b.events.some((e) => e.kind === 'server-error'));
    expect(b.events.find((e) => e.kind === 'server-error')).toMatchObject({ kind: 'server-error', where: 'permission', message: 'already answered' });
    expect(a.events.some((e) => e.kind === 'server-error')).toBe(false);
    expect(b.events.filter((e) => e.kind === 'permission-done')).toMatchObject([{ id: p.id, allow: true }]);
    await until(() => ends(a) === 1);
  });
});

// issue 174: the read state is the server's; a reply read on one client is read on all of them
describe('read state', () => {
  const SESSION = '33333333-3333-4333-8333-333333333333';
  const turns = [{ text: 'one' }, { text: 'two' }, { text: 'three' }];
  const looking = (c: Client, on: boolean) => c.ws.send(JSON.stringify({ type: 'looking', on }));
  const seen = (c: Client) => c.events.filter((e): e is Extract<ServerEvent, { kind: 'seen' }> => e.kind === 'seen');
  const reply = async (c: Client) => {
    const n = ends(c);
    c.ws.send(JSON.stringify({ type: 'send', id: `u${n}`, text: 'hi' }));
    await until(() => ends(c) === n + 1);
  };

  it('a final reply while a client looks is seen at once; with none looking it is unseen', async () => {
    const s = await boot({ turns, resume: SESSION });
    const a = await connect(s.url);
    const b = await connect(s.url);
    await until(() => kinds(a).includes('hello') && kinds(b).includes('hello'));
    await reply(a);
    expect((await info(s.url)).unseen).toBe(1);
    looking(b, true);
    await until(() => seen(a).length === 2);
    expect((await info(s.url)).unseen).toBe(0);
    await reply(a);
    expect((await info(s.url)).unseen).toBe(0);
  });

  it('turning on marks the session and every socket hears the mark, which a late socket gets before hello', async () => {
    const s = await boot({ turns, resume: SESSION });
    const a = await connect(s.url);
    const b = await connect(s.url);
    await until(() => kinds(a).includes('hello') && kinds(b).includes('hello'));
    expect(seen(a)).toEqual([{ kind: 'seen', at: 0 }]);
    const before = Date.now();
    looking(a, true);
    await until(() => seen(b).length === 2);
    const at = seen(b)[1]!.at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(seen(a)[1]).toEqual({ kind: 'seen', at });
    const late = await connect(s.url);
    await until(() => kinds(late).includes('hello'));
    expect(seen(late)).toEqual([{ kind: 'seen', at }]);
    expect(kinds(late).indexOf('seen')).toBeLessThan(kinds(late).indexOf('hello'));
    const replay = late.events[0]!;
    expect(replay.kind === 'replay' && replay.events.some((e) => e.kind === 'seen')).toBe(false);
  });

  it('a client that turns off, or closes, marks no more', async () => {
    const s = await boot({ turns, resume: SESSION });
    const a = await connect(s.url);
    const b = await connect(s.url);
    await until(() => kinds(a).includes('hello') && kinds(b).includes('hello'));
    looking(a, true);
    looking(a, false);
    await until(() => seen(a).length === 2);
    await reply(a);
    expect((await info(s.url)).unseen).toBe(1);
    looking(b, true);
    await until(() => seen(a).length === 3);
    b.ws.close();
    await b.closed;
    await new Promise((r) => setTimeout(r, 50));
    await reply(a);
    expect((await info(s.url)).unseen).toBe(1);
  });

  it('a switch while a client looks marks the session switched to', async () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-clients-b-')));
    closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const s = await boot({ turns, resume: SESSION, sessions: [{ id: OTHER, cwd: dir, lastModified: 1 }] });
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    looking(a, true);
    await until(() => seen(a).length === 2);
    a.ws.send(JSON.stringify({ type: 'switch', id: OTHER, dir }));
    await until(() => seen(a).length === 3);
    expect(readSeen(home)[OTHER]).toBe(seen(a)[2]!.at);
  });

  it('a /clear while a client looks marks the new conversation as soon as it has its id', async () => {
    const s = await boot({ turns, resume: SESSION });
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    looking(a, true);
    await until(() => seen(a).length === 2);
    const from = a.events.length;
    a.ws.send(JSON.stringify({ type: 'command', name: 'clear' }));
    await until(() => ends(a) === 1);
    const after = a.events.slice(from);
    const at = after.findIndex((e) => e.kind === 'session' && !!e.id && e.id !== SESSION);
    const id = (after[at] as Extract<ServerEvent, { kind: 'session' }>).id!;
    // one mark at the new id, before the one of the /clear's turn end
    const marks = after.slice(at).filter((e) => e.kind === 'seen');
    expect(marks).toHaveLength(2);
    expect(marks[1]).toEqual({ kind: 'seen', at: readSeen(home)[id] });
  });

  it('an id that is no session id (the fake\'s own) is never marked, and no error is told', async () => {
    const s = await boot();
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    looking(a, true);
    await reply(a);
    expect(seen(a)).toEqual([{ kind: 'seen', at: 0 }]);
    expect(kinds(a)).not.toContain('server-error');
  });
});
