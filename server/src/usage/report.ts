// Normalized records to the report. Pure, so the numbers are testable without a transcript.
import path from 'node:path';
import type {
  TokenCounts, UsageAgentRow, UsageCallRow, UsageHit, UsagePeriod, UsageProvider, UsageReport, UsageRow, UsageTaskRow, UsageTank,
} from '@nota-bene/shared';
import type { CallRecord, LimitRecord, PromptRecord, UsageRecord } from './parse.ts';

/** The comparison number: a yardstick, not a price, and the same for every model (the design note says why). */
export const WEIGHTS: TokenCounts = { in: 1, write: 1.25, read: 0.1, out: 5 };
export const weigh = (c: TokenCounts): number => c.in * WEIGHTS.in + c.write * WEIGHTS.write + c.read * WEIGHTS.read + c.out * WEIGHTS.out;

const DAY = 864e5, HOUR = 36e5;
const WEEK_MINUTES = 7 * 24 * 60;
/** Hits this close are one event: the agent retried, or another window hit the same wall. */
const HIT_MERGE_MS = 2 * HOUR;
const TOP_TASKS = 20, TOP_CALLS = 5, HIT_TASKS = 3;
const PERIOD_DAYS: Partial<Record<UsagePeriod, number>> = { '7d': 7, '30d': 30 };

const zero = (): UsageRow => ({ in: 0, out: 0, write: 0, read: 0, calls: 0, w: 0, sub: 0 });

function add(row: UsageRow, c: CallRecord): void {
  const w = weigh(c);
  row.in += c.in; row.out += c.out; row.write += c.write; row.read += c.read;
  row.calls++;
  row.w += w;
  if (c.agent) row.sub += w;
}

const addTo = (m: Map<string, UsageRow>, key: string, c: CallRecord): void => {
  let row = m.get(key);
  if (!row) m.set(key, row = zero());
  add(row, c);
};

const bump = (o: Record<string, number>, key: string, by: number): void => { o[key] = (o[key] ?? 0) + by; };

const ranked = (m: Map<string, UsageRow>) => [...m].map(([key, r]) => ({ key, ...r })).sort((a, b) => b.w - a.w);

/** One call per id, each field at its maximum: a call spans lines and its counters only grow, and forks copy it. */
export function mergeCalls(records: readonly UsageRecord[]): CallRecord[] {
  const byId = new Map<string, CallRecord>();
  for (const r of records) {
    if (r.k !== 'c') continue;
    const a = byId.get(r.id);
    if (!a) { byId.set(r.id, { ...r }); continue; }
    a.in = Math.max(a.in, r.in); a.out = Math.max(a.out, r.out); a.write = Math.max(a.write, r.write); a.read = Math.max(a.read, r.read);
    if (r.ts < a.ts) a.ts = r.ts; // the first sight: a fork's copy must not move the call to the fork
  }
  return [...byId.values()];
}

/** A call's project: the folder its session started in. The agent wanders into subfolders and worktrees, and those are no projects. */
function projectFinder(calls: readonly CallRecord[]) {
  const start = new Map<string, CallRecord>();
  for (const c of calls) {
    const a = start.get(c.session);
    if (c.cwd && (!a || c.ts < a.ts)) start.set(c.session, c);
  }
  return (c: CallRecord): string => path.basename(start.get(c.session)?.cwd ?? c.cwd) || '?';
}
type Project = ReturnType<typeof projectFinder>;

/** The task of a call: named by the transcript, or the session's last prompt before it. */
function taskFinder(records: readonly UsageRecord[]) {
  const prompts = new Map<string, PromptRecord[]>();
  const named = new Map<string, PromptRecord>();
  for (const r of records) {
    if (r.k !== 'p') continue;
    if (r.task) named.set(r.task, r);
    let list = prompts.get(r.session);
    if (!list) prompts.set(r.session, list = []);
    list.push(r);
  }
  for (const list of prompts.values()) list.sort((a, b) => a.ts - b.ts);
  return (c: CallRecord): { id: string; ts: number; label: string } => {
    if (c.task) {
      const p = named.get(c.task);
      return { id: c.task, ts: p?.ts ?? c.ts, label: p?.label ?? '' };
    }
    const list = prompts.get(c.session) ?? [];
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.ts <= c.ts) lo = mid + 1; else hi = mid;
    }
    const p = list[lo - 1];
    return { id: `${c.session}:${p?.ts ?? 0}`, ts: p?.ts ?? c.ts, label: p?.label ?? '' };
  };
}

function tasksOf(calls: readonly CallRecord[], records: readonly UsageRecord[], project: Project): UsageTaskRow[] {
  const find = taskFinder(records);
  const names = new Map<string, string>();
  for (const r of records) if (r.k === 'a') names.set(r.id, r.label);
  type Open = { row: UsageRow; id: string; ts: number; label: string; project: string; models: Record<string, number>; agents: Map<string, UsageAgentRow>; calls: UsageCallRow[] };
  const tasks = new Map<string, Open>();
  for (const c of calls) {
    const t = find(c);
    let o = tasks.get(t.id);
    if (!o) tasks.set(t.id, o = { row: zero(), ...t, project: project(c), models: {}, agents: new Map(), calls: [] });
    add(o.row, c);
    const w = weigh(c);
    bump(o.models, c.model, w);
    o.calls.push({ ts: c.ts, model: c.model, in: c.in, out: c.out, write: c.write, read: c.read, w, ...(c.agent ? { agent: c.agent } : {}) });
    if (c.agent) {
      let a = o.agents.get(c.agent);
      if (!a) o.agents.set(c.agent, a = { id: c.agent, label: names.get(c.agent) ?? '', model: c.model, calls: 0, w: 0 });
      a.calls++;
      a.w += w;
    }
  }
  return [...tasks.values()].sort((a, b) => b.row.w - a.row.w).slice(0, TOP_TASKS).map((o) => ({
    ...o.row, id: o.id, ts: o.ts, label: o.label, project: o.project, models: o.models,
    agents: [...o.agents.values()].sort((a, b) => b.w - a.w),
    top: o.calls.sort((a, b) => b.w - a.w).slice(0, TOP_CALLS),
  }));
}

type HitEvent = { ts: number; kind: UsageHit['kind']; resets?: number };

function hitEvents(records: readonly UsageRecord[]): HitEvent[] {
  const events: HitEvent[] = [];
  const sorted = records.flatMap((r) => (r.k === 'h' ? [r] : [])).sort((a, b) => a.ts - b.ts);
  for (const h of sorted) {
    const same = events.findLast((e) => e.kind === h.kind);
    if (!same || (h.ts - same.ts >= HIT_MERGE_MS && (h.resets === undefined || h.resets !== same.resets))) {
      events.push({ ts: h.ts, kind: h.kind, ...(h.resets ? { resets: h.resets } : {}) });
    } else {
      same.resets ??= h.resets;
    }
  }
  return events;
}

/** The tokens in the window that ended with each hit. */
function hitsOf(events: readonly HitEvent[], calls: readonly CallRecord[], records: readonly UsageRecord[], project: Project): UsageHit[] {
  const find = taskFinder(records);
  return events.map((e) => {
    const since = e.ts - (e.kind === 'week' ? 7 * DAY : 5 * HOUR);
    const hit: UsageHit = { ts: e.ts, kind: e.kind, calls: 0, w: 0, projects: {}, models: {}, tasks: [] };
    const tasks = new Map<string, UsageHit['tasks'][number]>();
    for (const c of calls) {
      if (c.ts <= since || c.ts > e.ts) continue;
      const w = weigh(c);
      hit.calls++;
      hit.w += w;
      bump(hit.projects, project(c), w);
      bump(hit.models, c.model, w);
      const { id, label } = find(c);
      const t = tasks.get(id);
      if (t) t.w += w; else tasks.set(id, { id, label, w });
    }
    hit.tasks = [...tasks.values()].sort((a, b) => b.w - a.w).slice(0, HIT_TASKS);
    return hit;
  });
}

/** Windows of work, oldest first. A hit closes its own, so its bar and its row say the same; the rest open with the first call outside. */
function windowsOf(calls: readonly CallRecord[], hits: readonly UsageHit[]): UsageReport['windows'] {
  const closed = hits.filter((h) => h.kind === '5h').map((h) => ({ from: h.ts - 5 * HOUR, to: h.ts, w: h.w }));
  const out: UsageReport['windows'] = closed.map(({ from, w }) => ({ from, w, hit: true }));
  let open: UsageReport['windows'][number] | undefined;
  for (const c of calls.toSorted((a, b) => a.ts - b.ts)) {
    if (closed.some((h) => c.ts > h.from && c.ts <= h.to)) continue;
    if (!open || c.ts >= open.from + 5 * HOUR) out.push(open = { from: c.ts, w: 0, hit: false });
    open.w += weigh(c);
  }
  return out.sort((a, b) => a.from - b.from);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The Monday of `ts`, local time. */
export function weekKey(ts: number): string {
  const d = new Date(ts);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weeksOf(calls: readonly CallRecord[], events: readonly HitEvent[]): UsageReport['weeks'] {
  const m = new Map<string, number>();
  for (const c of calls) m.set(weekKey(c.ts), (m.get(weekKey(c.ts)) ?? 0) + weigh(c));
  const hit = new Set(events.filter((e) => e.kind === 'week').map((e) => weekKey(e.ts)));
  const keys = [...m.keys()].sort();
  const out: UsageReport['weeks'] = [];
  for (const key of keys.slice(0, 1)) {
    const last = keys[keys.length - 1]!;
    const d = new Date(`${key}T12:00:00`); // noon: a clock change cannot move it to another day
    for (let k = key; k <= last; d.setDate(d.getDate() + 7), k = weekKey(d.getTime())) out.push({ key: k, w: m.get(k) ?? 0, hit: hit.has(k) });
  }
  return out;
}

/** Tokens per percent of each weekly limit window, from its first to its last reading. */
function tanksOf(calls: readonly CallRecord[], records: readonly UsageRecord[]): UsageTank[] {
  const windows = new Map<number, LimitRecord[]>();
  for (const r of records) {
    if (r.k !== 'l' || r.minutes !== WEEK_MINUTES || r.resets === null) continue;
    let list = windows.get(r.resets);
    if (!list) windows.set(r.resets, list = []);
    list.push(r);
  }
  const out: UsageTank[] = [];
  for (const list of windows.values()) {
    list.sort((a, b) => a.ts - b.ts);
    const first = list[0]!, last = list[list.length - 1]!, pct = last.pct - first.pct;
    if (pct < 1) continue;
    const w = calls.reduce((sum, c) => (c.ts > first.ts && c.ts <= last.ts ? sum + weigh(c) : sum), 0);
    out.push({ from: first.ts, to: last.ts, pct, w, perPct: w / pct });
  }
  return out.sort((a, b) => a.from - b.from);
}

export function periodStart(period: UsagePeriod, trip: number | null, now: number): number | null {
  if (period === 'trip') return trip;
  const days = PERIOD_DAYS[period];
  return days ? now - days * DAY : null;
}

export function buildReport(records: readonly UsageRecord[], o: { provider: UsageProvider; period: UsagePeriod; trip: number | null; importing: boolean; now: number }): UsageReport {
  const every = mergeCalls(records);
  const from = periodStart(o.period, o.trip, o.now);
  const calls = from === null ? every : every.filter((c) => c.ts >= from);
  const project = projectFinder(every);
  const events = hitEvents(records);
  const hits = hitsOf(events, every, records, project);
  const total = zero();
  const models = new Map<string, UsageRow>(), projects = new Map<string, UsageRow>();
  for (const c of calls) {
    add(total, c);
    addTo(models, c.model, c);
    addTo(projects, project(c), c);
  }
  return {
    provider: o.provider, period: o.period, from, trip: o.trip, importing: o.importing, total,
    models: ranked(models), projects: ranked(projects), tasks: tasksOf(calls, records, project),
    hits: hits.filter((h) => from === null || h.ts >= from), windows: windowsOf(every, hits), weeks: weeksOf(every, events), tanks: tanksOf(every, records),
  };
}
