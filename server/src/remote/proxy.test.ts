// Issue 297, phase 2: another computer's window on a loopback listener of this one, end to end. B is crossHost.ts in its
// own process and home (a real relay, a window, its connector); A is this process with another home: its connector (a pure
// client), one window of its own, paired with B. A's switcher lists B's window and opens it; the proxy serves B's page
// with its own auth, its socket reaches B's window, and a page there never gets a credential for A's windows.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeBackend } from '../agent/fake.ts';
import { accessToken, loginCredential, newNonce } from '../auth.ts';
import { registerWindow } from '../windows.ts';
import { Connector } from './connector.ts';
import { type Msg } from './control.ts';
import { pairHost } from './hostLink.ts';
import { RemoteKeeper } from './keeper.ts';
import { BAD_FRAME, Mux } from './mux.ts';
import { WindowProxy } from './proxy.ts';
import { launchServer } from '../testing.ts';

const script = fileURLToPath(new URL('./crossHost.ts', import.meta.url));
const prevHome = process.env.NOTA_BENE_HOME;
const LINGER = 1500;
let tmp: string;
let b: ChildProcess;
let next: () => Promise<Msg>;
let ready: Msg;
const closers: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nbp-')));
  b = spawn(process.execPath, [script], { env: { ...process.env, NOTA_BENE_HOME: path.join(tmp, 'b') }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const lines = readline.createInterface({ input: b.stdout! })[Symbol.asyncIterator]();
  next = async () => JSON.parse(String((await lines.next()).value)) as Msg;
  ready = await next();
  process.env.NOTA_BENE_HOME = path.join(tmp, 'a');
}, 120_000);
afterAll(async () => {
  while (closers.length) await closers.pop()!();
  if (b && b.exitCode === null) {
    b.stdin!.write('{"op":"stop"}\n');
    await new Promise((r) => b.once('exit', r));
  }
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ask = (m: object) => b.stdin!.write(`${JSON.stringify(m)}\n`);
const until = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
};

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string };
/** One request to 127.0.0.1:port with that Host (a browser on `localhost`), on a connection of its own. */
function req(port: number, p: string, o: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: o.method ?? 'GET', agent: false, headers: { host: o.host ?? `localhost:${port}`, ...o.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

describe('another computer\'s window through this one', () => {
  it('lists, opens, serves with its own auth, carries the socket, refuses the rest, switches back unseen, and goes', async () => {
    // A: one window of its own, with the keeper its routes ask the connector through
    for (const d of ['dist', 'proj']) fs.mkdirSync(path.join(tmp, 'a-' + d));
    fs.writeFileSync(path.join(tmp, 'a-dist', 'index.html'), '<h1>a</h1>');
    const aRoot = path.join(tmp, 'a-proj');
    const keeper = new RemoteKeeper({ spawn: () => {} });
    const aNonce = newNonce();
    const aw = await launchServer({ cwd: aRoot, port: 0, backend: fakeBackend([{ text: 'a' }]), webDist: path.join(tmp, 'a-dist'), exit: () => {}, remote: keeper, nonce: aNonce, id: 'claude-aaaaaa' });
    closers.push(() => aw.close());
    const aPort = Number(new URL(aw.url).port);
    const aAt = '/a/claude-aaaaaa'; // A's page is its agent's (issue 639)
    registerWindow(aPort, aRoot, process.pid);

    ask({ op: 'pair' });
    const { uri } = await next() as { uri: string };
    const host = await pairHost(uri);
    expect(await next()).toMatchObject({ t: 'paired' });
    const c = new Connector({ backoff: { minMs: 50, maxMs: 200 }, lingerMs: LINGER });
    await c.start();
    closers.push(() => c.stop());
    await until(() => c.hostWindows(host.id).some((w) => w.port === ready.port));

    // A's window, logged in as its page is
    const aLogin = loginCredential(accessToken(), aPort, aNonce);
    const aAuth = await req(aPort, '/auth', { method: 'POST', host: `127.0.0.1:${aPort}`, headers: { origin: `http://127.0.0.1:${aPort}`, 'content-type': 'application/json' }, body: JSON.stringify({ login: aLogin }) });
    const aCookie = String(aAuth.headers['set-cookie']![0]).split(';')[0]!;
    const aKey = (JSON.parse(aAuth.body) as { key: string }).key;
    const aPage = { cookie: aCookie, 'x-nota-bene-key': aKey, origin: `http://127.0.0.1:${aPort}`, 'content-type': 'application/json' };

    // A's switcher lists B's window as remote, beside A's own
    const list = JSON.parse((await req(aPort, `${aAt}/system/projects`, { host: `127.0.0.1:${aPort}`, headers: aPage })).body) as { running: Msg[] };
    expect(list.running).toContainEqual(expect.objectContaining({ port: aPort, current: true }));
    const row = list.running.find((r) => r.remote)!;
    const bAt = `/a/${String(row.agent)}`; // B's agent, under its prefix there too (issue 639)
    expect(row).toMatchObject({ port: ready.port, root: ready.root, provider: 'claude', state: 'idle', current: false, remote: { host: host.id, name: host.name } });
    // A's own window has no such route: its page gets the app shell there, which is no `{host, name}`
    expect((await req(aPort, `${aAt}/system/remote/page`, { host: `127.0.0.1:${aPort}`, headers: aPage })).body).toBe('<h1>a</h1>');

    // opening it: a listener on localhost, with a login of its own
    const opened = await req(aPort, `${aAt}/system/remote/open`, { method: 'POST', host: `127.0.0.1:${aPort}`, headers: aPage, body: JSON.stringify({ host: host.id, port: ready.port, agent: row.agent }) });
    expect(opened.status).toBe(200);
    const url = new URL((JSON.parse(opened.body) as { url: string }).url);
    expect(url.hostname).toBe('localhost');
    const port = Number(url.port);
    expect(port).not.toBe(aPort);
    const origin = `http://localhost:${port}`;
    const login = /^#t=([0-9a-f]{64})$/.exec(url.hash)![1]!;

    // before the login: B's shell (what its window serves anyone), nothing else
    expect(await req(port, '/')).toMatchObject({ status: 200, body: '<h1>shell</h1>' });
    expect((await req(port, '/info')).status).toBe(401);
    expect((await req(port, '/system/remote/page')).status).toBe(401);
    // A's own cookie and key are nothing here
    expect((await req(port, '/info', { headers: { cookie: aCookie, 'x-nota-bene-key': aKey } })).status).toBe(401);
    // only on localhost (127.0.0.1 shares A's cookies), and only from its own page
    expect((await req(port, '/', { host: `127.0.0.1:${port}` })).status).toBe(403);
    const bad = await req(port, '/auth', { method: 'POST', headers: { origin: `http://127.0.0.1:${aPort}` }, body: JSON.stringify({ login }) });
    expect(bad.status).toBe(403);
    expect((await req(port, '/auth', { method: 'POST', headers: { origin }, body: JSON.stringify({ login: aLogin }) })).status).toBe(401);

    const auth = await req(port, '/auth', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ login }) });
    expect(auth.status).toBe(200);
    const cookie = String(auth.headers['set-cookie']![0]).split(';')[0]!;
    const key = (JSON.parse(auth.body) as { key: string }).key;
    const page = { cookie, 'x-nota-bene-key': key };
    expect(cookie).not.toBe(aCookie);

    const info = await req(port, '/info', { headers: page });
    expect(info.status).toBe(200);
    expect(JSON.parse(info.body)).toMatchObject({ root: ready.root });
    expect((await req(port, '/info', { headers: { cookie } })).status).toBe(401);
    const file = await req(port, `${bAt}/file?path=notes.md`, { headers: { cookie } });
    expect(file.body).toContain('remote-cross-content');
    expect(JSON.parse((await req(port, '/system/remote/page', { headers: page })).body)).toEqual({ host: host.id, name: host.name });
    const there = JSON.parse((await req(port, '/system/projects', { headers: page })).body) as { running: Msg[]; recent: unknown[] };
    expect(there.recent).toEqual([]);
    expect(there.running).toContainEqual(expect.objectContaining({ port: ready.port, current: true, remote: { host: host.id, name: host.name } }));
    expect(there.running).toContainEqual(expect.objectContaining({ port: aPort, root: aRoot, current: false }));
    // A's rows carry what the switcher lists and moves with, nothing of their content
    expect(there.running.find((r) => r.port === aPort)).toEqual({ provider: 'claude', port: aPort, root: aRoot, title: null, session: null, state: expect.any(String), current: false, clients: 0, unseen: 0, last: null, agent: expect.stringMatching(/^claude-/), id: expect.stringMatching(/^claude-/) });

    // what a paired device may not reach is refused here, logged in or not
    const write = { ...page, origin, 'content-type': 'application/json' };
    for (const [m, p] of [['POST', '/system/folders'], ['GET', '/system/agents'], ['POST', '/system/projects/enter'], ['POST', '/system/remote/open'],
      ['POST', '/os/reveal'], ['GET', '/remote'], ['POST', '/control/stop']] as const) {
      expect((await req(port, p, { method: m, headers: write, body: m === 'POST' ? '{}' : undefined })).status, `${m} ${p}`).toBe(403);
    }
    expect((await req(port, '/prefs', { method: 'POST', headers: { ...page, origin: 'http://localhost:1' }, body: '{}' })).status).toBe(403);
    // a service worker one page registered would outlive the listener onto a later one on that port: none is served
    expect((await req(port, '/sw.js', { headers: { ...page, 'service-worker': 'script' } })).status).toBe(403);
    // a body the other computer would not take is refused before it goes
    const big = await new Promise<number>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/attach-file?name=a.bin', method: 'POST', agent: false, headers: { host: `localhost:${port}`, ...write, 'content-length': String(33 * 1024 * 1024) } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        r.destroy();
      });
      r.on('error', () => {});
      r.write('x');
    });
    expect(big).toBe(413);

    // the socket: only the page's own (origin, cookie and key), then B's window both ways
    const socket = (headers: Record<string, string>, protocols: string[] = []) =>
      new WebSocket(`ws://127.0.0.1:${port}${bAt}/ws?tab=desk1`, protocols, { headers: { host: `localhost:${port}`, ...headers } });
    const refused = (ws: WebSocket) => new Promise<number>((r) => ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0)));
    expect(await refused(socket({ origin: `http://127.0.0.1:${aPort}`, cookie }, [`nb.${key}`]))).toBe(403);
    expect(await refused(socket({ origin, cookie }))).toBe(401);
    expect(await refused(socket({ origin }, [`nb.${key}`]))).toBe(401);
    const ws = socket({ origin, cookie }, [`nb.${key}`]);
    const events: Msg[] = [];
    ws.on('message', (d) => events.push(JSON.parse(String(d)) as Msg));
    await new Promise((r) => ws.once('open', r));
    expect(ws.protocol).toBe(`nb.${key}`);
    await until(() => events.some((e) => e.kind === 'hello'));
    ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => events.some((e) => e.kind === 'user' && e.id === 'u1'));

    // the switch back: a navigation of this page's own only, answered with a redirect page code cannot read
    const nav = { cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    const home = `/system/remote/enter?provider=claude&port=${aPort}&root=${encodeURIComponent(aRoot)}`;
    const back = await req(port, home, { headers: nav });
    expect(back.status).toBe(303);
    expect(back.headers.location).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${aPort}/#t=[0-9a-f]{64}$`));
    expect(back.headers['referrer-policy']).toBe('no-referrer');
    for (const h of [{ cookie }, { ...nav, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, { ...nav, 'sec-fetch-dest': 'iframe' }, { ...nav, 'sec-fetch-site': 'same-site' }]) {
      const r = await req(port, home, { headers: h });
      expect(r.status).toBe(403);
      expect(r.headers.location).toBeUndefined();
    }
    // a navigation that cannot go comes back to the page, which says why
    const lost = await req(port, home, { headers: { ...nav, cookie: aCookie } });
    expect([lost.status, lost.headers.location]).toEqual([303, '/?enter=login']);
    const gone = await req(port, `/system/remote/enter?host=${host.id}&port=1`, { headers: nav });
    expect([gone.status, gone.headers.location]).toEqual([303, '/?enter=no-window']);
    const nowhere = await req(port, `/system/remote/enter?host=nope&port=1`, { headers: nav });
    expect([nowhere.status, nowhere.headers.location]).toEqual([303, '/?enter=not-connected']);
    const other = await req(port, `/system/remote/enter?host=${host.id}&port=${ready.port}&agent=${String(row.agent)}`, { headers: nav });
    expect(other.status).toBe(303);
    const otherUrl = new URL(other.headers.location!);
    expect(otherUrl.hostname).toBe('localhost');
    expect(Number(otherUrl.port)).not.toBe(port);

    // a listener stays while a socket is open, and goes a while after the last one closed
    await new Promise((r) => setTimeout(r, LINGER * 1.5));
    expect((await req(port, '/')).status).toBe(200);
    ws.close();
    // (not polled: every request is a connection, and keeps it)
    await new Promise((r) => setTimeout(r, LINGER * 2));
    await expect(req(port, '/')).rejects.toThrow();
  }, 90_000);
});

describe('the proxy without a window behind it', () => {
  /** a proxy over an in-process channel whose host side is `host` (each OPEN goes to it) */
  async function over(host: (s: import('./mux.ts').Stream, open: { kind?: string }) => void, lang?: string) {
    let a: Mux, b: Mux;
    a = new Mux({ send: (p) => queueMicrotask(() => b.receive(p)) });
    b = new Mux({ send: (p) => queueMicrotask(() => a.receive(p)), onOpen: (s, o) => host(s, o as { kind?: string }) });
    const p = new WindowProxy({ open: (o) => a.open(o), port: 4777, computer: { host: 'h', name: 'Studio' }, projects: async () => ({}), enter: async () => ({ error: 'x' }), onClose: () => {}, ...(lang ? { lang: () => lang } : {}) });
    await p.start();
    closers.push(() => p.close());
    return p;
  }
  const nav = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };

  it('an older host refuses the `public` kind: the page says so in the person\'s language, a request gets 502', async () => {
    const kinds: string[] = [];
    const p = await over((s, o) => { kinds.push(String(o.kind)); s.close(BAD_FRAME, 'unknown stream kind'); }, 'de');
    const page = await req(p.port, '/', { headers: nav });
    expect(page.status).toBe(502);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.body).toContain('lang="de"');
    expect(page.body).toContain('Studio');
    expect(page.body).not.toContain('could not be reached');
    expect((await req(p.port, '/assets/a.js')).status).toBe(502);
    expect(kinds).toEqual(['public', 'public']);
  });

  it('epic 383: the switch from this page names an agent, and the page of one opens on its prefix', async () => {
    const asked: unknown[] = [];
    const p = new WindowProxy({ open: () => null, port: 4777, agent: 'codex-k3f7qz', computer: { host: 'h', name: 'Studio' }, projects: async () => ({}), enter: async (to) => (asked.push(to), { error: 'no such window' }), onClose: () => {} });
    await p.start();
    closers.push(() => p.close());
    expect(p.url).toMatch(new RegExp(`^http://localhost:${p.port}/a/codex-k3f7qz/#t=[0-9a-f]{64}$`));
    const origin = `http://localhost:${p.port}`;
    const login = p.url.split('#t=')[1]!;
    const auth = await req(p.port, '/auth', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ login }) });
    const cookie = String(auth.headers['set-cookie']![0]).split(';')[0]!;
    const nav = { cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    await req(p.port, '/system/remote/enter?host=h&port=4777&agent=claude-a2b3c4', { headers: nav });
    await req(p.port, '/system/remote/enter?provider=omp&port=4790&root=%2Fp&agent=omp-x2y3z4', { headers: nav });
    const bad = await req(p.port, '/system/remote/enter?host=h&port=4777&agent=..%2Fx', { headers: nav });
    expect([bad.status, bad.headers.location]).toEqual([303, '/?enter=failed']);
    expect(asked).toEqual([{ host: 'h', port: 4777, agent: 'claude-a2b3c4' }, { provider: 'omp', port: 4790, root: '/p', agent: 'omp-x2y3z4' }]);
  });

  it('a computer that is not connected: the same page, in English without a saved language', async () => {
    const p = new WindowProxy({ open: () => null, port: 4777, computer: { host: 'h', name: 'Studio' }, projects: async () => ({}), enter: async () => ({ error: 'x' }), onClose: () => {} });
    await p.start();
    closers.push(() => p.close());
    const page = await req(p.port, '/', { headers: nav });
    expect(page.status).toBe(502);
    expect(page.body).toContain('lang="en"');
    expect(page.body).toContain('Studio');
  });
});
