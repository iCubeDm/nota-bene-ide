import { expect, it, vi } from 'vitest';
import { codexBackend } from './codex/backend.ts';
import type { CodexConnection } from './codex/controls.ts';
import { acpBackend } from './acp/backend.ts';
import { OMP } from './acp/omp.ts';
import { sdkBackend } from './claude/sdk.ts';

const sdkDelete = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({ ...await real<object>(), deleteSession: sdkDelete }));

const ID = '11111111-1111-4111-8111-111111111111';

it('Claude deletes through the SDK (the transcript and its subagents)', async () => {
  const b = sdkBackend();
  expect(b.capabilities.deleteSession).toBe(true);
  await b.deleteSession!(ID);
  expect(sdkDelete).toHaveBeenCalledWith(ID);
});

it('Codex deletes with thread/delete', async () => {
  const calls: [string, unknown][] = [];
  const conn: CodexConnection = {
    request: async (method, params) => { calls.push([method, params]); return {}; },
    onNotification: () => () => {}, onRequest: () => {}, closed: new Promise(() => {}), close: async () => {},
  };
  const b = codexBackend({ connect: () => conn });
  expect(b.capabilities.deleteSession).toBe(true);
  await b.deleteSession!(ID);
  expect(calls).toEqual([['thread/delete', { threadId: ID }]]);
});

it('omp (ACP) cannot delete: no capability, no method', () => {
  const b = acpBackend(OMP);
  expect(b.capabilities.deleteSession).toBeFalsy();
  expect(b.deleteSession).toBeUndefined();
});
