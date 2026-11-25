import path from 'node:path';

import type { AgentProvider } from '@nota-bene/shared';

export type { AgentProvider };

export const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'omp'];

export function parseProvider(value: string | undefined): AgentProvider {
  if (value === undefined || value === 'claude') return 'claude';
  if (value === 'codex' || value === 'omp') return value;
  throw new Error(`Invalid agent: ${value}. Expected claude, codex or omp.`);
}

/** Where an agent of `provider` keeps its data: Claude in the base itself (as before the others came), the others apart. */
export function providerStateDir(base: string, provider: AgentProvider): string {
  return provider === 'claude' ? base : path.join(base, 'providers', provider);
}
