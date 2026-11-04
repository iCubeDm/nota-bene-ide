import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentMode } from '@nota-bene/shared';
import type { AttachmentStore } from '../../attachments.ts';
import type { ProviderStartOptions } from '../types.ts';
import { acpBackend } from './backend.ts';
import { OMP } from './omp.ts';
import { AcpRpc, type AcpConnection } from './rpc.ts';
import { AcpSession } from './session.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../../../test/fixtures/acp-server.mjs');
let temp: string, project: string, state: string;
beforeEach(() => {
  vi.stubEnv('NOTA_BENE_OMP', FIXTURE); // the lease check runs the fixture, never a real omp
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-acp-'));
  project = path.join(fs.realpathSync(temp), 'project'); fs.mkdirSync(project);
  state = path.join(temp, 'state.json');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(temp, { recursive: true, force: true }); });

function backend() {
  const spawned: { mode: AgentMode; rpc: AcpConnection }[] = [];
  const b = acpBackend(OMP, {
    connect: (mode, cwd) => {
      const rpc = new AcpRpc({ name: 'omp', command: process.execPath, args: [FIXTURE, ...OMP.args(mode)], cwd, clientVersion: '0.0.0', env: { ...process.env, NB_ACP_FIXTURE_STATE: state } });
      spawned.push({ mode, rpc }); return rpc;
    },
  });
  const start = (o: Omit<ProviderStartOptions, 'ask'>) => {
    const s = b.start({ ask: async () => false, ...o });
    if (!(s instanceof AcpSession)) throw new Error('not an ACP session');
    return s;
  };
  return { b, start, spawned };
}
const reply = async (s: AcpSession, text: string) => {
  const events: AgentEvent[] = [];
  s.send({ uuid: text, text, priority: 'next' });
  for await (const e of s.messages) { events.push(e); if (e.t === 'turn-end') return events; }
  return events;
};

it('lists stored sessions, resumes one through the replay\'s own process and forks another', async () => {
  const { b, start, spawned } = backend();
  const first = start({ cwd: project, permissionMode: 'omp-write' });
  await first.ready;
  const events = await reply(first, 'hello');
  expect(events.find((e) => e.t === 'message')).toMatchObject({ text: 'omp: hello' });
  const id = first.sessionId;
  first.close();
  const list = await b.listSessions();
  expect(list).toEqual([expect.objectContaining({ sessionId: id, cwd: project, customTitle: 'ACP fixture', fileSize: 100 })]);
  expect(await b.sessionInfo(id, project)).toEqual({ cwd: project, customTitle: 'ACP fixture' });
  expect(await b.sessionInfo(id, temp)).toBeNull();

  const before = spawned.length;
  const history = await b.history(id, project, {} as AttachmentStore);
  expect(history).toEqual([{ kind: 'user', id: 'acp-u1', text: 'hello', ts: 0, historic: true }, { kind: 'agent', e: { t: 'message', id: 'acp-b0', text: 'omp: hello' }, ts: 0 }]);
  const resumed = start({ cwd: project, resume: id, permissionMode: 'omp-write' });
  await resumed.ready;
  expect(spawned.length).toBe(before + 1); // the replay's process goes on as the session
  expect(resumed.sessionId).toBe(id);
  resumed.close();

  const forked = start({ cwd: project, resume: id, fork: true, permissionMode: 'omp-write' });
  await forked.ready;
  expect(forked.sessionId).not.toBe(id);
  await expect(b.history('01a1a000-0000-7000-8000-999999999999', project, {} as AttachmentStore)).rejects.toThrow('omp conversation not found');
  await b.close?.();
});

it('a mode on another approval level respawns on the same stored session, and the agent then asks', async () => {
  const { b, start, spawned } = backend();
  const asked: string[] = [];
  const s = start({ cwd: project, permissionMode: 'omp-yolo', interact: async (p) => { asked.push(p.title); return { choice: 'allow_once' }; } });
  await s.ready;
  expect((await reply(s, 'run it')).find((e) => e.t === 'message')).toMatchObject({ text: 'ran it' });
  expect(asked).toEqual([]);
  await s.setPermissionMode('omp-ask');
  expect(spawned.map((x) => x.mode)).toEqual(['omp-yolo', 'omp-ask']);
  expect((await reply(s, 'run again')).find((e) => e.t === 'tool-update')).toMatchObject({ text: 'ok', isError: false });
  expect(asked).toEqual(['echo hi']);
  await b.close?.();
});

it('a restart reads history while the closing session is still going down, and the adopting session gets omp\'s commands', async () => {
  const { b, start } = backend();
  const first = start({ cwd: project, permissionMode: 'omp-write' });
  await first.ready; await reply(first, 'hello');
  const id = first.sessionId;
  first.close();
  expect((await b.history(id, project, {} as AttachmentStore)).some((e) => e.kind === 'user')).toBe(true);
  const resumed = start({ cwd: project, resume: id, permissionMode: 'omp-write' });
  await resumed.ready;
  expect(resumed.sessionId).toBe(id);
  expect((await resumed.supportedCommands()).map((c) => c.name)).toContain('green');
  resumed.close();
  await b.close?.();
});
