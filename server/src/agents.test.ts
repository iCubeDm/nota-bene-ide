import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import { startServer } from './server.ts';
import { CONTROL_HEADER, controlToken } from './system.ts';
import { readKeptAgents } from './windows.ts';

// Several agents in one server (epic 383, step 2c): each its own folder, session, socket and one-tab rule, under /a/<id>/;
// the top is the server's home (issue 639).

// a reopen that takes a while, as a real agent's does (its session's history): the session manager comes late when set
const slow = vi.hoisted(() => ({ ms: 0 }));
vi.mock('./session.ts', async (orig) => {
  const m = await orig<typeof import('./session.ts')>();
  return { ...m, createSessionManager: async (...a: Parameters<typeof m.createSessionManager>) => {
    if (slow.ms) await new Promise((ok) => setTimeout(ok, slow.ms));
    return m.createSessionManager(...a);
  } };
});

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

async function socket(url: string, query = ''): Promise<{ ws: WebSocket; events: ServerEvent[] }> {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws${query}`);
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  closers.push(async () => { ws.terminate(); });
  await until(() => events.some((e) => e.kind === 'hello'));
  return { ws, events };
}

const json = async (url: string) => (await fetch(url)).json() as Promise<{ agent: string; root: string }>;
/** the server's first agent (issue 639: home lists it, its page is under /a/<id>/) */
const firstAgent = async (url: string) => {
  const agent = ((await (await fetch(`${url}/info`)).json()) as { agents: { id: string }[] }).agents[0]!.id;
  return { agent, url: `${url}/a/${agent}` };
};

it('a second agent has its own folder, socket, session and tab', async () => {
  const one = fakeBackend([{ text: 'from a' }]);
  const two = fakeBackend([{ text: 'from b' }]);
  let closedTwo = false;
  two.close = async () => { closedTwo = true; };
  const s = await startServer({ insecureNoAuth: true, cwd: path.join(tmp, 'a'), port: 0, backend: one, webDist: path.join(tmp, 'dist') });
  closers.push(s.close);
  const b = await s.open({ provider: 'codex', cwd: path.join(tmp, 'b'), backend: two });
  expect(b).toMatch(/^codex-[a-z2-7]{6}$/);

  const top = await firstAgent(s.url);
  expect(await json(`${s.url}/a/${top.agent}/info`)).toMatchObject({ agent: top.agent, root: path.join(tmp, 'a') });
  expect(await json(`${s.url}/a/${b}/info`)).toMatchObject({ agent: b, root: path.join(tmp, 'b') });
  expect((await fetch(`${s.url}/a/codex-aaaaaa/info`)).status).toBe(404);

  // one tab per agent: a socket on each is the owner of its own
  const sa = await socket(top.url);
  const sb = await socket(`${s.url}/a/${b}`);
  expect(sa.events.map((e) => e.kind)).not.toContain('occupied');
  expect(sb.events.map((e) => e.kind)).not.toContain('occupied');
  sb.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'to b' }));
  await until(() => two.prompts.includes('to b'));
  await until(() => sb.events.some((e) => e.kind === 'user' && e.id === 'u1'));
  expect(one.prompts).not.toContain('to b');
  expect(sa.events.some((e) => e.kind === 'user')).toBe(false);
  sa.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: 'to a' }));
  await until(() => one.prompts.includes('to a'));
  expect(two.prompts).not.toContain('to a');
  expect(sb.events.some((e) => e.kind === 'user' && e.id === 'u2')).toBe(false);

  // the agent keeps its data in its provider's folder, as a window of that provider does
  const post = await fetch(`${s.url}/a/${b}/sessions/archive`, { method: 'POST', headers: { origin: s.url, 'content-type': 'application/json' }, body: JSON.stringify({ id: '44444444-4444-4444-8444-444444444444', archived: true }) });
  expect(post.status).toBe(200);
  expect(fs.existsSync(path.join(tmp, 'home', 'providers', 'codex', 'archived-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(tmp, 'home', 'archived-sessions.json'))).toBe(false);
  await s.close();
  expect(closedTwo).toBe(true);
  // an agent opened as the server stops would outlive the close: refused
  await expect(s.open({ provider: 'claude', cwd: path.join(tmp, 'b'), backend: fakeBackend([]) })).rejects.toThrow(/stopping/);
});

it('/control/open: an agent for a folder and provider, the one already open, or a new session as another', async () => {
  const made: string[] = [];
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  const s = await startServer({
    insecureNoAuth: true, cwd: a, port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist'),
    backends: (p) => { made.push(p); return fakeBackend([]); },
  });
  closers.push(s.close);
  const open = async (body: unknown) => {
    const r = await fetch(`${s.url}/control/open`, { method: 'POST', headers: { [CONTROL_HEADER]: controlToken() }, body: JSON.stringify(body) });
    return { status: r.status, body: r.status === 200 ? (await r.json()) as { agent: string; opened: boolean } : await r.text() };
  };
  const first = await open({ root: b, provider: 'codex' });
  expect(first).toMatchObject({ status: 200, body: { opened: true } });
  const id = (first.body as { agent: string }).agent;
  expect(id).toMatch(/^codex-[a-z2-7]{6}$/);
  expect(await json(`${s.url}/a/${id}/info`)).toMatchObject({ root: b });
  expect((await open({ root: b, provider: 'codex' })).body).toEqual({ agent: id, opened: false });
  // the window's own agent is one of them (provider: claude when none is named)
  const top = await firstAgent(s.url);
  expect((await open({ root: a })).body).toEqual({ agent: top.agent, opened: false });
  const again = await open({ root: b, provider: 'codex', mode: 'new' });
  expect(again).toMatchObject({ status: 200, body: { opened: true } });
  expect((again.body as { agent: string }).agent).not.toBe(id);
  expect(made).toEqual(['codex', 'codex']); // the third below resumes a named session
  // the same session asked again (a window folding in that retries): the agent that has it, no second one
  const sid = '55555555-5555-4555-8555-555555555555';
  const resumed = (await open({ root: b, provider: 'codex', session: sid })).body as { agent: string; opened: boolean };
  expect(resumed.opened).toBe(true);
  expect((await open({ root: b, provider: 'codex', session: sid })).body).toEqual({ agent: resumed.agent, opened: false });
  for (const bad of [{}, { root: 'rel' }, { root: path.join(tmp, 'missing') }, { root: path.join(tmp, 'dist', 'index.html') }, { root: b, provider: 'gpt' }, { root: b, mode: 'x' }, { root: b, session: 'not-an-id' }]) {
    expect((await open(bad)).status, JSON.stringify(bad)).toBe(400);
  }
  // only with the control token, never from a page
  expect((await fetch(`${s.url}/control/open`, { method: 'POST', headers: { origin: s.url }, body: JSON.stringify({ root: b }) })).status).toBe(403);
});

it('/control/open moves the tab that follows (go=1) to the agent, the last one attached; with none the launcher opens one', async () => {
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  const s = await startServer({ insecureNoAuth: true, cwd: a, port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist'), backends: () => fakeBackend([]) });
  closers.push(s.close);
  const open = async (body: unknown) => (await fetch(`${s.url}/control/open`, { method: 'POST', headers: { [CONTROL_HEADER]: controlToken() }, body: JSON.stringify(body) })).json() as Promise<{ agent: string; opened: boolean; shown?: true }>;
  const top = await firstAgent(s.url);
  // no tab: the launcher opens the browser
  const first = await open({ root: b, provider: 'codex' });
  expect(first.shown).toBeUndefined();
  // a phone (no go=1) is not moved
  const phone = await socket(top.url);
  expect((await open({ root: b, provider: 'codex' })).shown).toBeUndefined();
  phone.ws.close();
  await until(() => phone.ws.readyState === WebSocket.CLOSED);
  const tab = await socket(top.url, '?tab=t1&go=1');
  expect(await open({ root: b, provider: 'codex' })).toEqual({ agent: first.agent, opened: false, shown: true });
  await until(() => tab.events.some((e) => e.kind === 'open-agent'));
  expect(tab.events.filter((e) => e.kind === 'open-agent')).toEqual([{ kind: 'open-agent', agent: first.agent }]);
  tab.ws.close(); // the page goes
  await until(() => tab.ws.readyState === WebSocket.CLOSED);
  // a tab already on that agent is not moved; the other one is, to the window's own agent
  const onB = await socket(`${s.url}/a/${first.agent}`, '?tab=t2&go=1');
  expect((await open({ root: b, provider: 'codex' })).shown).toBe(true);
  expect((await open({ root: a })).shown).toBe(true);
  await until(() => onB.events.some((e) => e.kind === 'open-agent'));
  expect(onB.events.filter((e) => e.kind === 'open-agent')).toEqual([{ kind: 'open-agent', agent: top.agent }]);
  expect(tab.events.filter((e) => e.kind === 'open-agent')).toHaveLength(1);
});

it('/control/open with show: false moves no tab; an agent another device owns is not one a tab moves onto', async () => {
  const b = path.join(tmp, 'b');
  const s = await startServer({ insecureNoAuth: true, cwd: path.join(tmp, 'a'), port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist'), backends: () => fakeBackend([]) });
  closers.push(s.close);
  const open = async (body: unknown) => (await fetch(`${s.url}/control/open`, { method: 'POST', headers: { [CONTROL_HEADER]: controlToken() }, body: JSON.stringify(body) })).json() as Promise<{ agent: string; shown?: true }>;
  const tab = await socket((await firstAgent(s.url)).url, '?tab=t1&go=1');
  const first = await open({ root: b, provider: 'codex', show: false });
  expect(first.shown).toBeUndefined();
  await socket(`${s.url}/a/${first.agent}`); // the phone holds it
  expect((await open({ root: b, provider: 'codex' })).shown).toBeUndefined();
  await new Promise((r) => setTimeout(r, 50));
  expect(tab.events.some((e) => e.kind === 'open-agent')).toBe(false);
});

it('issue 639: the top is the server\'s home (its folder and agents); every agent is under /a/<id>/ only', async () => {
  const s = await startServer({ insecureNoAuth: true, cwd: path.join(tmp, 'a'), port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist') });
  closers.push(s.close);
  const b = await s.open({ provider: 'codex', cwd: path.join(tmp, 'b'), backend: fakeBackend([]) });
  const top = (await (await fetch(`${s.url}/info`)).json()) as { root: string; agent?: string; agents: { id: string; provider: string; root: string }[] };
  expect(top.root).toBe(path.join(tmp, 'a'));
  expect(top.agent).toBeUndefined();
  const first = top.agents[0]!.id;
  expect(top.agents).toEqual([{ id: first, provider: 'claude', root: path.join(tmp, 'a') }, { id: b, provider: 'codex', root: path.join(tmp, 'b') }]);
  expect(await json(`${s.url}/a/${first}/info`)).toMatchObject({ agent: first, root: path.join(tmp, 'a') });
  expect((await fetch(`${s.url}/`)).status).toBe(200); // the app shell
  expect(await (await fetch(`${s.url}/sessions`)).text()).toBe('<h1>x</h1>'); // the shell, not an agent's sessions
  await expect(socket(s.url)).rejects.toThrow(/404/);
  await socket(`${s.url}/a/${first}`);
});

it('issue 667: an agent whose turn ended but whose background task runs is busy in its /info; a watcher alone is not', async () => {
  const s = await startServer({ insecureNoAuth: true, cwd: path.join(tmp, 'a'), port: 0, webDist: path.join(tmp, 'dist'), backend: fakeBackend([
    { match: 'watch', text: 'watching', frames: [{ type: 'system', subtype: 'task_started', task_id: 't-watch', description: 'tail -f build.log', task_type: 'local_bash', tool_use_id: 'toolu_watch', ambient: true }] },
    { match: 'index', text: 'started', frames: [{ type: 'system', subtype: 'task_started', task_id: 't-bg', description: 'Index the docs', task_type: 'local_agent', tool_use_id: 'toolu_bg', is_backgrounded: true }] },
  ]) });
  closers.push(s.close);
  const { url } = await firstAgent(s.url);
  const busy = async () => ((await (await fetch(`${url}/info`)).json()) as { busy: boolean }).busy;
  const { ws, events } = await socket(url);
  const turn = async (text: string) => {
    const ends = () => events.filter((e) => e.kind === 'agent' && e.e.t === 'turn-end').length;
    const n = ends();
    ws.send(JSON.stringify({ type: 'send', id: text, text }));
    await until(() => ends() > n);
  };
  await turn('watch');
  expect(await busy()).toBe(false);
  await turn('index');
  expect(await busy()).toBe(true);
});

it('issue 676: a session open in another agent of this server is not deleted', async () => {
  const deleted: string[] = [];
  const one = fakeBackend([]);
  one.capabilities.deleteSession = true;
  one.deleteSession = async (id) => { deleted.push(id); };
  const s = await startServer({ insecureNoAuth: true, cwd: path.join(tmp, 'a'), port: 0, webDist: path.join(tmp, 'dist'), backend: one });
  closers.push(s.close);
  const { url } = await firstAgent(s.url);
  const open = '11111111-2222-4333-8444-555555555555';
  const b = `${s.url}/a/${await s.open({ provider: 'claude', cwd: path.join(tmp, 'b'), backend: fakeBackend([]), resume: open })}`;
  expect(await (await fetch(`${b}/info`)).json()).toMatchObject({ session: open });
  const del = (id: string) => fetch(`${url}/sessions/delete`, { method: 'POST', headers: { 'content-type': 'application/json', origin: s.url }, body: JSON.stringify({ id }) });
  expect(await (await del(open)).text()).toBe('the session is open in another window');
  expect(deleted).toEqual([]);
});

it('issue 676: the branch list marks the folder of an agent at work on this server', async () => {
  const b = path.join(tmp, 'b');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: b });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  const s = await startServer({ insecureNoAuth: true, cwd: path.join(tmp, 'a'), port: 0, webDist: path.join(tmp, 'dist'), backend: fakeBackend([]) });
  closers.push(s.close);
  const url = `${s.url}/a/${await s.open({ provider: 'codex', cwd: b, backend: fakeBackend([
    { match: 'index', text: 'started', frames: [{ type: 'system', subtype: 'task_started', task_id: 't-bg', description: 'Index the docs', task_type: 'local_agent', tool_use_id: 'toolu_bg', is_backgrounded: true }] },
  ]) })}`;
  const busy = async () => ((await (await fetch(`${url}/vcs-branches`)).json()) as { busy: boolean }[]).map((r) => r.busy);
  expect(await busy()).toEqual([false]);
  const { ws, events } = await socket(url);
  ws.send(JSON.stringify({ type: 'send', id: 'm', text: 'index' }));
  await until(() => events.some((e) => e.kind === 'agent' && e.e.t === 'turn-end'));
  expect(await busy()).toEqual([true]);
});

it('issue 675: an agent opened later records its usage too, by its provider', async () => {
  const seen: string[] = [];
  const s = await startServer({
    insecureNoAuth: true, cwd: path.join(tmp, 'a'), port: 0, webDist: path.join(tmp, 'dist'), backend: fakeBackend([]),
    usage: (provider) => (provider === 'claude' ? { onStats: () => { seen.push(provider); } } : {}),
  });
  closers.push(s.close);
  const turn = async (id: string) => {
    const { ws, events } = await socket(`${s.url}/a/${id}`);
    ws.send(JSON.stringify({ type: 'send', id: 'm', text: 'hi' }));
    await until(() => events.some((e) => e.kind === 'agent' && e.e.t === 'turn-end'));
  };
  await turn(await s.open({ provider: 'codex', cwd: path.join(tmp, 'b'), backend: fakeBackend([]) }));
  expect(seen).toEqual([]);
  await turn(await s.open({ provider: 'claude', cwd: path.join(tmp, 'b'), backend: fakeBackend([]) }));
  expect(seen.length).toBeGreaterThan(0);
});

it('issue 639: /a/<id>/control/close closes any agent, the first one too, but not the server\'s last; the folder stays', async () => {
  let closedA = false;
  const one = fakeBackend([]);
  one.close = async () => { closedA = true; };
  const s = await startServer({
    insecureNoAuth: true, cwd: path.join(tmp, 'a'), port: 0, backend: one, webDist: path.join(tmp, 'dist'),
    nonce: 'c'.repeat(32), keep: { launcherPid: 111 },
  });
  closers.push(s.close);
  const port = Number(new URL(s.url).port);
  const b = await s.open({ provider: 'codex', cwd: path.join(tmp, 'b'), backend: fakeBackend([]) });
  const close = (base: string) => fetch(`${s.url}${base}/control/close`, { method: 'POST', headers: { [CONTROL_HEADER]: controlToken() } });
  const first = ((await (await fetch(`${s.url}/info`)).json()) as { agents: { id: string }[] }).agents[0]!.id;
  expect((await close('')).status).toBe(404);
  expect((await close(`/a/${first}`)).status).toBe(200);
  await until(() => closedA);
  expect((await fetch(`${s.url}/a/${first}/info`)).status).toBe(404);
  expect(readKeptAgents(port)?.agents.map((k) => k.id)).toEqual([b]);
  expect(await (await fetch(`${s.url}/info`)).json()).toMatchObject({ root: path.join(tmp, 'a'), agents: [{ id: b }] });
  expect((await close(`/a/${b}`)).status).toBe(409);
  // only with the control token, never from a page
  expect((await fetch(`${s.url}/a/${b}/control/close`, { method: 'POST', headers: { origin: s.url } })).status).toBe(403);
});

it('issue 639: a server that opens agents closes its last one too and stays up; its home lists the projects', async () => {
  const s = await startServer({
    insecureNoAuth: true, cwd: path.join(tmp, 'a'), port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist'),
    nonce: 'c'.repeat(32), keep: { launcherPid: 111 }, backends: () => fakeBackend([]),
  });
  closers.push(s.close);
  const port = Number(new URL(s.url).port);
  const first = ((await (await fetch(`${s.url}/info`)).json()) as { agents: { id: string }[] }).agents[0]!.id;
  const close = await fetch(`${s.url}/a/${first}/control/close`, { method: 'POST', headers: { [CONTROL_HEADER]: controlToken() } });
  expect(close.status).toBe(200);
  expect(await (await fetch(`${s.url}/info`)).json()).toMatchObject({ root: path.join(tmp, 'a'), agents: [] });
  expect(readKeptAgents(port)?.agents).toEqual([]);
  const list = await fetch(`${s.url}/system/projects`);
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ running: [], recent: [] });
});

describe('kept agents (2c-2, issue 639): a relaunch of the same launch reopens every agent under its id, the first one too', () => {
  const N1 = 'a'.repeat(32);
  const N2 = 'b'.repeat(32);
  const start = (port: number, nonce: string, launcherPid: number) => startServer({
    insecureNoAuth: true, cwd: path.join(tmp, 'a'), port, backend: fakeBackend([]), webDist: path.join(tmp, 'dist'),
    nonce, keep: { launcherPid }, backends: () => fakeBackend([]),
  });
  const ids = async (url: string, id: string) => (await fetch(`${url}/a/${id}/info`)).status;
  const agents = async (url: string) => ((await (await fetch(`${url}/info`)).json()) as { agents: { id: string }[] }).agents.map((a) => a.id);

  it.each([['restart or update (a new inner launcher): the same nonce', N1, 222], ['crash: the same launcher, a new nonce', N2, 111]] as const)('%s', async (_, nonce, pid) => {
    const s = await start(0, N1, 111);
    const port = Number(new URL(s.url).port);
    const b = await s.open({ provider: 'codex', cwd: path.join(tmp, 'b'), backend: fakeBackend([]) });
    const [first] = await agents(s.url);
    await s.close();
    const again = await start(port, nonce, pid);
    closers.push(again.close);
    expect(await agents(again.url)).toEqual([first, b]); // the launch's own agent is the kept one, no second
    expect(await json(`${again.url}/a/${b}/info`)).toMatchObject({ root: path.join(tmp, 'b') });
  });

  it('a request for a kept agent still reopening waits for it (a tab reloaded right after the restart gets its page)', async () => {
    const s = await start(0, N1, 111);
    const port = Number(new URL(s.url).port);
    const b = await s.open({ provider: 'codex', cwd: path.join(tmp, 'b'), backend: fakeBackend([]) });
    await s.close();
    slow.ms = 300;
    const again = start(port, N1, 111);
    try {
      let first: number | undefined;
      while (first === undefined) first = await fetch(`http://127.0.0.1:${port}/a/${b}/`).then((r) => r.status, () => undefined);
      expect(first).toBe(200);
    } finally {
      slow.ms = 0;
      closers.push((await again).close);
    }
  });

  it('two agents of one folder each come back with their own session (epic 383 2e)', async () => {
    const S1 = '11111111-1111-4111-8111-111111111111', S2 = '22222222-2222-4222-8222-222222222222';
    const s = await start(0, N1, 111);
    const port = Number(new URL(s.url).port);
    const b = path.join(tmp, 'b');
    await s.open({ provider: 'codex', cwd: b, backend: fakeBackend([]), resume: S1 });
    await s.open({ provider: 'codex', cwd: b, backend: fakeBackend([]), resume: S2 });
    await until(() => readKeptAgents(port)?.agents.filter((k) => k.session).length === 2);
    await s.close();
    const shared = fakeBackend([]);
    const again = await startServer({
      insecureNoAuth: true, cwd: path.join(tmp, 'a'), port, backend: fakeBackend([]), webDist: path.join(tmp, 'dist'),
      nonce: N1, keep: { launcherPid: 111 }, backends: () => shared,
    });
    closers.push(again.close);
    expect(shared.starts.map((x) => x.resume).filter(Boolean).sort()).toEqual([S1, S2]);
  });

  it('a kept agent whose folder is gone is dropped, not kept for good', async () => {
    const s = await start(0, N1, 111);
    const port = Number(new URL(s.url).port);
    const gone = path.join(tmp, 'gone');
    fs.mkdirSync(gone);
    const b = await s.open({ provider: 'codex', cwd: gone, backend: fakeBackend([]) });
    const [first] = await agents(s.url);
    await s.close();
    fs.rmSync(gone, { recursive: true });
    const again = await start(port, N1, 111);
    closers.push(again.close);
    expect(await ids(again.url, b)).toBe(404);
    expect(readKeptAgents(port)?.agents.map((k) => k.id)).toEqual([first]);
  });

  it('a relaunch of a launch whose agents were all closed opens none', async () => {
    const s = await start(0, N1, 111);
    const port = Number(new URL(s.url).port);
    const [first] = await agents(s.url);
    expect((await fetch(`${s.url}/a/${first}/control/close`, { method: 'POST', headers: { [CONTROL_HEADER]: controlToken() } })).status).toBe(200);
    await s.close();
    await new Promise((r) => setTimeout(r, 20)); // fetch's pool notices the closed keep-alive (no agent kept it busy)
    const again = await start(port, N1, 222);
    closers.push(again.close);
    expect(await agents(again.url)).toEqual([]);
  });

  it('a fresh launch (another launcher and nonce) ignores them and starts with its own', async () => {
    const s = await start(0, N1, 111);
    const port = Number(new URL(s.url).port);
    const b = await s.open({ provider: 'codex', cwd: path.join(tmp, 'b'), backend: fakeBackend([]) });
    await s.close();
    const fresh = await start(port, N2, 222);
    closers.push(fresh.close);
    expect(await ids(fresh.url, b)).toBe(404);
    expect(readKeptAgents(port)?.agents.map((k) => k.id)).toEqual(await agents(fresh.url));
  });
});
