import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeSource, codexSource, importUsage } from './importer.ts';
import { mergeCalls } from './report.ts';
import { limitRecorder, UsageService } from './routes.ts';
import { readLines, UsageStore } from './store.ts';

let tmp: string, dir: string, store: UsageStore;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-usage-'));
  dir = path.join(tmp, 'usage');
  store = new UsageStore('claude', dir);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ts = '2026-10-01T10:00:00.000Z';
const call = (id: string, out: number, cwd = '/work/app') => JSON.stringify({
  type: 'assistant', timestamp: ts, cwd, message: { id, model: 'opus', usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 } },
}) + '\n';
const prompt = (text: string) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: text } }) + '\n';
const write = (rel: string, text: string, append = false) => {
  const f = path.join(tmp, 'projects', rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (append) fs.appendFileSync(f, text); else fs.writeFileSync(f, text);
  return f;
};
const source = () => claudeSource(path.join(tmp, 'projects'));
const calls = async (s = store) => mergeCalls(await new UsageStore(s.provider, dir).load());

describe('readLines', () => {
  it('stops at the last complete line and goes on from there, over chunk borders and multi-byte text', async () => {
    const f = path.join(tmp, 'f');
    const long = 'ж'.repeat(400_000);
    fs.writeFileSync(f, `a\n${long}\nhalf`);
    const seen: string[] = [];
    const at = await readLines(f, 0, (l) => seen.push(l));
    expect(seen).toEqual(['a', long]);
    fs.appendFileSync(f, 'done\n');
    seen.length = 0;
    expect(await readLines(f, at, (l) => seen.push(l))).toBe(fs.statSync(f).size);
    expect(seen).toEqual(['halfdone']);
  });
});

describe('importUsage', () => {
  it('reads sessions and subagents, names a subagent, sets the store to mode 600', async () => {
    write('p/s1.jsonl', prompt('hello') + call('m1', 5));
    write('p/s1/subagents/agent-a1.jsonl', call('m2', 7));
    write('p/s1/subagents/agent-a1.meta.json', JSON.stringify({ agentType: 'Explore', description: 'routes' }));
    expect(await importUsage(store, source())).toBe(true);
    expect((await calls()).map((c) => [c.id, c.session, c.agent]).sort()).toEqual([['m1', 's1', undefined], ['m2', 's1', 'a1']]);
    expect((await store.load()).some((r) => r.k === 'a' && r.label === 'Explore: routes')).toBe(true);
    expect(fs.statSync(path.join(dir, 'claude.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('a second pass reads only what was appended', async () => {
    write('p/s1.jsonl', call('m1', 5));
    await importUsage(store, source());
    const size = fs.statSync(path.join(dir, 'claude.jsonl')).size;
    await importUsage(store, source());
    expect(fs.statSync(path.join(dir, 'claude.jsonl')).size).toBe(size);
    write('p/s1.jsonl', call('m2', 6), true);
    await importUsage(store, source());
    expect((await calls()).map((c) => c.id)).toEqual(['m1', 'm2']);
  });

  it('a file read by an older parser is read once more: its counts stay single, its labels catch up', async () => {
    write('p/s1.jsonl', prompt('Comments on fragments:\n\n1. [x]\n> a quote\n→ why so') + call('m1', 5));
    await importUsage(store, source());
    const state = store.readState();
    store.writeState(Object.fromEntries(Object.entries(state).map(([f, v]) => [f, { offset: v.offset }])));
    store.append([{ k: 'p', ts: 0, session: 'old', label: 'kept' }]);
    await importUsage(store, source());
    const size = fs.statSync(path.join(dir, 'claude.jsonl')).size;
    await importUsage(store, source());
    expect(fs.statSync(path.join(dir, 'claude.jsonl')).size).toBe(size);
    expect((await calls()).map((c) => c.id)).toEqual(['m1']);
    expect((await store.load()).some((r) => r.k === 'p' && r.label === 'why so')).toBe(true);
    expect((await store.load()).some((r) => r.k === 'p' && r.label === 'kept')).toBe(true);
  });

  it("a call's later line that grew is kept, an equal one is not, a fork's copy is one call", async () => {
    write('p/s1.jsonl', call('m1', 1) + call('m1', 90) + call('m1', 90));
    await importUsage(store, source());
    expect((await store.load()).length).toBe(2);
    write('p/z-fork.jsonl', call('m1', 90));
    await importUsage(store, source());
    expect((await store.load()).length).toBe(2);
    expect(await calls()).toHaveLength(1);
    expect((await calls())[0]).toMatchObject({ out: 90 });
  });

  it('survives its state being lost: nothing is counted twice', async () => {
    write('p/s1.jsonl', prompt('hi') + call('m1', 5));
    await importUsage(store, source());
    const n = (await store.load()).length;
    fs.rmSync(path.join(dir, 'claude.state.json'));
    await importUsage(store, source());
    expect((await store.load()).length).toBe(n);
  });

  it('keeps what it knows when the transcript is deleted', async () => {
    const f = write('p/s1.jsonl', call('m1', 5));
    await importUsage(store, source());
    fs.rmSync(f);
    await importUsage(store, source());
    expect(await calls()).toHaveLength(1);
  });

  it('a rewritten, smaller file is read anew', async () => {
    write('p/s1.jsonl', call('m1', 5) + call('m2', 5));
    await importUsage(store, source());
    write('p/s1.jsonl', call('m3', 5));
    await importUsage(store, source());
    expect((await calls()).map((c) => c.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('skips a temporary folder', async () => {
    write('p/s1.jsonl', call('m1', 5, '/tmp/smoke') + call('m2', 5));
    await importUsage(store, source());
    expect((await calls()).map((c) => c.id)).toEqual(['m2']);
  });

  it('another window holds the lock: this one does nothing; a stale lock is taken over', async () => {
    write('p/s1.jsonl', call('m1', 5));
    const held = store.lock(60_000)!;
    expect(await importUsage(store, source())).toBe(false);
    expect(store.lock(60_000, Date.now() + 120_000)).not.toBeNull();
    held.release();
  });

  it('codex: the context survives between imports', async () => {
    const line = (type: string, payload: object) => JSON.stringify({ timestamp: ts, type, payload }) + '\n';
    const rollout = path.join(tmp, 'codex/sessions/2026/r.jsonl');
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, line('session_meta', { id: 't1', cwd: '/work/app' }) + line('turn_context', { model: 'gpt' }));
    const s = new UsageStore('codex', dir), src = codexSource(path.join(tmp, 'codex'));
    await importUsage(s, src);
    fs.appendFileSync(rollout, line('token_usage_record', { response_id: 'r1', usage: { input_tokens: 5, output_tokens: 1 } }));
    await importUsage(s, src);
    expect((await calls(s))[0]).toMatchObject({ id: 'r1', session: 't1', model: 'gpt', cwd: '/work/app' });
  });
});

describe('trips', () => {
  it('per provider; a reset deletes nothing', async () => {
    store.append([{ k: 'h', ts: 1, kind: '5h' }]);
    expect(store.trip()).toBeNull();
    store.resetTrip(5);
    new UsageStore('codex', dir).resetTrip(9);
    expect(store.trip()).toBe(5);
    expect(new UsageStore('codex', dir).trip()).toBe(9);
    expect(await store.load()).toHaveLength(1);
  });
});

describe('limitRecorder', () => {
  it('records a reading when it moved, by window', async () => {
    const rec = limitRecorder(store, () => 7);
    const stats = (u: number) => ({ context: null, cost: null, limits: { five_hour: null, seven_day: { utilization: u, resets_at: '2026-10-01T10:00:00.000Z' } } });
    rec(stats(10)); rec(stats(10)); rec(stats(11));
    rec({ context: null, cost: null, limits: null });
    expect(await store.load()).toEqual([
      { k: 'l', ts: 7, minutes: 10080, pct: 10, resets: Date.parse(ts) },
      { k: 'l', ts: 7, minutes: 10080, pct: 11, resets: Date.parse(ts) },
    ]);
  });
});

describe('UsageService', () => {
  it('imports at most every 15 s, and one at a time', async () => {
    let lists = 0, t = 0;
    const s = new UsageService('claude', { store, source: { files: () => { lists++; return []; }, reader: () => ({ line: () => [] }) }, now: () => t });
    await s.refresh();
    await s.refresh();
    expect(lists).toBe(1);
    t = 16_000;
    await Promise.all([s.refresh(), s.refresh()]);
    expect(lists).toBe(2);
  });

  it('answers at once while importing and says so; a failed import reaches onError', async () => {
    const errors: unknown[] = [];
    const source = { files: () => { throw new Error('boom'); }, reader: () => ({ line: () => [] }) };
    const s = new UsageService('claude', { store, source, onError: (e) => errors.push(e) });
    const r = await s.report('all');
    expect(r.total.calls).toBe(0);
    await s.refresh();
    expect(errors).toHaveLength(1);
  });
});
