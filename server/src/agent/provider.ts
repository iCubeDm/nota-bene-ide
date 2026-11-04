import path from 'node:path';

export type AgentProvider = 'claude' | 'codex' | 'omp';

export function parseProvider(value: string | undefined): AgentProvider {
  if (value === undefined || value === 'claude') return 'claude';
  if (value === 'codex' || value === 'omp') return value;
  throw new Error(`Invalid agent: ${value}. Expected claude, codex or omp.`);
}

/** Legacy Claude storage is unchanged; all Codex-owned data/secrets are separate. */
export function providerStateDir(base: string, provider: AgentProvider): string {
  return provider === 'claude' ? base : path.join(base, 'providers', provider);
}
