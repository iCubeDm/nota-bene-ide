import { expect, it } from 'vitest';
import { agentHome } from './home.ts';

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
