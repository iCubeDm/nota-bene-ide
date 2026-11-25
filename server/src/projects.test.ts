import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fakeBackend } from './agent/fake.ts';
import { verifiedBearer } from './auth.ts';
import { providerStateDir } from './agent/provider.ts';
import { recordRecent } from './recent.ts';
import { bareRow, enterUrl, listProjects, remoteRows, sessionsOf, stopAt, stopOthers, type ProbedInfo } from './projects.ts';
import { agentServer, launchServer } from './testing.ts';
import { registerWindow, writeKeptAgents } from './windows.ts';

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
    const s = await launchServer({ cwd: root, port: 0, backend: fakeBackend([{ text: 'hi' }]), webDist: dist, exit });
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
  // issue 639: a server's home lists its agents, each answering as itself
  const list = await listProjects({ port: pa, provider: 'claude', agent: 'claude-aaaaaa' }, async (port, token) => {
    seenTokens.add(token);
    const provider = port === pb ? 'codex' as const : 'claude' as const;
    return { root: roots[port]!, extra: [{ root: roots[port]!, session: 's', title: null, ...states[port], agent: `${provider}-aaaaaa`, provider }] };
  });
  expect(list.running.map((r) => [r.provider, r.port, r.state, r.current])).toEqual(expect.arrayContaining([
    ['claude', pa, 'idle', true], ['codex', pb, 'working', false], ['claude', pc, 'waiting', false],
  ]));
  expect(list.running).toHaveLength(3);
  expect(seenTokens.size).toBe(2); // each provider's window probed with its own token
});

it('issue 691: the asking server answers for its own agents itself; only the others are probed', async () => {
  const a = mk('nb-proj-own-'), b = mk('nb-proj-far-');
  const pa = await windowOf('claude', a);
  const pb = await windowOf('claude', b);
  const probed: number[] = [];
  const self = {
    info: (): ProbedInfo => ({ root: a, extra: [{ root: a, agent: 'codex-aaaaaa', provider: 'codex', busy: true, session: 's1' }] }),
    agent: () => null, open: async () => { throw new Error('unused'); },
  };
  const list = await listProjects({ port: pa, provider: 'claude', self }, async (port) => { probed.push(port); return { root: b, agent: 'claude-bbbbbb' }; });
  expect(probed).toEqual([pb]);
  expect(list.running.map((r) => [r.port, r.id, r.state])).toEqual(expect.arrayContaining([[pa, 'codex-aaaaaa', 'working'], [pb, 'claude-bbbbbb', 'idle']]));
  expect(list.running).toHaveLength(2);
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
  const list = await listProjects({ port: pa, provider: 'claude' }, async () => ({ root: a, extra: [{ root: a, unseen: 2, last, agent: 'claude-aaaaaa', provider: 'claude' }] }));
  const by = Object.fromEntries(list.running.map((r) => [r.port, r]));
  expect(by[pa]).toMatchObject({ unseen: 2, last });
  expect(by[4794]).toMatchObject({ unseen: 0, last: null });
});

it('issue 651: rows of this server carry the open asks, another server\'s do not', async () => {
  const a = mk('nb-proj-a-'), b = mk('nb-proj-b-');
  const pa = await windowOf('claude', a);
  const pb = await windowOf('claude', b);
  const asks = [{ id: 'p1', toolName: 'Bash', input: { command: 'ls' } }];
  const list = await listProjects({ port: pa, provider: 'claude' }, async (port) => ({ root: port === pa ? a : b, extra: [{ root: port === pa ? a : b, pending: true, asks, agent: port === pa ? 'claude-aaaaaa' : 'claude-bbbbbb', provider: 'claude' }] }));
  const by = Object.fromEntries(list.running.map((r) => [r.port, r]));
  expect(by[pa]).toMatchObject({ state: 'waiting', asks });
  expect(by[pb]!.state).toBe('waiting');
  expect(by[pb]!.asks).toBeUndefined();
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

it('issue 680: a session open in an agent of another server is not deleted', async () => {
  const a = mk('nb-proj-a-'), b = mk('nb-proj-b-');
  const open = '11111111-2222-4333-8444-555555555555';
  const deleted: string[] = [];
  const one = fakeBackend([]);
  one.capabilities.deleteSession = true;
  one.deleteSession = async (id) => { deleted.push(id); };
  const x = await agentServer({ cwd: a, port: 0, backend: one, webDist: dist, exit: () => {} });
  closers.push(x.close);
  registerWindow(Number(new URL(x.url).port), a, process.pid);
  const y = await launchServer({ cwd: b, port: 0, backend: fakeBackend([]), webDist: dist, exit: () => {}, resume: open });
  closers.push(y.close);
  registerWindow(Number(new URL(y.url).port), b, process.pid);
  const bearer = (await verifiedBearer(Number(new URL(x.url).port), 2000))!;
  const r = await fetch(`${x.url}/sessions/delete`, { method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json', origin: x.server }, body: JSON.stringify({ id: open }) });
  expect(await r.text()).toBe('the session is open in another window');
  expect(deleted).toEqual([]);
});

/** A claude window on `a` with a codex agent opened in it on `b` (epic 383): the port, the agent's id and the first one's. */
async function windowWithAgent(a: string, b: string) {
  const s = await agentServer({ cwd: a, port: 0, backend: fakeBackend([{ text: 'hi' }]), webDist: dist, exit: () => {} });
  closers.push(s.close);
  const port = Number(new URL(s.url).port);
  registerWindow(port, a, process.pid);
  const id = await s.open({ provider: 'codex', cwd: b, backend: fakeBackend([{ text: 'hi' }]) });
  return { port, id, first: s.agent };
}

it('epic 383: an agent the server opened is a row of its own, in its folder, with its provider and id', async () => {
  const a = mk('nb-proj-a-'), b = mk('nb-proj-b-');
  const { port, id, first } = await windowWithAgent(a, b);
  const pick = (l: Awaited<ReturnType<typeof listProjects>>) => l.running.map((r) => [r.provider, r.port, r.root, r.agent, r.state, r.current]);
  // issue 639: the first agent's row carries its id too
  expect(pick(await listProjects({ port, provider: 'claude', agent: first }))).toEqual(expect.arrayContaining([
    ['claude', port, a, first, 'idle', true], ['codex', port, b, id, 'idle', false],
  ]));
  // the agent's own page: its row is the current one
  const own = await listProjects({ port, provider: 'codex', agent: id });
  expect(pick(own)).toEqual(expect.arrayContaining([['claude', port, a, first, 'idle', false], ['codex', port, b, id, 'idle', true]]));
  expect(own.running).toHaveLength(2);
  expect(own.recent).toEqual([]);
});

it('epic 383: a restarting server lists the agents its launcher keeps as restarting, not an earlier launch\'s', async () => {
  await windowOf('claude', mk('nb-proj-a-')); // the claude token exists
  registerWindow(4794, '/x/a', DEAD, process.pid);
  writeKeptAgents(4794, { launcherPid: process.pid, nonce: 'n', agents: [{ id: 'claude-abcdef', provider: 'claude', root: '/x/a' }, { id: 'codex-abcdef', provider: 'codex', root: '/x/b' }] }, providerStateDir(home, 'claude'));
  // a launch before a Stop kept its own: this launcher does not reopen them
  registerWindow(4793, '/x/c', DEAD, process.pid);
  writeKeptAgents(4793, { launcherPid: DEAD, nonce: 'old', agents: [{ id: 'codex-ghostq', provider: 'codex', root: '/x/d' }] }, providerStateDir(home, 'claude'));
  const list = await listProjects({ port: 0, provider: 'claude' }, async () => null);
  // issue 639: every one by its id; the server itself only where nothing comes back (4793)
  expect(list.running.map((r) => [r.provider, r.root, r.agent, r.state])).toEqual(expect.arrayContaining([
    ['claude', '/x/a', 'claude-abcdef', 'restarting'], ['codex', '/x/b', 'codex-abcdef', 'restarting'], ['claude', '/x/c', undefined, 'restarting'],
  ]));
  expect(list.running.filter((r) => r.root === '/x/a')).toHaveLength(1);
  expect(list.running.some((r) => r.agent === 'codex-ghostq')).toBe(false);
});

it('epic 383: enterUrl to an agent logs in under its prefix; a wrong folder or id is refused', async () => {
  const a = mk('nb-proj-a-'), b = mk('nb-proj-b-');
  const { port, id } = await windowWithAgent(a, b);
  const r = await enterUrl({ provider: 'codex', port, root: b, agent: id, session: S2 });
  if (!('url' in r)) throw new Error(r.error);
  expect(r.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/a/${id}/#t=[0-9a-f]{64}&s=${S2}$`));
  expect(await postAuth(port, r.url.split('#t=')[1]!.split('&')[0]!)).toBe(200);
  expect(await enterUrl({ provider: 'codex', port, root: a, agent: id })).toEqual({ error: 'window not answering' });
  expect(await enterUrl({ provider: 'codex', port, root: b, agent: 'codex-zzzzzz' })).toEqual({ error: 'window not answering' });
});

it('epic 383: sessionsOf asks the agent under its prefix', async () => {
  const a = mk('nb-proj-a-'), b = mk('nb-proj-b-');
  const { port, id } = await windowWithAgent(a, b);
  const asked: string[] = [];
  const fetchFn: typeof fetch = (u, i) => {
    asked.push(new URL(String(u)).pathname);
    return String(u).endsWith('/sessions') ? Promise.resolve(Response.json({ current: S1, sessions: [{ id: S1, title: 'x', at: 1, cwd: b }] })) : fetch(u, i);
  };
  expect(await sessionsOf({ provider: 'codex', port, root: b, agent: id }, fetchFn)).toEqual({ current: S1, sessions: [{ id: S1, title: 'x', at: 1 }] });
  expect(asked).toContain(`/a/${id}/sessions`);
});

it('epic 383: stopAt closes an agent alone, with its server\'s control token; its window goes on', async () => {
  const a = mk('nb-proj-a-'), b = mk('nb-proj-b-');
  const { port, id, first } = await windowWithAgent(a, b);
  expect(await stopAt({ provider: 'codex', port, root: a, agent: id })).toEqual({ error: 'window not answering' });
  expect(await stopAt({ provider: 'codex', port, root: b, agent: id })).toEqual({ ok: true });
  const l = await listProjects({ port, provider: 'claude' });
  expect(l.running.map((r) => [r.root, r.agent])).toEqual([[a, first]]);
});

it('epic 383: stopOthers from an agent\'s page leaves its own server', async () => {
  const a = mk('nb-proj-a-'), b = mk('nb-proj-b-');
  const { port, id } = await windowWithAgent(a, b);
  expect(await stopOthers({ port, provider: 'codex', agent: id })).toEqual({ stopped: 0, failed: 0 });
});

it('issue 297: a paired computer\'s windows as rows, the state from its host stream, the proxy\'s own one current', () => {
  const last = { role: 'assistant' as const, text: 'done', at: 5 };
  const rows = remoteRows([{ id: 'h1', name: 'Studio', windows: [
    { port: 4777, provider: 'claude', root: '/p/a', title: 'T', session: 's1', busy: true, last },
    { port: 4778, provider: 'codex', root: '/p/b', busy: true, pending: true },
    { port: 4779, provider: 'omp', root: '/p/c' },
    { port: 4781, provider: 'gpt' as 'omp', root: '/p/d' }, // a newer computer's agent
  ] }], { host: 'h1', port: 4779 });
  expect(rows).toEqual([
    { provider: 'claude', port: 4777, root: '/p/a', title: 'T', session: 's1', state: 'working', current: false, clients: 0, unseen: 0, last, remote: { host: 'h1', name: 'Studio' } },
    expect.objectContaining({ port: 4778, state: 'waiting', title: null, last: null }),
    expect.objectContaining({ port: 4779, state: 'idle', current: true }),
  ]);
});

it('epic 383: a paired computer\'s agents beside its windows, each with its id; current is that agent only', () => {
  const rows = remoteRows([{ id: 'h1', name: 'Studio', windows: [
    { port: 4777, provider: 'claude', root: '/p/a' },
    { port: 4777, provider: 'codex', root: '/p/b', agent: 'codex-k3f7qz' },
  ] }], { host: 'h1', port: 4777, agent: 'codex-k3f7qz' });
  expect(rows.map((r) => [r.agent, r.current])).toEqual([[undefined, false], ['codex-k3f7qz', true]]);
  expect(remoteRows([{ id: 'h1', name: 'Studio', windows: [{ port: 4777, provider: 'claude', root: '/p/a' }] }], { host: 'h1', port: 4777 })[0]!.current).toBe(true);
});

it('issue 297: a row for another computer\'s page keeps what lists and moves, none of its content', () => {
  const row = { provider: 'claude' as const, port: 4777, root: '/p/a', title: 'T', session: 's1', state: 'waiting' as const, current: false, clients: 2, unseen: 3, last: { role: 'user' as const, text: 'secret', at: 1 }, remote: { host: 'h', name: 'N' } };
  expect(bareRow(row)).toEqual({ provider: 'claude', port: 4777, root: '/p/a', title: null, session: null, state: 'waiting', current: false, clients: 0, unseen: 0, last: null, remote: { host: 'h', name: 'N' } });
});
