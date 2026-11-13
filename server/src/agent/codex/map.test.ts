import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CodexMapper, codexInput, itemId } from './map.ts';

type Recorded = { method: string; params: Record<string, unknown> };
/** real app-server notifications of the parent thread, ids neutral (server/test/fixtures/swarm-frames.json) */
const recorded = (JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/swarm-frames.json', import.meta.url), 'utf8')) as { codex: Record<'parallel' | 'sequential', Recorded[]> }).codex;

describe('Codex event normalization', () => {
  it('streams text once and keeps the same stable id in the final item', () => {
    const mapper = new CodexMapper();
    expect(mapper.notification('item/agentMessage/delta', { itemId: 'msg_1', delta: 'Hello' })).toEqual([
      { t: 'message-start' }, { t: 'message-chunk', text: 'Hello' },
    ]);
    expect(mapper.item({ type: 'agentMessage', id: 'msg_1', text: 'Hello world' }, true)).toEqual([
      { t: 'message', id: itemId('msg_1'), text: 'Hello world' },
    ]);
    expect(mapper.item({ type: 'agentMessage', id: 'msg_1', text: 'Hello world' }, true)).toEqual([]);
  });

  it('normalizes command output snapshots and native failure', () => {
    const mapper = new CodexMapper();
    const item = { type: 'commandExecution', id: 'cmd_1', command: 'echo hello', status: 'inProgress' };
    expect(mapper.item(item, false)).toContainEqual(expect.objectContaining({ t: 'tool-call', id: itemId('cmd_1'), toolKind: 'command', input: { command: 'echo hello' } }));
    expect(mapper.notification('item/commandExecution/outputDelta', { itemId: 'cmd_1', delta: 'hello\n' })).toContainEqual({ t: 'tool-update', id: itemId('cmd_1'), text: 'hello\n', isError: false });
    expect(mapper.item({ ...item, status: 'failed', aggregatedOutput: 'denied', exitCode: 1 }, true)).toContainEqual({ t: 'tool-update', id: itemId('cmd_1'), text: 'denied', isError: true });
  });

  it('classifies MCP/file/child calls without Claude tool-name aliases', () => {
    const mapper = new CodexMapper();
    expect(mapper.item({ type: 'mcpToolCall', id: 'mcp', server: 'docs', tool: 'search', arguments: { q: 'test' }, result: { content: [{ type: 'text', text: 'found' }] } }, true)).toContainEqual({ t: 'tool-update', id: itemId('mcp'), text: 'found', isError: false });
    expect(mapper.item({ type: 'fileChange', id: 'file', changes: [{ path: 'a.ts', diff: '+hello' }] }, false)).toContainEqual(expect.objectContaining({ toolKind: 'file' }));
    const child = mapper.item({ type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', prompt: 'Inspect it', receiverThreadIds: ['child_1'], agentsStates: { child_1: { status: 'running' } } }, true);
    expect(child).toContainEqual(expect.objectContaining({ t: 'tool-call', toolKind: 'agent', childSessionId: 'child_1' }));
    expect(child).toContainEqual(expect.objectContaining({ t: 'task', phase: 'started', type: 'agent', call: itemId('spawn') }));
    expect(child.some((event) => event.t === 'task' && event.phase === 'done')).toBe(false);
  });

  it('recorded: two spawns of one response share a group; spawn, wait, spawn in one response are two groups', () => {
    const groups = (run: Recorded[]) => {
      const mapper = new CodexMapper();
      return run.flatMap((n) => mapper.notification(n.method, n.params)).flatMap((e) => (e.t === 'task' && e.phase === 'started' ? [`${e.id}:${e.group}`] : []));
    };
    expect(groups(recorded.parallel)).toEqual([`${itemId('thread-02')}:${itemId('item-11')}`, `${itemId('thread-03')}:${itemId('item-11')}`]);
    expect(groups(recorded.sequential)).toEqual([`${itemId('thread-05')}:${itemId('item-20')}`, `${itemId('thread-06')}:${itemId('item-22')}`]);
  });

  it('a run ends with the response (token usage), a message, reasoning, a wait or a turn; other calls and an item seen before do not end it', () => {
    const mapper = new CodexMapper();
    const spawn = (id: string, children: string[], tool = 'spawnAgent') => mapper.item({ type: 'collabAgentToolCall', id, tool, prompt: id, receiverThreadIds: children, agentsStates: Object.fromEntries(children.map((c) => [c, { status: 'running' }])) }, true);
    const groups = (events: ReturnType<typeof spawn>) => events.flatMap((e) => (e.t === 'task' && e.phase === 'started' ? [`${e.id}:${e.group ?? '-'}`] : []));
    mapper.notification('turn/started', {});
    mapper.item({ type: 'reasoning', id: 'r1' }, false);
    expect(groups(spawn('s1', ['c1']))).toEqual([`${itemId('c1')}:${itemId('s1')}`]);
    mapper.item({ type: 'commandExecution', id: 'cmd', command: 'ls' }, false);
    mapper.item({ type: 'reasoning', id: 'r1' }, true);
    expect(groups(spawn('s2', ['c2', 'c3']))).toEqual([`${itemId('c2')}:${itemId('s1')}`, `${itemId('c3')}:${itemId('s1')}`]);
    mapper.notification('thread/tokenUsage/updated', {});
    expect(groups(spawn('s3', ['c4']))).toEqual([`${itemId('c4')}:${itemId('s3')}`]);
    mapper.item({ type: 'collabAgentToolCall', id: 'w1', tool: 'wait', receiverThreadIds: ['c4'], agentsStates: { c4: { status: 'completed' } } }, true);
    expect(groups(spawn('s4', ['c5']))).toEqual([`${itemId('c5')}:${itemId('s4')}`]);
    mapper.item({ type: 'agentMessage', id: 'm1', text: 'spawning' }, true);
    expect(groups(spawn('s5', ['c6']))).toEqual([`${itemId('c6')}:${itemId('s5')}`]);
    // a resume of a finished child has no group of its own and does not open a run for the spawns after it
    mapper.notification('turn/started', {});
    expect(groups(spawn('r', ['c4'], 'sendInput'))).toEqual([`${itemId('c4')}:-`]);
    expect(groups(spawn('s6', ['c7']))).toEqual([`${itemId('c7')}:${itemId('s6')}`]);
    expect(groups(spawn('s7', ['c8']))).toEqual([`${itemId('c8')}:${itemId('s6')}`]);
  });

  it('does not invent compaction token counts or duplicate a boundary', () => {
    const mapper = new CodexMapper();
    expect(mapper.item({ type: 'contextCompaction', id: 'compact' }, false)).toEqual([{ t: 'compacting' }]);
    expect(mapper.item({ type: 'contextCompaction', id: 'compact' }, true)).toEqual([{ t: 'compacted', boundaryId: 'codex-compact' }]);
    expect(mapper.notification('thread/compacted', {})).toEqual([]);
  });

  it('encodes ordered text, labels and images in native input format', () => {
    expect(codexInput('Read this', [{ label: '[Comment 1]', mediaType: 'image/png', data: 'aGVsbG8=' }])).toEqual([
      { type: 'text', text: 'Read this', text_elements: [] },
      { type: 'text', text: '[Comment 1]', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,aGVsbG8=' },
    ]);
    expect(itemId('../../not-a-path')).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });
});

it('a live spawn acquires final child metadata on the same tool and a completed child can restart', () => {
  const mapper = new CodexMapper();
  mapper.item({ type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', prompt: 'Investigate', receiverThreadIds: [] }, false);
  const end = mapper.item({ type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', prompt: 'Investigate', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } }, true);
  expect(end).toContainEqual(expect.objectContaining({ t: 'tool-update', id: 'codex-spawn', toolKind: 'agent', childSessionId: 'child' }));
  mapper.item({ type: 'collabAgentToolCall', id: 'wait', tool: 'wait', receiverThreadIds: ['child'], agentsStates: { child: { status: 'completed' } } }, true);
  expect(mapper.item({ type: 'collabAgentToolCall', id: 'resume', tool: 'sendInput', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } }, true)).toContainEqual(expect.objectContaining({ t: 'task', id: 'codex-child', phase: 'started' }));
});

it('live and replay keep the same collab tool input text despite child discovery happening at completion', () => {
  const start = { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', prompt: 'Investigate', receiverThreadIds: [] };
  const end = { ...start, receiverThreadIds: ['child'] };
  const live = new CodexMapper().item(start, false).find((e) => e.t === 'tool-call');
  const replay = new CodexMapper().item(end, true).find((e) => e.t === 'tool-call');
  expect(live?.t === 'tool-call' && live.input).toEqual(replay?.t === 'tool-call' && replay.input);
  expect(live?.t === 'tool-call' && live.id).toEqual(replay?.t === 'tool-call' && replay.id);
});
