import { describe, expect, it } from 'vitest';
import { claudeAgentRecord, claudeFile, isTempDir, parseClaudeLine, parseCodexLine, type CodexContext } from './parse.ts';

const ts = '2026-10-01T10:00:00.000Z';
const at = Date.parse(ts);
const claude = (o: object) => JSON.stringify({ timestamp: ts, cwd: '/work/app', ...o });
const usage = { input_tokens: 1, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000 };

describe('claude', () => {
  it('claudeFile: a session file and a subagent file', () => {
    expect(claudeFile('proj/abc.jsonl')).toEqual({ session: 'abc' });
    expect(claudeFile('proj/abc/subagents/agent-a1.jsonl')).toEqual({ session: 'abc', agent: 'a1' });
  });

  it('a call: every counter, the model, the folder', () => {
    const line = claude({ type: 'assistant', message: { id: 'm1', model: 'opus', usage } });
    expect(parseClaudeLine(line, { session: 's' })).toEqual([{ k: 'c', id: 'm1', ts: at, cwd: '/work/app', session: 's', model: 'opus', in: 1, out: 20, write: 300, read: 4000 }]);
  });

  it('a subagent call says whose it is, under the parent session', () => {
    const line = claude({ type: 'assistant', isSidechain: true, message: { id: 'm1', model: 'opus', usage } });
    expect(parseClaudeLine(line, { session: 's', agent: 'a1' })[0]).toMatchObject({ session: 's', agent: 'a1' });
  });

  it('a synthetic message is no call', () => {
    expect(parseClaudeLine(claude({ type: 'assistant', message: { id: 'm1', model: '<synthetic>', usage } }), { session: 's' })).toEqual([]);
  });

  it('a limit message is a hit, by the CLI\'s own limit names; spend, budget and fast limits are no such window', () => {
    const hit = (text: string) => parseClaudeLine(claude({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text }] } }), { session: 's' });
    for (const text of ["You've hit your session limit · resets 5pm", "You've hit your 5-hour limit · resets 5pm"]) {
      expect(hit(text)).toEqual([{ k: 'h', ts: at, kind: '5h' }]);
    }
    for (const name of ['weekly', 'Opus', 'Sonnet', 'Fable']) {
      expect(hit(`You've hit your ${name} limit · resets Mon 9am`)).toEqual([{ k: 'h', ts: at, kind: 'week' }]);
    }
    expect(hit("You've reached your Fable limit.")).toEqual([{ k: 'h', ts: at, kind: 'week' }]);
    for (const text of ['Overloaded', "You've hit your fast limit", "You've hit your monthly spend limit.", "You've hit your team's shared budget. /model to switch models.", "You've hit your usage credit limit"]) {
      expect(hit(text)).toEqual([]);
    }
  });

  it('a batch of comments is labelled by the words above it, or else by its first comment, not by the quote', () => {
    const prompt = (content: string) => parseClaudeLine(claude({ type: 'user', message: { content } }), { session: 's' });
    const labelled = (l: string) => [{ k: 'p', ts: at, session: 's', label: l }];
    expect(prompt('Please fix\n\nComments on fragments:\n\n1. [reply #3 · 21:47]\n> a quote\n→ why so')).toEqual(labelled('Please fix'));
    expect(prompt('Comments on fragments:\n\n1. [reply #3 · 21:47]\n> a quote\n→ why so\n\n2. [x]\n> b\n→ c')).toEqual(labelled('why so'));
    expect(prompt('Комментарии к фрагментам:\n\n1. [ответ #3 · 21:47]\n> цитата\n→ почему')).toEqual(labelled('почему'));
    expect(prompt('对片段的评论：\n\n1. [x]\n> q\n→ 为什么')).toEqual(labelled('为什么'));
    expect(prompt('Comments on fragments:\n\n1. [x]\n> only a quote')).toEqual(labelled('1. [x] > only a quote'));
  });

  it('a prompt is a labelled record; tool results, meta and wrapped commands are not prompts', () => {
    const user = (o: object) => claude({ type: 'user', ...o });
    const long = 'a  b\n'.repeat(40);
    const [p] = parseClaudeLine(user({ message: { content: long } }), { session: 's' });
    expect(p).toMatchObject({ k: 'p', ts: at, session: 's' });
    expect((p as { label: string }).label).toHaveLength(64);
    expect((p as { label: string }).label.startsWith('a b a b')).toBe(true);
    expect(parseClaudeLine(user({ message: { content: [{ type: 'tool_result', content: 'x' }] } }), { session: 's' })).toEqual([]);
    expect(parseClaudeLine(user({ isMeta: true, message: { content: 'x' } }), { session: 's' })).toEqual([]);
    expect(parseClaudeLine(user({ isCompactSummary: true, message: { content: 'This session is being continued' } }), { session: 's' })).toEqual([]);
    expect(parseClaudeLine(user({ message: { content: '<command-name>/x</command-name>' } }), { session: 's' })).toEqual([]);
    expect(parseClaudeLine(user({ message: { content: 'the subagent prompt' } }), { session: 's', agent: 'a' })).toEqual([]);
  });

  it('a broken line or one with no time is nothing', () => {
    expect(parseClaudeLine('{"type":"assistant"', { session: 's' })).toEqual([]);
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'o', usage } }), { session: 's' })).toEqual([]);
  });

  it('a subagent is named by its meta file', () => {
    expect(claudeAgentRecord('a1', JSON.stringify({ agentType: 'Explore', description: 'Find the routes' }))).toEqual({ k: 'a', id: 'a1', label: 'Explore: Find the routes' });
    expect(claudeAgentRecord('a1', JSON.stringify({ agentType: 'general-purpose', description: 'Fix it' }))).toEqual({ k: 'a', id: 'a1', label: 'Fix it' });
    expect(claudeAgentRecord('a1', 'nope')).toBeNull();
  });
});

describe('codex', () => {
  const line = (type: string, payload: object) => JSON.stringify({ timestamp: ts, type, payload });
  const fresh = (): CodexContext => {
    const c: CodexContext = {};
    parseCodexLine(line('session_meta', { id: 't1', cwd: '/work/app', source: 'vscode' }), c);
    parseCodexLine(line('turn_context', { model: 'gpt', cwd: '/work/app' }), c);
    return c;
  };
  const call = (o: object = {}) => line('token_usage_record', {
    response_id: 'r1', root_turn_id: 'turn1', usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 10, output_tokens: 7 }, ...o,
  });

  it('a call: the cached part leaves the fresh input, the root turn is the task', () => {
    expect(parseCodexLine(call(), fresh())).toEqual([{ k: 'c', id: 'r1', ts: at, cwd: '/work/app', session: 't1', model: 'gpt', in: 30, out: 7, write: 10, read: 60, task: 'turn1' }]);
  });

  it('a call before any turn context has no model: nothing', () => {
    const c: CodexContext = {};
    parseCodexLine(line('session_meta', { id: 't1' }), c);
    expect(parseCodexLine(call(), c)).toEqual([]);
  });

  it('a spawned subagent counts under its parent thread and is named', () => {
    const c: CodexContext = {};
    const meta = parseCodexLine(line('session_meta', { id: 't2', cwd: '/w', source: { subagent: { thread_spawn: { parent_thread_id: 't1', agent_role: 'worker' } } } }), c);
    expect(meta).toEqual([{ k: 'a', id: 't2', label: 'worker' }]);
    parseCodexLine(line('turn_context', { model: 'gpt' }), c);
    expect(parseCodexLine(call(), c)[0]).toMatchObject({ session: 't1', agent: 't2', task: 'turn1' });
  });

  it('a prompt of the main thread carries its turn', () => {
    const item = { type: 'UserMessage', content: [{ type: 'text', text: 'hello there' }] };
    expect(parseCodexLine(line('event_msg', { type: 'item_completed', turn_id: 'turn1', item }), fresh())).toEqual([{ k: 'p', ts: at, session: 't1', label: 'hello there', task: 'turn1' }]);
  });

  it('limits: a reading only when it moved, resets in milliseconds', () => {
    const c = fresh();
    const count = (pct: number) => line('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: 100 } } });
    expect(parseCodexLine(count(5), c)).toEqual([{ k: 'l', ts: at, minutes: 300, pct: 5, resets: 100_000 }]);
    expect(parseCodexLine(count(5), c)).toEqual([]);
    expect(parseCodexLine(count(6), c)).toHaveLength(1);
  });

  it('a reached limit is a hit of the window that filled; workspace credits and limits are no such window', () => {
    const hit = (type: string, five: number, week: number) => parseCodexLine(line('event_msg', { type: 'token_count', rate_limits: {
      rate_limit_reached_type: type,
      primary: { used_percent: five, window_minutes: 300 }, secondary: { used_percent: week, window_minutes: 10080 },
    } }), fresh()).filter((r) => r.k === 'h');
    expect(hit('rate_limit_reached', 100, 40)).toEqual([{ k: 'h', ts: at, kind: '5h' }]);
    expect(hit('rate_limit_reached', 40, 100)).toEqual([{ k: 'h', ts: at, kind: 'week' }]);
    expect(hit('rate_limit_reached', 100, 100)).toEqual([{ k: 'h', ts: at, kind: 'week' }]);
    expect(hit('workspace_owner_credits_depleted', 100, 40)).toEqual([]);
    expect(hit('workspace_member_usage_limit_reached', 100, 40)).toEqual([]);
  });
});

it('isTempDir: the folder and what is under it, not a lookalike', () => {
  expect(isTempDir('/tmp/x', ['/tmp'])).toBe(true);
  expect(isTempDir('/tmp', ['/tmp'])).toBe(true);
  expect(isTempDir('/tmpfiles/x', ['/tmp'])).toBe(false);
});
