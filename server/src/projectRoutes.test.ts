import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EventHub } from './hub.ts';
import { projectRoutes, validName } from './projectRoutes.ts';
import type { Self, SelfAgent } from './projects.ts';
import { readRecent, recordRecent } from './recent.ts';

let tree: string;
let home: string;
const closers: (() => Promise<void>)[] = [];
const prevHome = process.env.NOTA_BENE_HOME;
const URL_OK = `http://127.0.0.1:4793/#t=${'a'.repeat(64)}`;

beforeEach(() => {
  tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-proutes-')));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-proutes-home-'));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  for (const d of [tree, home]) fs.rmSync(d, { recursive: true, force: true });
});

/** An agent of the asking server on `root`; `closed` counts its closes. */
const agentOn = (root: string, closed = { n: 0 }): SelfAgent => ({
  root, url: (session) => `${URL_OK}${session ? `&s=${session}` : ''}`, close: () => void closed.n++,
  sessions: async () => ({ current: null, sessions: [{ id: 'a1', title: 'here', at: 2, cwd: root }, { id: 'a2', title: 'below', at: 1, cwd: path.join(root, 'sub') }] }),
});

async function serve(self: Partial<Self> = {}, agents?: () => Promise<{ agents: ('claude' | 'codex' | 'omp')[]; default: 'claude' | 'codex' | 'omp' }>, agent?: string) {
  const hub = new EventHub();
  const events: unknown[] = [];
  const emit = hub.emit.bind(hub);
  hub.emit = (ev, o) => { events.push(ev); return emit(ev, o); };
  const calls: { dir: string; provider: string; fresh: boolean }[] = [];
  const open: Self['open'] = async (dir, provider, fresh) => { calls.push({ dir, provider, fresh }); return (self.open ?? (async (d) => agentOn(d)))(dir, provider, fresh); };
  const routes = projectRoutes({ hub, port: () => 4791, provider: 'claude', self: { info: () => ({ root: tree }), agent: () => null, ...self, open }, ...(agents ? { agents } : {}), ...(agent ? { agent } : {}) });
  const srv = http.createServer((req, res) => routes[new URL(req.url!, 'http://x').pathname]!(req, res));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { base, post, calls, events, hub };
}

it('folders lists subfolders, hides dot folders unless asked, and marks git repos', async () => {
  fs.mkdirSync(path.join(tree, 'a'));
  fs.mkdirSync(path.join(tree, 'B', '.git'), { recursive: true });
  fs.mkdirSync(path.join(tree, '.hid'));
  fs.writeFileSync(path.join(tree, 'f.txt'), 'x');
  const s = await serve();
  const r = (await (await s.post('/system/folders', { path: tree })).json()) as { path: string; parent: string; home: string; dirs: unknown[] };
  expect(r.dirs).toEqual([{ name: 'a', git: false }, { name: 'B', git: true }]);
  expect(r.path).toBe(tree);
  expect(r.parent).toBe(path.dirname(tree));
  expect(r.home).toBe(os.homedir());
  const h = (await (await s.post('/system/folders', { path: tree, hidden: true })).json()) as { dirs: { name: string }[] };
  expect(h.dirs.map((d) => d.name)).toEqual(['.hid', 'a', 'B']);
});

it('folders starts at home and refuses a relative path and a file', async () => {
  const s = await serve();
  expect(((await (await s.post('/system/folders', {})).json()) as { path: string }).path).toBe(os.homedir());
  expect((await s.post('/system/folders', { path: 'rel/x' })).status).toBe(400);
  fs.writeFileSync(path.join(tree, 'f.txt'), 'x');
  expect((await s.post('/system/folders', { path: path.join(tree, 'f.txt') })).status).toBe(404);
  expect((await s.post('/system/folders', { path: path.join(tree, 'none') })).status).toBe(404);
});

it('open asks the server for the folder\'s agent, returns its URL and remembers the folder', async () => {
  const s = await serve();
  const r = await s.post('/system/projects/open', { dir: tree, provider: 'codex' });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ url: URL_OK });
  expect(s.calls).toEqual([{ dir: tree, provider: 'codex', fresh: false }]);
  expect(readRecent(home).map((e) => [e.root, e.provider])).toEqual([[tree, 'codex']]);
});

it('open refuses the home folder and a folder that is gone', async () => {
  const s = await serve();
  expect((await s.post('/system/projects/open', { dir: os.homedir(), provider: 'claude' })).status).toBe(400);
  expect((await s.post('/system/projects/open', { dir: path.join(tree, 'gone'), provider: 'claude' })).status).toBe(404);
  expect(s.calls).toHaveLength(0);
});

it('open refuses a relative folder and an unknown agent', async () => {
  const s = await serve();
  expect((await s.post('/system/projects/open', { dir: 'x', provider: 'claude' })).status).toBe(400);
  expect((await s.post('/system/projects/open', { dir: tree, provider: 'gpt' })).status).toBe(400);
  expect(s.calls).toHaveLength(0);
});

it('open reports what the server refuses and leaves the folder out of Recent', async () => {
  const s = await serve({ open: async () => { throw new Error('the server is stopping'); } });
  const r = await s.post('/system/projects/open', { dir: tree, provider: 'claude' });
  expect(r.status).toBe(502);
  expect(await r.text()).toBe('the server is stopping');
  expect(readRecent(home)).toEqual([]);
});

it('create refuses bad names', async () => {
  const s = await serve();
  for (const name of ['', '.', '..', 'a/b', 'a\\b', ' a', 'a ', 'a\0b', 'x'.repeat(256)]) {
    const r = await s.post('/system/projects/create', { parent: tree, name, git: false, provider: 'claude' });
    expect(r.status, JSON.stringify(name)).toBe(400);
  }
  expect(fs.readdirSync(tree)).toEqual([]);
  expect(s.calls).toHaveLength(0);
});

it('create makes the folder, runs git init when asked, and opens it', async () => {
  const s = await serve();
  const r = await s.post('/system/projects/create', { parent: tree, name: 'with git', git: true, provider: 'claude' });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ url: URL_OK });
  expect(fs.existsSync(path.join(tree, 'with git', '.git'))).toBe(true);
  expect(s.calls[0]).toEqual({ dir: path.join(tree, 'with git'), provider: 'claude', fresh: true });
  expect((await s.post('/system/projects/create', { parent: tree, name: 'plain', git: false, provider: 'claude' })).status).toBe(200);
  expect(fs.existsSync(path.join(tree, 'plain'))).toBe(true);
  expect(fs.existsSync(path.join(tree, 'plain', '.git'))).toBe(false);
});

it('create refuses an existing name with 409 exists', async () => {
  fs.mkdirSync(path.join(tree, 'taken'));
  const s = await serve();
  const r = await s.post('/system/projects/create', { parent: tree, name: 'taken', git: false, provider: 'claude' });
  expect(r.status).toBe(409);
  expect(await r.text()).toBe('exists');
});

it('agents answers the installed agents and a default', async () => {
  const s = await serve(undefined, async () => ({ agents: ['claude', 'codex'], default: 'codex' }));
  expect(await (await fetch(`${s.base}/system/agents`)).json()).toEqual({ agents: ['claude', 'codex'], default: 'codex' });
});

it('enter refuses a bad body and an unknown window', async () => {
  const s = await serve();
  expect((await s.post('/system/projects/enter', { provider: 'claude', port: 'x', root: tree })).status).toBe(400);
  const r = await s.post('/system/projects/enter', { provider: 'claude', port: 4795, root: tree });
  expect(r.status).toBe(404);
  expect(await r.text()).toBe('no such window');
});

it('projects lists running and recent', async () => {
  const s = await serve();
  expect(await (await fetch(`${s.base}/system/projects`)).json()).toEqual({ running: [], recent: [], hidden: [] });
});

it('sessions and enter refuse a bad body; sessions of an unknown window is 404', async () => {
  const s = await serve();
  expect((await s.post('/system/projects/sessions', { provider: 'claude', port: 'x', root: tree })).status).toBe(400);
  expect((await s.post('/system/projects/sessions', { provider: 'claude', port: 4795, root: tree })).status).toBe(404);
  expect((await s.post('/system/projects/enter', { provider: 'claude', port: 4795, root: tree, session: '../x' })).status).toBe(400);
  expect((await s.post('/system/projects/enter', { provider: 'claude', port: 4795, root: tree, session: 'new' })).status).toBe(404);
});

it('folders names the places: home first, then the parents of recent projects, once each', async () => {
  for (const d of ['p1/a', 'p1/b', 'p2/c']) fs.mkdirSync(path.join(tree, d), { recursive: true });
  recordRecent(home, path.join(tree, 'p1', 'a'), 'claude', 1);
  recordRecent(home, path.join(tree, 'p2', 'c'), 'claude', 2);
  recordRecent(home, path.join(tree, 'p1', 'b'), 'codex', 3);
  recordRecent(home, path.join(os.homedir(), 'x'), 'claude', 4);
  const s = await serve();
  const r = (await (await s.post('/system/folders', { path: tree })).json()) as { places: { path: string; kind: string }[] };
  expect(r.places[0]).toEqual({ path: os.homedir(), kind: 'home' });
  const recent = r.places.filter((p) => p.kind === 'recent').map((p) => p.path);
  expect(recent).toEqual([path.join(tree, 'p1'), path.join(tree, 'p2')]);
  expect(r.places.filter((p) => p.path === os.homedir())).toHaveLength(1);
});

it('validName refuses what Windows refuses', () => {
  for (const n of ['a:b', 'a*', 'a?', 'a"b', 'a<b', 'a>b', 'a|b', 'CON', 'con.txt', 'NUL', 'com1', 'LPT9', 'name.', 'a\x01b']) expect(validName(n), n).toBe(false);
  for (const n of ['console', 'a.b', 'my project', 'CONx', 'проект']) expect(validName(n), n).toBe(true);
});

it('stop refuses a bad body, this window and an unknown one; stop-others with none is a count of zero', async () => {
  const s = await serve();
  expect((await s.post('/system/projects/stop', { provider: 'claude', port: 'x', root: tree })).status).toBe(400);
  expect((await s.post('/system/projects/stop', { provider: 'claude', port: 4791, root: tree })).status).toBe(409);
  // an agent beside this window's (epic 383) is no part of it: it is looked for (none here), not refused
  expect((await s.post('/system/projects/stop', { provider: 'codex', port: 4791, root: tree, agent: 'codex-abcdef' })).status).toBe(404);
  expect((await s.post('/system/projects/stop', { provider: 'claude', port: 4794, root: tree })).status).toBe(404);
  expect(await (await s.post('/system/projects/stop-others', {})).json()).toEqual({ stopped: 0, failed: 0 });
});

it('issue 639: this page\'s own agent is stopped from its tab like the others (looked for, not refused)', async () => {
  const s = await serve(undefined, undefined, 'claude-q2w3e4');
  expect((await s.post('/system/projects/stop', { provider: 'claude', port: 4791, root: tree, agent: 'claude-q2w3e4' })).status).toBe(404);
});

it('issue 691: an agent of this server is entered, listed and closed in-process, by its id and folder', async () => {
  const closed = { n: 0 };
  const s = await serve({ agent: (id) => (id === 'codex-abcdef' ? agentOn(tree, closed) : null) });
  const row = { provider: 'codex', port: 4791, root: tree, agent: 'codex-abcdef' };
  expect(await (await s.post('/system/projects/enter', { ...row, session: 'new' })).json()).toEqual({ url: `${URL_OK}&s=new` });
  expect(await (await s.post('/system/projects/sessions', row)).json()).toEqual({ current: null, sessions: [{ id: 'a1', title: 'here', at: 2 }] });
  // another folder: the row is stale
  expect((await s.post('/system/projects/stop', { ...row, root: path.join(tree, 'other') })).status).toBe(404);
  expect(closed.n).toBe(0);
  expect((await s.post('/system/projects/stop', row)).status).toBe(200);
  expect(closed.n).toBe(1);
});

it('forget drops a folder from Recent and lists it as hidden; a bad root is refused', async () => {
  const s = await serve();
  recordRecent(home, '/p/a', 'claude', 1);
  recordRecent(home, '/p/b', 'codex', 2);
  expect((await s.post('/system/projects/forget', { root: 'rel' })).status).toBe(400);
  expect((await s.post('/system/projects/forget', {})).status).toBe(400);
  expect((await s.post('/system/projects/forget', { root: '/p/a' })).status).toBe(200);
  const l = await (await fetch(`${s.base}/system/projects`)).json() as { recent: { root: string }[]; hidden: string[] };
  expect(l.recent.map((e) => e.root)).toEqual(['/p/b']);
  expect(l.hidden).toEqual(['/p/a']);
});
