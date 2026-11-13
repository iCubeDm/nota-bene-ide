import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nota-bene/shared';
import { mapFrames } from './map.ts';

const f = (m: object) => m as unknown as SDKMessage;
/** real SDK frames, ids and texts neutral (server/test/fixtures/swarm-frames.json) */
const recorded = (JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/swarm-frames.json', import.meta.url), 'utf8')) as { claude: Record<'parallel' | 'workflow', SDKMessage[]> }).claude;
const call = (id: string, input: object, name = 'Agent') => f({ type: 'assistant', uuid: `u-${id}`, parent_tool_use_id: null, session_id: 'S', message: { content: [{ type: 'tool_use', id, name, input }] } });
const sys = (subtype: string, rest: object) => f({ type: 'system', subtype, session_id: 'S', ...rest });

async function run(frames: SDKMessage[], read: (session: string, call: string) => string | undefined): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of mapFrames((async function* () { yield* frames; })(), read)) out.push(e);
  return out.filter((e) => e.t === 'task');
}

describe('mapFrames: the subagent model on task events', () => {
  it('the Agent call input until the transcript says; then the transcript, once', async () => {
    const reads: string[] = [];
    const events = await run([
      call('toolu_A', { description: 'D', model: 'sonnet' }),
      sys('task_started', { task_id: 't', description: 'D', task_type: 'local_agent', tool_use_id: 'toolu_A' }),
      sys('task_progress', { task_id: 't', usage: { total_tokens: 1 } }),
      sys('task_progress', { task_id: 't', usage: { total_tokens: 2 } }),
      sys('task_progress', { task_id: 't', usage: { total_tokens: 3 } }),
    ], (s, c) => { reads.push(`${s}:${c}`); return reads.length >= 3 ? 'claude-sonnet-5-5' : undefined; });
    expect(events[0]).toMatchObject({ phase: 'started', model: 'sonnet' });
    expect(events[1]).not.toHaveProperty('model'); // the transcript does not say yet: nothing new
    expect(events[2]).toMatchObject({ phase: 'progress', model: 'claude-sonnet-5-5' });
    expect(events[3]).not.toHaveProperty('model'); // already said: no more reads
    expect(reads).toEqual(['S:toolu_A', 'S:toolu_A', 'S:toolu_A']);
  });

  it('a transcript model on start wins over the call input; a Task call counts too; no model anywhere adds nothing', async () => {
    const withTranscript = await run([call('toolu_A', { model: 'opus' }, 'Task'), sys('task_started', { task_id: 't', tool_use_id: 'toolu_A', task_type: 'local_agent' })], () => 'claude-opus-5-5');
    expect(withTranscript[0]).toMatchObject({ model: 'claude-opus-5-5' });
    const none = await run([call('toolu_B', { description: 'x' }), sys('task_started', { task_id: 'u', tool_use_id: 'toolu_B', task_type: 'local_agent' })], () => undefined);
    expect(none[0]).not.toHaveProperty('model');
    const shell = await run([sys('task_started', { task_id: 's', task_type: 'local_bash' })], () => { throw new Error('a shell has no transcript'); });
    expect(shell[0]).not.toHaveProperty('model');
  });
});

describe('mapFrames: the model response that launched a task (`group`)', () => {
  // one API response of parallel calls arrives as one assistant frame per block, all with the response's message.id
  const block = (msg: string, id: string, name = 'Agent', parent: string | null = null) =>
    f({ type: 'assistant', uuid: `u-${id}`, parent_tool_use_id: parent, session_id: 'S', message: { id: msg, content: [{ type: 'tool_use', id, name, input: { description: id } }] } });
  const started = (task: string, call: string, type = 'local_agent') => sys('task_started', { task_id: task, description: task, task_type: type, tool_use_id: call });
  const groups = (events: AgentEvent[]) => events.flatMap((e) => (e.t === 'task' && e.phase === 'started' ? [`${e.id}:${e.group ?? '-'}`] : []));
  const plain = async (frames: SDKMessage[]) => { const out: AgentEvent[] = []; for await (const e of mapFrames((async function* () { yield* frames; })())) out.push(e); return out; };

  it('recorded: two parallel Agent calls of one response share its message id, with or without a model reader', async () => {
    expect(groups(await run(recorded.parallel, () => undefined))).toEqual(['task01:msg_01', 'task02:msg_01']);
    expect(groups(await plain(recorded.parallel))).toEqual(['task01:msg_01', 'task02:msg_01']);
  });

  it('a later response has its own group; a subagent\'s own calls are grouped by its response; no call, no group', async () => {
    const events = await run([
      block('msg_1', 'toolu_A'), started('a', 'toolu_A'), block('msg_2', 'toolu_C'), started('c', 'toolu_C'),
      block('msg_s', 'toolu_X', 'Agent', 'toolu_P'), block('msg_s', 'toolu_Y', 'Agent', 'toolu_P'), started('x', 'toolu_X'), started('y', 'toolu_Y'),
      sys('task_started', { task_id: 'z', description: 'z', task_type: 'local_bash' }),
    ], () => undefined);
    expect(groups(events)).toEqual(['a:msg_1', 'c:msg_2', 'x:msg_s', 'y:msg_s', 'z:-']);
  });

  it('only Agent / Task / SendMessage calls are kept, each until its task starts (a result in between does not lose it)', async () => {
    const events = await run([
      block('msg_1', 'toolu_B', 'Bash'), sys('task_started', { task_id: 'sh', description: 'sh', task_type: 'local_bash', tool_use_id: 'toolu_B' }),
      block('msg_2', 'toolu_A'), f({ type: 'result', subtype: 'success', session_id: 'S' }), started('a', 'toolu_A'),
      started('a2', 'toolu_A'), // a second start of the same call: already taken
    ], () => undefined);
    expect(groups(events)).toEqual(['sh:-', 'a:msg_2', 'a2:-']);
  });

  it('a workflow task says its name; its description stays the row text', async () => {
    const events = await run([sys('task_started', { task_id: 'w', description: 'Review the change', task_type: 'local_workflow', workflow_name: 'spec' })], () => undefined);
    expect(events[0]).toMatchObject({ phase: 'started', type: 'local_workflow', workflow: 'spec', desc: 'Review the change' });
    const nameless = await run([sys('task_started', { task_id: 'v', task_type: 'local_workflow', workflow_name: 'spec' })], () => undefined);
    expect(nameless[0]).toMatchObject({ desc: 'spec', workflow: 'spec' });
  });
  it('recorded: a workflow\'s agents (only in its task_progress) become inner tasks under it, with model, tokens and their end', async () => {
    const events = (await plain(recorded.workflow)).filter((e) => e.t === 'task');
    const line = (e: AgentEvent) => (e.t === 'task' ? `${e.id} ${e.phase}${e.parent ? ` <${e.parent}` : ''}${e.inner ? ' inner' : ''}${e.phase === 'progress' && e.tokens ? ` ${e.tokens}` : ''}${e.status ? ` ${e.status}` : ''}` : '');
    expect(events.map(line).filter((l) => !/^task03 progress/.test(l))).toEqual([
      'task03 started', 'agent01 started <task03 inner', // the second agent is queued, with no agentId yet
      'agent01 progress 53267', 'agent01 done', 'agent02 started <task03 inner', 'agent02 progress 53265', 'agent02 done', 'task03 done', 'task03 done',
    ]);
    expect(events.find((e) => e.t === 'task' && e.id === 'agent01' && e.phase === 'started')).toMatchObject({ desc: 'alpha', type: 'workflow_agent', model: 'claude-sonnet-5-5' });
    expect(events[0]).toMatchObject({ type: 'local_workflow', workflow: 'pair' });
  });

  it('a workflow that ends ends the agents that had not said so, with its own status', async () => {
    const progress = (agents: object[]) => sys('task_progress', { task_id: 'w', usage: { total_tokens: 1 }, workflow_progress: agents });
    const events = (await plain([
      sys('task_started', { task_id: 'w', description: 'w', task_type: 'local_workflow', workflow_name: 'pair' }),
      progress([{ type: 'workflow_agent', index: 1, agentId: 'a1', state: 'start' }, { type: 'workflow_agent', index: 2, state: 'start' }, { type: 'workflow_agent', index: 3, agentId: '../x', state: 'start' }]),
      progress([{ type: 'workflow_agent', index: 1, agentId: 'a1', state: 'start' }, { type: 'workflow_agent', index: 2, agentId: 'a2', state: 'failed' }]),
      sys('task_notification', { task_id: 'w', status: 'stopped' }),
      progress([{ type: 'workflow_agent', index: 4, agentId: 'a4', state: 'start' }]), // after its end: nothing
    ])).filter((e) => e.t === 'task' && e.id !== 'w');
    expect(events.map((e) => (e.t === 'task' ? `${e.id} ${e.phase}${e.status ? ` ${e.status}` : ''}` : ''))).toEqual(['a1 started', 'a2 started', 'a2 done failed', 'a1 done stopped']);
  });
});
