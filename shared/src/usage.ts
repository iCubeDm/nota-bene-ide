// The usage report: exact token accounting from the agents' transcripts (docs/superpowers/specs/2026-11-01-usage-analytics-design.md).

export type UsageProvider = 'claude' | 'codex';
export type UsagePeriod = 'trip' | '7d' | '30d' | 'all';
export const USAGE_PERIODS: readonly UsagePeriod[] = ['trip', '7d', '30d', 'all'];

/** Fresh input, output, cache write, cache read. `in` never includes the cached part. */
export type TokenCounts = { in: number; out: number; write: number; read: number };

/** `w`: weighted tokens, the comparison number; `sub`: the part of `w` spent by subagents. */
export type UsageRow = TokenCounts & { calls: number; w: number; sub: number };

export type UsageCallRow = TokenCounts & { ts: number; model: string; w: number; agent?: string };
export type UsageAgentRow = { id: string; label: string; model: string; calls: number; w: number };
export type UsageTaskRow = UsageRow & {
  id: string; ts: number; label: string; project: string; models: Record<string, number>; agents: UsageAgentRow[]; top: UsageCallRow[];
};
export type UsageHit = {
  ts: number; kind: '5h' | 'week'; calls: number; w: number; projects: Record<string, number>; models: Record<string, number>;
  /** the costliest tasks of the window */
  tasks: { id: string; label: string; w: number }[];
};
/** One weekly limit window: the tokens between its first and last reading, per percent gained. */
export type UsageTank = { from: number; to: number; pct: number; w: number; perPct: number };

export type UsageReport = {
  provider: UsageProvider; period: UsagePeriod;
  /** the start of the period; null: all of it */
  from: number | null;
  /** the last reset; null: never */
  trip: number | null;
  /** the first import is still running: the numbers will grow */
  importing: boolean;
  total: UsageRow;
  models: (UsageRow & { key: string })[];
  projects: (UsageRow & { key: string })[];
  tasks: UsageTaskRow[];
  hits: UsageHit[];
  /** every week since the first, idle ones too, whatever the period; `key`: its Monday, YYYY-MM-DD, local time; `hit`: a limit was hit in it */
  weeks: { key: string; w: number; hit: boolean }[];
  tanks: UsageTank[];
};
