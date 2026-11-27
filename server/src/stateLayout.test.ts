import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fakeBackend } from './agent/fake.ts';
import { agentServer } from './testing.ts';
import { agentContext } from './state.ts';

// Where a window keeps its data, per provider (epic 383, step 2a): one server will hold every agent, so this layout must
// survive the move from "chosen by the process env" to "chosen by the agent".

const SESSION = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

let home: string;
let dist: string;
const prev = { home: process.env.NOTA_BENE_HOME, agent: process.env.NOTA_BENE_AGENT };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-layout-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-layout-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  for (const [k, v] of [['NOTA_BENE_HOME', prev.home], ['NOTA_BENE_AGENT', prev.agent]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

/** A window that marks its open session seen and archives another, then closes. */
async function run(extra: Partial<Parameters<typeof agentServer>[0]>): Promise<void> {
  const s = await agentServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist, ffmpeg: () => null, resume: SESSION, ...extra });
  try {
    const post = (p: string, body: unknown) => fetch(`${s.url}${p}`, { method: 'POST', headers: { origin: s.server, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/seen', { session: SESSION })).status).toBe(200);
    expect((await post('/sessions/archive', { id: OTHER, archived: true })).status).toBe(200);
  } finally {
    await s.close();
  }
}

it.each(['codex', 'omp'] as const)('a %s window keeps its data under providers/<p> (env-chosen, today)', async (p) => {
  process.env.NOTA_BENE_AGENT = p;
  await run({});
  const own = path.join(home, 'providers', p);
  expect(fs.existsSync(path.join(own, 'seen-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(own, 'archived-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(home, 'seen-sessions.json'))).toBe(false);
  expect(fs.existsSync(path.join(home, 'archived-sessions.json'))).toBe(false);
});

it('a claude window keeps its data in the base folder', async () => {
  process.env.NOTA_BENE_AGENT = 'claude';
  await run({});
  expect(fs.existsSync(path.join(home, 'seen-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(home, 'archived-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(home, 'providers'))).toBe(false);
});

it('an explicit agent context wins over the env', async () => {
  process.env.NOTA_BENE_AGENT = 'claude';
  await run({ agent: agentContext('codex', home) });
  const own = path.join(home, 'providers', 'codex');
  expect(fs.existsSync(path.join(own, 'seen-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(own, 'archived-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(home, 'seen-sessions.json'))).toBe(false);
});
