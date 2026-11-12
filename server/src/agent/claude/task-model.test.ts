import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nota-bene/shared';
import { mapFrames } from './map.ts';

const f = (m: object) => m as unknown as SDKMessage;
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

  it('calls of one response share its message id; a later response has its own; with or without a model reader', async () => {
    const frames = [
      block('msg_1', 'toolu_A'), block('msg_1', 'toolu_B'), started('a', 'toolu_A'), started('b', 'toolu_B'),
      block('msg_2', 'toolu_C'), started('c', 'toolu_C'),
    ];
    expect(groups(await run(frames, () => undefined))).toEqual(['a:msg_1', 'b:msg_1', 'c:msg_2']);
    const plain: AgentEvent[] = [];
    for await (const e of mapFrames((async function* () { yield* frames; })())) plain.push(e);
    expect(groups(plain)).toEqual(['a:msg_1', 'b:msg_1', 'c:msg_2']);
  });

  it('a subagent\'s own parallel calls are grouped by its response; a task without a known call, or after the turn ended, has none', async () => {
    const events = await run([
      block('msg_s', 'toolu_X', 'Agent', 'toolu_P'), block('msg_s', 'toolu_Y', 'Agent', 'toolu_P'),
      started('x', 'toolu_X'), started('y', 'toolu_Y'),
      sys('task_started', { task_id: 'z', description: 'z', task_type: 'local_bash' }),
      block('msg_3', 'toolu_L'), f({ type: 'result', subtype: 'success', session_id: 'S' }), started('l', 'toolu_L'),
    ], () => undefined);
    expect(groups(events)).toEqual(['x:msg_s', 'y:msg_s', 'z:-', 'l:-']);
  });

  it('a workflow task says its name; its description stays the row text', async () => {
    const events = await run([sys('task_started', { task_id: 'w', description: 'Review the change', task_type: 'local_workflow', workflow_name: 'spec' })], () => undefined);
    expect(events[0]).toMatchObject({ phase: 'started', type: 'local_workflow', workflow: 'spec', desc: 'Review the change' });
    const nameless = await run([sys('task_started', { task_id: 'v', task_type: 'local_workflow', workflow_name: 'spec' })], () => undefined);
    expect(nameless[0]).toMatchObject({ desc: 'spec', workflow: 'spec' });
  });
});
