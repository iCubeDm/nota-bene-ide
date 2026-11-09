import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fakeBackend } from './agent/fake.ts';
import { mapSdk } from './agent/claude/map.ts';
import { AuditLog, auditNote, KEEP_DAYS } from './audit.ts';
import { EventHub } from './hub.ts';
import { startServer } from './server.ts';

let dir: string;
const logs: AuditLog[] = [];
const NOW = Date.parse('2026-11-03T16:27:10.025Z');
const mk = (o: Partial<ConstructorParameters<typeof AuditLog>[0]> = {}) => {
  const a = new AuditLog({ port: 4778, dir, now: () => NOW, enabled: () => true, ...o });
  logs.push(a);
  return a;
};
const lines = (day = '2026-11-03') => {
  const f = path.join(dir, `${day}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};
const raw = () => fs.readFileSync(path.join(dir, '2026-11-03.jsonl'), 'utf8');

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-audit-')), 'audit');
});
afterEach(() => {
  while (logs.length) logs.pop()!.close();
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

it('one JSON line per event, in a private day file of a private folder', () => {
  const a = mk();
  a.write('server-start', { root: '/proj', skip: undefined });
  expect(lines()).toEqual([{ ts: '2026-11-03T16:27:10.025Z', port: 4778, pid: process.pid, ev: 'server-start', root: '/proj' }]);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(dir, '2026-11-03.jsonl')).mode & 0o777).toBe(0o600);
});

it('what the page asked for, never what it said', () => {
  const a = mk();
  a.client({ type: 'send', id: 'u1', text: 'my secret plan', force: true, commentIds: ['c1', 'c2'] }, 3);
  a.client({ type: 'interrupt' }, 3);
  a.client({ type: 'shell-run', id: 's1', cmd: 'export TOKEN=hunter2' }, 3);
  a.client({ type: 'permission', id: 'p1', allow: true, response: { choice: 'my answer' } }, 3);
  a.client({ type: 'comments', sessionId: 's', items: [] }, 3);
  a.client({ type: 'activity' }, 3);
  expect(lines().map(({ ts: _t, pid: _p, ...r }) => r)).toEqual([
    { port: 4778, ev: 'client', conn: 3, type: 'send', id: 'u1', chars: 14, force: true, comments: 2 },
    { port: 4778, ev: 'client', conn: 3, type: 'interrupt' },
    { port: 4778, ev: 'client', conn: 3, type: 'shell-run', id: 's1', chars: 20 },
    { port: 4778, ev: 'client', conn: 3, type: 'permission', id: 'p1', allow: true },
    { port: 4778, ev: 'client', conn: 3, type: 'comments', count: 0 },
  ]);
  expect(raw()).not.toMatch(/secret|hunter2|my answer/);
});

it('what the server told the window, without streamed text, tool input or output', () => {
  const a = mk();
  a.server({ kind: 'agent', e: { t: 'message-chunk', text: 'private words' }, ts: 1 });
  a.server({ kind: 'agent', e: { t: 'message', id: 'm1', text: 'private words' }, ts: 1 });
  a.server({ kind: 'agent', e: { t: 'tool-call', id: 't1', name: 'Bash', input: { command: 'cat .env' }, sub: false, toolKind: 'command' }, ts: 1 });
  a.server({ kind: 'agent', e: { t: 'tool-update', id: 't1', text: 'API_KEY=xyz', isError: false }, ts: 1 });
  a.server({ kind: 'agent', e: { t: 'turn-end', stop: 'interrupted', secs: 42, answers: 'none', queued: 0 }, ts: 1 });
  a.server({ kind: 'user', id: 'u1', text: 'private words', ts: 1 });
  a.server({ kind: 'voice-text', id: 'u2', text: 'private words spoken', ts: 1 });
  a.server({ kind: 'voice-text', id: 'u3', error: 'off', ts: 1 });
  a.server({ kind: 'stats', stats: {} as never });
  expect(lines().map((l) => [l.kind, l.tool ?? l.stop ?? l.chars ?? l.error ?? l.isError])).toEqual([
    ['tool-call', 'Bash'], ['tool-update', false], ['turn-end', 'interrupted'], ['user', 13], ['voice-text', 20], ['voice-text', 'off'],
  ]);
  expect(raw()).not.toMatch(/private|\.env|API_KEY/);
});

it('off in Settings: nothing is written', () => {
  const a = mk({ enabled: () => false });
  a.write('server-start');
  expect(fs.existsSync(dir)).toBe(false);
});

it('a full day file stops taking lines, saying so once', () => {
  const a = mk({ maxDayBytes: 200 });
  for (let i = 0; i < 10; i++) a.write('client', { type: 'send', n: i });
  const got = lines();
  expect(got.at(-1)).toMatchObject({ ev: 'audit-capped' });
  expect(got.filter((l) => l.ev === 'audit-capped')).toHaveLength(1);
  expect(got.length).toBeLessThan(10);
});

it('prune drops day files older than the kept days, nothing else', () => {
  const a = mk();
  fs.mkdirSync(dir, { recursive: true });
  const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);
  for (const n of [0, KEEP_DAYS - 1, KEEP_DAYS + 1, 40]) fs.writeFileSync(path.join(dir, `${day(n)}.jsonl`), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  a.prune();
  expect(fs.readdirSync(dir).sort()).toEqual([`${day(KEEP_DAYS - 1)}.jsonl`, `${day(0)}.jsonl`, 'notes.txt'].sort());
});

it('auditNote reaches the open logs of the process, not a closed one', () => {
  const a = mk();
  auditNote('agent-system', { subtype: 'api_retry', attempt: 1 });
  a.close();
  auditNote('agent-system', { subtype: 'api_retry', attempt: 2 });
  expect(lines().map((l) => l.attempt)).toEqual([1]);
});

it('a system message the chat does not show reaches the log by its kind and numbers, not its content', () => {
  mk();
  const out = mapSdk({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 566, error_status: null, error: { message: 'Connection error.\n  details' }, hook_output: 'secret output', session_id: 's', uuid: 'u' } as never);
  expect(out).toEqual([]);
  expect(lines()).toEqual([expect.objectContaining({ ev: 'agent-system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 566, error: 'Connection error. details' })]);
  expect(raw()).not.toContain('secret output');
});

it('the per-chunk thinking counter stays out of the log', () => {
  mk();
  expect(mapSdk({ type: 'system', subtype: 'thinking_tokens', session_id: 's', uuid: 'u' } as never)).toEqual([]);
  auditNote('marker');
  expect(lines().map((l) => l.ev)).toEqual(['marker']);
});

it('a hub tap sees every event; one that throws is dropped and the emit goes on', () => {
  const hub = new EventHub();
  const seen: string[] = [];
  hub.tap(() => { throw new Error('boom'); });
  hub.tap((ev) => seen.push(ev.kind));
  hub.emit({ kind: 'mode', mode: 'default' });
  hub.emit({ kind: 'mode', mode: 'plan' }, { store: false });
  expect(seen).toEqual(['mode', 'mode']);
});

it('a window writes its start, its sockets, the page\'s stop and the turn\'s end', async () => {
  const home = path.dirname(dir);
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-audit-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  const prev = process.env.NOTA_BENE_HOME;
  process.env.NOTA_BENE_HOME = home;
  try {
    const s = await startServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello', delayMs: 2000 }]), webDist: dist, oneTab: false, audit: { dir, enabled: () => true } });
    const ws = new WebSocket(s.url.replace('http', 'ws') + '/ws');
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'do the thing' }));
    const today = () => lines(new Date().toISOString().slice(0, 10));
    const until = async (cond: () => boolean) => {
      for (const end = Date.now() + 3000; !cond(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error('timeout');
    };
    await until(() => today().some((l) => l.kind === 'user'));
    ws.send(JSON.stringify({ type: 'interrupt' }));
    await until(() => today().some((l) => l.kind === 'turn-end'));
    ws.close();
    await until(() => today().some((l) => l.ev === 'ws-close'));
    await s.close();
    const got = today();
    const port = Number(new URL(s.url).port);
    // before the listen a test's port is still the asked 0; from the start line on it is the real one
    expect(got.slice(got.findIndex((l) => l.ev === 'server-start')).every((l) => l.port === port)).toBe(true);
    expect(got.map((l) => l.ev === 'event' ? `event:${String(l.kind)}` : l.ev === 'client' ? `client:${String(l.type)}` : l.ev)).toEqual(expect.arrayContaining([
      'server-start', 'ws-open', 'client:send', 'event:user', 'client:interrupt', 'event:turn-end', 'ws-close', 'server-stop',
    ]));
    expect(got.find((l) => l.ev === 'server-start')).toMatchObject({ root: '/proj' });
    expect(got.find((l) => l.kind === 'turn-end')).toMatchObject({ stop: 'interrupted' });
    expect(JSON.stringify(got)).not.toContain('do the thing');
  } finally {
    if (prev === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prev;
    fs.rmSync(dist, { recursive: true, force: true });
  }
});
