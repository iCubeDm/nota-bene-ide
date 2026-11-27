import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DRAFT_MAX, type ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import { DraftStore } from './drafts.ts';
import { agentServer } from './testing.ts';

let dir: string;
beforeEach(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-drafts-')), 'drafts'); });
afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

const img = { id: 'a'.repeat(64), mediaType: 'image/png' as const };
const file = (id: string) => path.join(dir, `${id}.json`);
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('DraftStore', () => {
  it('a draft is written after the delay and read back by another store', async () => {
    const a = new DraftStore({ dir, delayMs: 20 });
    a.set('s1', { text: 'half', images: [img] });
    expect(a.get('s1')).toEqual({ text: 'half', images: [img] });
    expect(fs.existsSync(file('s1'))).toBe(false);
    await tick(60);
    expect(new DraftStore({ dir }).get('s1')).toEqual({ text: 'half', images: [img] });
    if (process.platform !== 'win32') expect(fs.statSync(file('s1')).mode & 0o777).toBe(0o600);
  });

  it('flush writes at once; an empty draft removes its file', () => {
    const a = new DraftStore({ dir });
    a.set('s1', { text: 'x', images: [] });
    a.flush();
    expect(fs.existsSync(file('s1'))).toBe(true);
    a.set('s1', { text: '', images: [] });
    a.flush();
    expect(fs.existsSync(file('s1'))).toBe(false);
    expect(a.get('s1')).toEqual({ text: '', images: [] });
  });

  it('the null session stays in memory, is adopted under the first id, and dropped otherwise', () => {
    const a = new DraftStore({ dir });
    a.set(null, { text: 'new', images: [] });
    a.flush();
    expect(fs.existsSync(dir) && fs.readdirSync(dir).length).toBeFalsy();
    a.adopt('s1');
    expect(a.get('s1').text).toBe('new');
    expect(a.get(null).text).toBe('');
    a.set(null, { text: 'gone', images: [] });
    a.dropPending();
    expect(a.get(null).text).toBe('');
  });

  it('an empty null draft adopts nothing: the stored one of that id stays', () => {
    const a = new DraftStore({ dir });
    a.set('s1', { text: 'kept', images: [] });
    a.adopt('s1');
    expect(a.get('s1').text).toBe('kept');
  });

  it('forget removes the file and the unwritten value', () => {
    const a = new DraftStore({ dir });
    a.set('s1', { text: 'x', images: [] });
    a.flush();
    a.set('s1', { text: 'y', images: [] });
    a.forget('s1');
    a.flush();
    expect(fs.existsSync(file('s1'))).toBe(false);
    expect(a.get('s1').text).toBe('');
  });

  it('an unsafe id is refused; an unreadable file reads as no draft', () => {
    const a = new DraftStore({ dir });
    expect(() => a.set('../x', { text: 'x', images: [] })).toThrow();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file('s2'), 'not json');
    expect(a.get('s2')).toEqual({ text: '', images: [] });
  });
});

// the socket side: the window's clients share the open session's draft
const SA = '11111111-1111-4111-8111-111111111111';
const SB = '22222222-2222-4222-8222-222222222222';

describe('drafts on the socket', () => {
  let home: string;
  let A: string;
  let B: string;
  const prevHome = process.env.NOTA_BENE_HOME;
  const closers: (() => Promise<void>)[] = [];
  beforeEach(() => {
    const tmp = fs.realpathSync.native(path.dirname(dir));
    home = path.join(tmp, 'home');
    A = path.join(tmp, 'a');
    B = path.join(tmp, 'b');
    for (const d of [home, A, B, path.join(tmp, 'dist')]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<h1>x</h1>');
    process.env.NOTA_BENE_HOME = home;
  });
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
    if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  });

  async function boot(o: { resume?: string; deleteSession?: boolean } = {}) {
    const backend = fakeBackend([{ text: 'hello' }], {
      ...(o.deleteSession ? { capabilities: { deleteSession: true } } : {}),
      sessions: [{ id: SA, cwd: A, lastModified: 1 }, { id: SB, cwd: B, lastModified: 2 }],
    });
    const s = await agentServer({ insecureNoAuth: true, cwd: A, port: 0, backend, webDist: path.join(path.dirname(home), 'dist'), ...(o.resume ? { resume: o.resume } : {}) });
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await s.close(); } };
    closers.push(close);
    return { ...s, close };
  }
  type Client = { ws: WebSocket; events: ServerEvent[] };
  async function connect(url: string): Promise<Client> {
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
    const events: ServerEvent[] = [];
    ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    closers.push(async () => { ws.terminate(); });
    await until(() => events.some((e) => e.kind === 'hello'));
    return { ws, events };
  }
  async function until(cond: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timeout');
      await tick(5);
    }
  }
  const drafts = (c: Client) => c.events.filter((e): e is Extract<ServerEvent, { kind: 'draft' }> => e.kind === 'draft');
  const write = (c: Client, o: { id: string; sessionId: string | null; text: string; images?: unknown[] }) => c.ws.send(JSON.stringify({ type: 'draft', ...o }));
  const switchTo = async (c: Client, id: string | null, to: string) => {
    const n = drafts(c).length;
    c.ws.send(JSON.stringify({ type: 'switch', id, dir: to }));
    await until(() => drafts(c).length > n);
    return drafts(c).at(-1)!;
  };

  it('attach carries the current session\'s draft before hello', async () => {
    const store = new DraftStore({ dir: path.join(home, 'drafts') });
    store.set(SA, { text: 'stored', images: [img] });
    store.flush();
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    const d = c.events.findIndex((e) => e.kind === 'draft');
    expect(c.events[d]).toEqual({ kind: 'draft', sessionId: SA, text: 'stored', images: [img] });
    expect(d).toBeLessThan(c.events.findIndex((e) => e.kind === 'hello'));
    expect(c.events.findIndex((e) => e.kind === 'comments')).toBeLessThan(d);
  });

  it('a write reaches every socket with the writer\'s ack, and never enters the replay', async () => {
    const s = await boot({ resume: SA });
    const a = await connect(s.url);
    const b = await connect(s.url);
    write(a, { id: 'w1', sessionId: SA, text: 'typed', images: [img] });
    await until(() => drafts(b).length === 2 && drafts(a).length === 2);
    expect(drafts(a).at(-1)).toEqual({ kind: 'draft', sessionId: SA, text: 'typed', images: [img], ack: 'w1' });
    expect(drafts(b).at(-1)).toEqual(drafts(a).at(-1));
    const late = await connect(s.url);
    const replay = late.events[0]!;
    expect(replay.kind === 'replay' && replay.events.some((e) => e.kind === 'draft')).toBe(false);
    expect(drafts(late)).toEqual([{ kind: 'draft', sessionId: SA, text: 'typed', images: [img] }]);
  });

  it('a switch sends the new session\'s draft; a write tagged with the previous one lands there and is not shown', async () => {
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    write(c, { id: 'w1', sessionId: SA, text: 'in A' });
    await until(() => drafts(c).length === 2);
    expect(await switchTo(c, SB, B)).toEqual({ kind: 'draft', sessionId: SB, text: '' });
    write(c, { id: 'w2', sessionId: SA, text: 'late in A' });
    write(c, { id: 'w3', sessionId: SB, text: 'in B' });
    await until(() => drafts(c).at(-1)?.ack === 'w3');
    expect(drafts(c).some((e) => e.ack === 'w2')).toBe(false);
    expect(await switchTo(c, SA, A)).toEqual({ kind: 'draft', sessionId: SA, text: 'late in A' });
    expect(await switchTo(c, SB, B)).toEqual({ kind: 'draft', sessionId: SB, text: 'in B' });
  });

  it('the null session\'s draft is adopted under its first id', async () => {
    const s = await boot();
    const c = await connect(s.url);
    expect(drafts(c)).toEqual([{ kind: 'draft', sessionId: null, text: '' }]);
    write(c, { id: 'w1', sessionId: null, text: 'before the id' });
    await until(() => drafts(c).length === 2);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'first' }));
    await until(() => drafts(c).some((e) => e.sessionId === 'fake-session'));
    expect(drafts(c).at(-1)).toEqual({ kind: 'draft', sessionId: 'fake-session', text: 'before the id' });
    await s.close();
    expect(new DraftStore({ dir: path.join(home, 'drafts') }).get('fake-session').text).toBe('before the id');
  });

  it('a switch drops the null session\'s draft', async () => {
    const s = await boot();
    const c = await connect(s.url);
    write(c, { id: 'w1', sessionId: null, text: 'unsent' });
    await until(() => drafts(c).length === 2);
    expect(await switchTo(c, SB, B)).toEqual({ kind: 'draft', sessionId: SB, text: '' });
    expect(await switchTo(c, null, A)).toEqual({ kind: 'draft', sessionId: null, text: '' });
  });

  it('the draft survives a server restart', async () => {
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    write(c, { id: 'w1', sessionId: SA, text: 'keep me' });
    await until(() => drafts(c).length === 2);
    await s.close();
    const again = await boot({ resume: SA });
    expect(drafts(await connect(again.url)).at(-1)).toEqual({ kind: 'draft', sessionId: SA, text: 'keep me' });
  });

  it('a deleted session\'s draft goes', async () => {
    const store = new DraftStore({ dir: path.join(home, 'drafts') });
    store.set(SB, { text: 'doomed', images: [] });
    store.flush();
    const s = await boot({ resume: SA, deleteSession: true });
    const r = await fetch(`${s.url}/sessions/delete`, { method: 'POST', headers: { 'content-type': 'application/json', origin: s.server }, body: JSON.stringify({ id: SB }) });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(home, 'drafts', `${SB}.json`))).toBe(false);
  });

  it('an invalid or oversized draft is refused and stores nothing', async () => {
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    write(c, { id: 'w1', sessionId: SA, text: 'x'.repeat(DRAFT_MAX + 1) });
    write(c, { id: 'w2', sessionId: '../escape', text: 'x' });
    await until(() => c.events.filter((e) => e.kind === 'server-error').length === 2);
    expect(drafts(c)).toHaveLength(1);
    await s.close();
    expect(fs.existsSync(path.join(home, 'drafts')) && fs.readdirSync(path.join(home, 'drafts'))).toBeFalsy();
  });
});
