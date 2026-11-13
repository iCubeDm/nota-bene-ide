import { expect, it, vi } from 'vitest';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

const sdkQuery = vi.hoisted(() => vi.fn(() => ({ close() {} })));
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({ ...await real<object>(), query: sdkQuery }));
const { sdkBackend, toModelOption } = await import('./sdk.ts');

it('toModelOption: the effort levels only for a model that supports effort; the resolved id when there is one', () => {
  const base = { value: 'sonnet', displayName: 'Sonnet', description: 'd' } satisfies ModelInfo;
  expect(toModelOption({ ...base, resolvedModel: 'claude-sonnet-5', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }))
    .toEqual({ value: 'sonnet', name: 'Sonnet', description: 'd', resolved: 'claude-sonnet-5', efforts: ['low', 'high'] });
  expect(toModelOption({ ...base, supportsEffort: false, supportedEffortLevels: ['low'] })).toEqual({ value: 'sonnet', name: 'Sonnet', description: 'd' });
  expect(toModelOption({ ...base, supportsEffort: true, supportedEffortLevels: [] })).toEqual({ value: 'sonnet', name: 'Sonnet', description: 'd' });
});

it('the session declares its per-task Stop: an interrupt ends the turn and spares the background agents', () => {
  sdkBackend().start({ cwd: '/project', permissionMode: 'default', ask: async () => true });
  const [{ options }] = sdkQuery.mock.calls.at(-1) as unknown as [{ options: { perTaskStopAffordance?: boolean } }];
  expect(options.perTaskStopAffordance).toBe(true);
});
