import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fakeBackend } from './agent/fake.ts';
import { recordRecent } from './recent.ts';
import { enterUrl, listProjects, remoteRows, sessionsOf, stopAt, stopOthers, type ProbedInfo } from './projects.ts';
import { startServer } from './server.ts';
import { registerWindow } from './windows.ts';

let home: string;
let dist: string;
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
const prev = { home: process.env.NOTA_BENE_HOME, agent: process.env.NOTA_BENE_AGENT };
const mk = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return fs.realpathSync(d); };
const DEAD = 2 ** 22 + 12345; // no such pid

beforeEach(() => {
  home = mk('nb-projects-home-');
  dist = mk('nb-projects-dist-');
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
  delete process.env.NOTA_BENE_AGENT;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  for (const [k, v] of [['NOTA_BENE_HOME', prev.home], ['NOTA_BENE_AGENT', prev.agent]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A real window of `provider` on `root`, registered in that provider's registry. */
async function windowOf(provider: 'claude' | 'codex', root: string, exit: (code: number) => void = () => {}) {
  if (provider === 'codex') process.env.NOTA_BENE_AGENT = 'codex';
  try {
    const s = await startServer({ cwd: root, port: 0, backend: fakeBackend([{ text: 'hi' }]), webDist: dist, exit });
    closers.push(s.close);
    const port = Number(new URL(s.url).port);
    registerWindow(port, root, process.pid);
    return port;
  } finally {
    delete process.env.NOTA_BENE_AGENT;
  }
}

it('lists the windows of every provider with their state', async () => {
  const a = mk('nb-proj-notes-'), b = mk('nb-proj-site-');
  const pa = await windowOf('claude', a);
  const pb = await windowOf('codex', b);
  const pc = await windowOf('claude', b);
  const states: Record<number, Partial<ProbedInfo>> = { [pa]: {}, [pb]: { busy: true }, [pc]: { busy: true, pending: true } };
  const roots: Record<number, string> = { [pa]: a, [pb]: b, [pc]: b };
  const seenTokens = new Set<string>();
  const list = await listProjects({ port: pa, provider: 'claude' }, async (port, token) => {
    seenTokens.add(token);
    return { root: roots[port]!, session: 's', title: null, ...states[port] };
  });
  expect(list.running.map((r) => [r.provider, r.port, r.state, r.current])).toEqual(expect.arrayContaining([
    ['claude', pa, 'idle', true], ['codex', pb, 'working', false], ['claude', pc, 'waiting', false],
  ]));
  expect(list.running).toHaveLength(3);
  expect(seenTokens.size).toBe(2); // each provider's window probed with its own token
});

it('a restarting entry and a silent one are listed without a session', async () => {
  const a = mk('nb-proj-a-');
  const pa = await windowOf('claude', a);
  registerWindow(4794, '/x/restarting', DEAD, process.pid);
  registerWindow(4795, '/x/gone', DEAD);
  const list = await listProjects({ port: pa, provider: 'claude' }, async () => null);
  const by = Object.fromEntries(list.running.map((r) => [r.port, r]));
  expect(by[4794]).toMatchObject({ state: 'restarting', session: null });
  expect(by[pa]).toMatchObject({ state: 'silent', session: null });
  expect(by[4795]).toBeUndefined();
});

it('recent marks the running folders', async () => {
  const a = mk('nb-proj-a-');
  const pa = await windowOf('claude', a);
  recordRecent(home, '/x/old', 'claude', 1);
  recordRecent(home, a, 'claude', 2);
  const list = await listProjects({ port: pa, provider: 'claude' });
  expect(list.recent).toEqual([{ root: a, provider: 'claude', at: 2, running: true }, { root: '/x/old', provider: 'claude', at: 1, running: false }]);
});

const postAuth = (port: number, login: string) => new Promise<number>((resolve, reject) => {
  const body = JSON.stringify({ login });
  const req = http.request({ host: '127.0.0.1', port, path: '/auth', method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on('error', reject);
  req.end(body);
});

it('enterUrl mints a login that the target accepts', async () => {
  const b = mk('nb-proj-b-');
  const pb = await windowOf('codex', b);
  const r = await enterUrl({ provider: 'codex', port: pb, root: b });
  if (!('url' in r)) throw new Error(r.error);
  expect(r.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${pb}/#t=[0-9a-f]{64}$`));
  expect(await postAuth(pb, r.url.split('#t=')[1]!)).toBe(200);
});

it('enterUrl refuses a port whose root changed, before any bearer is sent', async () => {
  const a = mk('nb-proj-a-');
  const pa = await windowOf('claude', a);
  let infos = 0;
  const counting: typeof fetch = (u, i) => { if (String(u).includes('/info')) infos++; return fetch(u, i); };
  expect(await enterUrl({ provider: 'claude', port: pa, root: '/x/other' }, counting)).toEqual({ error: 'no such window' });
  registerWindow(pa, '/x/other', process.pid); // the registry says another root; the listener still holds `a`
  expect(await enterUrl({ provider: 'claude', port: pa, root: '/x/other' }, counting)).toEqual({ error: 'window not answering' });
  expect(infos).toBe(1); // only the proved listener was asked, and its root did not match
});

it('enterUrl refuses another provider\'s listener', async () => {
  const a = mk('nb-proj-a-');
  const pa = await windowOf('claude', a);
  await windowOf('codex', mk('nb-proj-c-')); // the codex token exists
  process.env.NOTA_BENE_AGENT = 'codex';
  registerWindow(pa, a, process.pid); // filed under codex, but the port is a claude window
  delete process.env.NOTA_BENE_AGENT;
  expect(await enterUrl({ provider: 'codex', port: pa, root: a })).toEqual({ error: 'window not answering' });
});

it('rows carry the unseen replies and the last message; a window that does not answer has neither', async () => {
  const a = mk('nb-proj-a-');
  const pa = await windowOf('claude', a);
  registerWindow(4794, '/x/restarting', DEAD, process.pid);
  const last = { role: 'assistant' as const, text: 'done', at: 5 };
  const list = await listProjects({ port: pa, provider: 'claude' }, async () => ({ root: a, unseen: 2, last }));
  const by = Object.fromEntries(list.running.map((r) => [r.port, r]));
  expect(by[pa]).toMatchObject({ unseen: 2, last });
  expect(by[4794]).toMatchObject({ unseen: 0, last: null });
});

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

it('sessionsOf lists the sessions of that window in its folder, not in a subfolder', async () => {
  const a = mk('nb-proj-a-');
  const pa = await windowOf('claude', a);
  const view = { current: S1, root: a, sessions: [
    { id: S1, title: 'here', at: 3, size: 1, cwd: a },
    { id: S2, title: 'sub', at: 2, size: 1, cwd: path.join(a, 'web') },
    { id: S3, title: 'elsewhere', at: 1, size: 1, cwd: `${a}-other`, archived: true as const },
  ] };
  const fetchFn: typeof fetch = (u, i) => (String(u).endsWith('/sessions') ? Promise.resolve(Response.json(view)) : fetch(u, i));
  expect(await sessionsOf({ provider: 'claude', port: pa, root: a }, fetchFn)).toEqual({
    current: S1, sessions: [{ id: S1, title: 'here', at: 3 }],
  });
});

it('sessionsOf refuses a window that is not on that folder before asking it anything', async () => {
  const a = mk('nb-proj-a-');
  const pa = await windowOf('claude', a);
  let asked = 0;
  const counting: typeof fetch = (u, i) => { if (/\/(info|sessions)$/.test(String(u))) asked++; return fetch(u, i); };
  expect(await sessionsOf({ provider: 'claude', port: pa, root: '/x/other' }, counting)).toEqual({ error: 'no such window' });
  expect(asked).toBe(0);
});

it('enterUrl with a session carries it after the login', async () => {
  const b = mk('nb-proj-b-');
  const pb = await windowOf('claude', b);
  const r = await enterUrl({ provider: 'claude', port: pb, root: b, session: S2 });
  if (!('url' in r)) throw new Error(r.error);
  expect(r.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${pb}/#t=[0-9a-f]{64}&s=${S2}$`));
});

const exited = () => {
  let done: (code: number) => void = () => {};
  const p = new Promise<number>((r) => { done = r; });
  return { exit: (code: number) => done(code), code: p };
};

it('stopAt stops that window with its own provider\'s control token', async () => {
  const a = mk('nb-proj-a-');
  const e = exited();
  const pa = await windowOf('codex', a, e.exit);
  expect(await stopAt({ provider: 'codex', port: pa, root: a })).toEqual({ ok: true });
  expect(await e.code).toBe(0);
});

it('stopAt refuses a window that is not on that folder before sending anything', async () => {
  const a = mk('nb-proj-a-');
  const pa = await windowOf('claude', a);
  let sent = 0;
  const counting: typeof fetch = (u, i) => { if (String(u).includes('/control/')) sent++; return fetch(u, i); };
  expect(await stopAt({ provider: 'claude', port: pa, root: '/x/other' }, counting)).toEqual({ error: 'no such window' });
  expect(sent).toBe(0);
});

it('stopOthers stops every window but this one, of every provider', async () => {
  const [a, b, c] = [mk('nb-proj-a-'), mk('nb-proj-b-'), mk('nb-proj-c-')];
  const ea = exited(), eb = exited();
  let ownStopped = false;
  const own = await windowOf('claude', a, () => { ownStopped = true; });
  await windowOf('claude', b, ea.exit);
  await windowOf('codex', c, eb.exit);
  expect(await stopOthers({ port: own, provider: 'claude' })).toEqual({ stopped: 2, failed: 0 });
  expect(await Promise.all([ea.code, eb.code])).toEqual([0, 0]);
  expect(ownStopped).toBe(false);
});

it('issue 297: a paired computer\'s windows as rows, the state from its host stream, the proxy\'s own one current', () => {
  const last = { role: 'assistant', text: 'done', at: 5 };
  const rows = remoteRows([{ id: 'h1', name: 'Studio', windows: [
    { port: 4777, provider: 'claude', root: '/p/a', title: 'T', session: 's1', busy: true, last },
    { port: 4778, provider: 'codex', root: '/p/b', busy: true, pending: true },
    { port: 4779, provider: 'omp', root: '/p/c' },
    { port: 4781, provider: 'gpt', root: '/p/d' },
  ] }], { host: 'h1', port: 4779 });
  expect(rows).toEqual([
    { provider: 'claude', port: 4777, root: '/p/a', title: 'T', session: 's1', state: 'working', current: false, clients: 0, unseen: 0, last, remote: { host: 'h1', name: 'Studio' } },
    expect.objectContaining({ port: 4778, state: 'waiting', title: null, last: null }),
    expect.objectContaining({ port: 4779, state: 'idle', current: true }),
  ]);
});
