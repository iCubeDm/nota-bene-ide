import { describe, expect, it } from 'vitest';
import { buildReport, mergeCalls, periodStart, weekKey, weigh } from './report.ts';
import type { CallRecord, UsageRecord } from './parse.ts';

const H = 36e5, D = 24 * H;
const T0 = Date.parse('2026-10-05T12:00:00');
const call = (o: Partial<CallRecord> = {}): CallRecord => ({ k: 'c', id: 'm1', ts: T0, cwd: '/work/app', session: 's', model: 'opus', in: 0, out: 0, write: 0, read: 0, ...o });
const report = (records: UsageRecord[], o: Partial<Parameters<typeof buildReport>[1]> = {}) =>
  buildReport(records, { provider: 'claude', period: 'all', trip: null, importing: false, now: T0 + 30 * D, ...o });

it('weigh: cache reads are cheap, output is dear', () => {
  expect(weigh({ in: 10, write: 100, read: 1000, out: 2 })).toBe(10 + 125 + 100 + 10);
});

describe('mergeCalls', () => {
  it('lines of one call merge to the maximum of each field', () => {
    const [c, ...rest] = mergeCalls([call({ out: 1, read: 50 }), call({ out: 90, read: 50 }), call({ out: 40, read: 50 })]);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ out: 90, read: 50 });
  });
  it("a fork's copy, later, leaves the call at its first sight", () => {
    expect(mergeCalls([call({ ts: T0 + H, session: 'fork' }), call({ ts: T0 })])[0]!.ts).toBe(T0);
  });
});

describe('totals, models, projects', () => {
  it('split by model and project, ranked by weight, subagents counted apart', () => {
    const r = report([
      call({ id: 'a', out: 100 }),
      call({ id: 'b', out: 10, model: 'sonnet', agent: 'x' }),
      call({ id: 'c', out: 1, cwd: '/work/other' }),
    ]);
    expect(r.total).toMatchObject({ calls: 3, out: 111, w: 555, sub: 50 });
    expect(r.models.map((m) => m.key)).toEqual(['opus', 'sonnet']);
    expect(r.projects.map((p) => [p.key, p.calls])).toEqual([['app', 2], ['other', 1]]);
  });

  it('the period cuts calls; the weeks stay whole', () => {
    const r = report([call({ id: 'old', ts: T0, out: 1 }), call({ id: 'new', ts: T0 + 29 * D, out: 1 })], { period: '7d' });
    expect(r.total.calls).toBe(1);
    expect(r.weeks).toHaveLength(2);
  });

  it('since the reset; never reset means everything', () => {
    expect(periodStart('trip', 5, 100)).toBe(5);
    expect(periodStart('trip', null, 100)).toBeNull();
    expect(periodStart('all', 5, 100)).toBeNull();
    expect(periodStart('7d', null, 8 * D)).toBe(D);
  });
});

describe('tasks', () => {
  it('a call belongs to the last prompt of its session, subagents included', () => {
    const r = report([
      { k: 'p', ts: T0, session: 's', label: 'first' },
      { k: 'p', ts: T0 + H, session: 's', label: 'second' },
      { k: 'a', id: 'x', label: 'Explore: routes' },
      call({ id: 'a', ts: T0 + 1, out: 1 }),
      call({ id: 'b', ts: T0 + H + 1, out: 10 }),
      call({ id: 'c', ts: T0 + H + 2, out: 20, model: 'sonnet', agent: 'x' }),
    ]);
    expect(r.tasks.map((t) => [t.label, t.calls])).toEqual([['second', 2], ['first', 1]]);
    const [t] = r.tasks;
    expect(t).toMatchObject({ project: 'app', models: { opus: 50, sonnet: 100 } });
    expect(t!.agents).toEqual([{ id: 'x', label: 'Explore: routes', model: 'sonnet', calls: 1, w: 100 }]);
    expect(t!.top[0]).toMatchObject({ agent: 'x', w: 100 });
  });

  it('a task the transcript names: every thread of it together, even after a later prompt elsewhere', () => {
    const r = report([
      { k: 'p', ts: T0, session: 's', label: 'do it', task: 't1' },
      call({ id: 'a', task: 't1', out: 1 }),
      call({ id: 'b', task: 't1', out: 1, session: 'other', agent: 'x' }),
    ]);
    expect(r.tasks.map((t) => [t.label, t.calls])).toEqual([['do it', 2]]);
  });

  it('a call before any prompt still counts, unlabelled', () => {
    expect(report([call({ out: 1 })]).tasks[0]).toMatchObject({ label: '', calls: 1 });
  });
});

describe('hits', () => {
  it('counts the five hours before, by project and model; hits within two hours are one', () => {
    const r = report([
      call({ id: 'old', ts: T0 - 6 * H, out: 100 }),
      call({ id: 'a', ts: T0 - 4 * H, out: 1 }),
      call({ id: 'b', ts: T0 - H, out: 2, cwd: '/work/other', model: 'sonnet' }),
      call({ id: 'after', ts: T0 + H, out: 100 }),
      { k: 'h', ts: T0, kind: '5h' }, { k: 'h', ts: T0 + H, kind: '5h' },
    ]);
    expect(r.hits).toEqual([{ ts: T0, kind: '5h', calls: 2, w: 15, projects: { app: 5, other: 10 }, models: { opus: 5, sonnet: 10 } }]);
  });

  it('a week hit looks back seven days; a chain of hits stays apart from the next window', () => {
    const r = report([
      call({ id: 'a', ts: T0 - 6 * D, out: 1 }),
      { k: 'h', ts: T0, kind: 'week' },
      { k: 'h', ts: T0 + 3 * H, kind: '5h' }, { k: 'h', ts: T0 + 8 * H, kind: '5h' },
    ]);
    expect(r.hits.map((h) => [h.kind, h.calls])).toEqual([['week', 1], ['5h', 0], ['5h', 0]]);
  });

  it('a hit before the period is out, and its window still looks before the period', () => {
    const records: UsageRecord[] = [call({ id: 'a', ts: T0 - H, out: 1 }), { k: 'h', ts: T0, kind: '5h' }, { k: 'h', ts: T0 + 29 * D, kind: '5h' }];
    expect(report(records, { period: '7d' }).hits).toHaveLength(1);
    expect(report(records, { period: 'trip', trip: T0 - 30 * 60_000 }).hits[0]).toMatchObject({ ts: T0, calls: 1 });
  });
});

describe('tank', () => {
  const week = 10080;
  it('tokens per percent of one weekly window, from its first to its last reading', () => {
    const r = report([
      { k: 'l', ts: T0, minutes: week, pct: 10, resets: 1 },
      { k: 'l', ts: T0 + D, minutes: week, pct: 20, resets: 1 },
      call({ id: 'before', ts: T0 - 1, out: 100 }),
      call({ id: 'in', ts: T0 + H, out: 200 }),
    ]);
    expect(r.tanks).toEqual([{ from: T0, to: T0 + D, pct: 10, w: 1000, perPct: 100 }]);
  });

  it('under one percent is no measurement; five-hour readings are not the tank', () => {
    expect(report([
      { k: 'l', ts: T0, minutes: week, pct: 10, resets: 1 }, { k: 'l', ts: T0 + D, minutes: week, pct: 10.5, resets: 1 },
      { k: 'l', ts: T0, minutes: 300, pct: 1, resets: 2 }, { k: 'l', ts: T0 + D, minutes: 300, pct: 50, resets: 2 },
    ]).tanks).toEqual([]);
  });
});

it('weekKey: the Monday, also from a Sunday night', () => {
  expect(weekKey(Date.parse('2026-10-05T00:30:00'))).toBe('2026-10-05');
  expect(weekKey(Date.parse('2026-10-11T23:30:00'))).toBe('2026-10-05');
});
