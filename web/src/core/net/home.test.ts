import { expect, it } from 'vitest';
import { agentGone, agentHome } from './home.ts';

const at = (path: string) => new URL(`http://127.0.0.1:4791${path}`);
const answer = (body: unknown, ok = true): typeof fetch => async () => (ok ? Response.json(body) : new Response('no', { status: 401 }));

it('issue 639: a page opened at the top goes to its server\'s first agent, its query kept', async () => {
  const home = { root: '/w/site', agents: [{ id: 'codex-k3f7qz', provider: 'codex', root: '/w/site' }, { id: 'claude-a2b3c4', provider: 'claude', root: '/w/site' }] };
  expect(await agentHome(at('/?enter=login'), answer(home))).toBe('/a/codex-k3f7qz/?enter=login');
});

it('stays: under an agent, at an older server\'s top (its first agent), with no agent, or no answer', async () => {
  expect(await agentHome(at('/a/codex-k3f7qz/'), answer({ agents: [{ id: 'claude-a2b3c4' }] }))).toBeNull();
  expect(await agentHome(at('/'), answer({ agent: 'claude-a2b3c4', agents: [{ id: 'claude-a2b3c4' }] }))).toBeNull();
  expect(await agentHome(at('/'), answer({ root: '/w/site', agents: [] }))).toBeNull();
  expect(await agentHome(at('/'), answer({ agents: [{ id: '../x' }] }))).toBeNull();
  expect(await agentHome(at('/'), answer(null, false))).toBeNull();
});

it('issue 639: a page whose agent the server no longer has (404 under its prefix) goes to the top, its query kept', async () => {
  const seen: string[] = [];
  const status = (n: number): typeof fetch => async (u) => (seen.push(String(u)), new Response('', { status: n }));
  expect(await agentGone(at('/a/codex-k3f7qz/?x=1'), status(404))).toBe('/?x=1');
  expect(seen).toEqual(['/a/codex-k3f7qz/info']);
  // its agent is there, the login is refused, the server is down, or the page is the top: it stays
  expect(await agentGone(at('/a/codex-k3f7qz/'), status(200))).toBeNull();
  expect(await agentGone(at('/a/codex-k3f7qz/'), status(401))).toBeNull();
  expect(await agentGone(at('/a/codex-k3f7qz/'), async () => { throw new TypeError('down'); })).toBeNull();
  expect(await agentGone(at('/'), status(404))).toBeNull();
});
