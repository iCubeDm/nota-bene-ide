import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EventHub } from './hub.ts';
import { launchEnv, launcherOf, projectRoutes, validName, type Launch } from './projectRoutes.ts';
import { recordRecent } from './recent.ts';

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

async function serve(launch: Launch = async () => ({ code: 0, firstLine: `opened ${URL_OK}` }), agents?: () => Promise<{ agents: ('claude' | 'codex' | 'omp')[]; default: 'claude' | 'codex' | 'omp' }>) {
  const hub = new EventHub();
  const events: unknown[] = [];
  const emit = hub.emit.bind(hub);
  hub.emit = (ev, o) => { events.push(ev); return emit(ev, o); };
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const routes = projectRoutes({ hub, port: () => 4791, provider: 'claude', repoDir: tree, launch: async (args, env) => { calls.push({ args, env }); return launch(args, env); }, ...(agents ? { agents } : {}) });
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

it('open passes the agent and the folder to the launcher and returns its URL', async () => {
  process.env.NOTA_BENE_NONCE = 'b'.repeat(32);
  try {
    const s = await serve();
    const r = await s.post('/system/projects/open', { dir: tree, provider: 'codex' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: URL_OK });
    const { args, env } = s.calls[0]!;
    expect(args).toEqual(expect.arrayContaining([tree, '--agent', 'codex', '--detach', '--no-open']));
    expect(args[args.indexOf('--agent') + 1]).toBe('codex');
    expect(args).not.toContain('--new');
    expect(env.NOTA_BENE_NONCE).toBeUndefined();
    expect(env.NOTA_BENE_HOME).toBe(home);
  } finally {
    delete process.env.NOTA_BENE_NONCE;
  }
});

it('open with already-open returns that window\'s URL', async () => {
  const s = await serve(async () => ({ code: 0, firstLine: `already-open ${URL_OK}` }));
  expect(await (await s.post('/system/projects/open', { dir: tree, provider: 'claude' })).json()).toEqual({ url: URL_OK });
});

it('open refuses a relative folder and an unknown agent', async () => {
  const s = await serve();
  expect((await s.post('/system/projects/open', { dir: 'x', provider: 'claude' })).status).toBe(400);
  expect((await s.post('/system/projects/open', { dir: tree, provider: 'gpt' })).status).toBe(400);
  expect(s.calls).toHaveLength(0);
});

it('open reports a launcher failure without its output reaching the hub', async () => {
  const s = await serve(async () => ({ code: 1, firstLine: 'nota-bene: cannot use /x' }));
  const r = await s.post('/system/projects/open', { dir: tree, provider: 'claude' });
  expect(r.status).toBe(502);
  expect(await r.text()).toBe('nota-bene: cannot use /x');
  const odd = await serve(async () => ({ code: 0, firstLine: `weird #t=${'c'.repeat(64)}` }));
  const r2 = await odd.post('/system/projects/open', { dir: tree, provider: 'claude' });
  expect(r2.status).toBe(502);
  expect(await r2.text()).not.toContain('#t=');
  expect(JSON.stringify([...s.events, ...odd.events])).not.toContain('#t=');
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
  expect(s.calls[0]!.args).toContain(path.join(tree, 'with git'));
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
  expect(await (await fetch(`${s.base}/system/projects`)).json()).toEqual({ running: [], recent: [] });
});

it('launchEnv drops the launch-state variables and keeps the rest', () => {
  const env = launchEnv({ NOTA_BENE_HOME: '/h', NOTA_BENE_PORT_RANGE: '4791-4795', NOTA_BENE_SUPERVISED: '1', NOTA_BENE_LAUNCHER_PID: '1', NOTA_BENE_NONCE: 'n', NOTA_BENE_AGENT: 'codex', NOTA_BENE_INNER: '1', NOTA_BENE_LOCKED: '1', NOTA_BENE_AUTOPORT: '1', NOTA_BENE_HANDOVER: '1', NOTA_BENE_HANDOVER_NONCE: 'n', NOTA_BENE_UPDATED_FROM: '1.0.0', PATH: '/bin' });
  expect(env).toEqual({ NOTA_BENE_HOME: '/h', NOTA_BENE_PORT_RANGE: '4791-4795', PATH: '/bin' });
});

/** A stand-in launcher at `<repo>/bin/nota-bene.mjs` running `body`. */
function stubBin(body: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-proutes-bin-'));
  fs.mkdirSync(path.join(repo, 'bin'));
  fs.writeFileSync(path.join(repo, 'bin', 'nota-bene.mjs'), body);
  closers.push(async () => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}

it('the launcher line is read even when it is written just before the exit', async () => {
  // the line goes out in pieces, the last one as the process ends: stdout must be read to its end, not to 'exit'
  const repo = stubBin(`process.stdout.write('opened http://127.0.0.1:4793/');\nsetTimeout(() => { process.stdout.write('#t=${'a'.repeat(64)}\\n'); process.exit(0); }, 20);\n`);
  for (let i = 0; i < 5; i++) expect(await launcherOf(repo)([], process.env)).toEqual({ code: 0, firstLine: `opened ${URL_OK}` });
});

it('a launcher that takes longer than the wait is left running and reported as still starting', async () => {
  const mark = path.join(tree, 'done');
  const repo = stubBin(`import fs from 'node:fs';\nsetTimeout(() => fs.writeFileSync(${JSON.stringify(mark)}, 'x'), 600);\n`);
  const r = await launcherOf(repo, 100)([], process.env);
  expect(r).toEqual({ code: -1, firstLine: 'still starting' });
  await new Promise((res) => setTimeout(res, 1200));
  expect(fs.existsSync(mark)).toBe(true); // not killed: its window still comes up
});

it('a still-starting launch answers 504 still starting', async () => {
  const s = await serve(async () => ({ code: -1, firstLine: 'still starting' }));
  const r = await s.post('/system/projects/open', { dir: tree, provider: 'claude' });
  expect(r.status).toBe(504);
  expect(await r.text()).toBe('still starting');
});

it('sessions and enter refuse a bad body; sessions of an unknown window is 404', async () => {
  const s = await serve();
  expect((await s.post('/system/projects/sessions', { provider: 'claude', port: 'x', root: tree })).status).toBe(400);
  expect((await s.post('/system/projects/sessions', { provider: 'claude', port: 4795, root: tree })).status).toBe(404);
  expect((await s.post('/system/projects/enter', { provider: 'claude', port: 4795, root: tree, session: '../x' })).status).toBe(400);
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
