import { expect, it } from 'vitest';
import { AcpMapper, acpId, toolKind, updateText } from './map.ts';

it('chunks of one messageId form one block; a new id closes it with its final text', () => {
  const m = new AcpMapper();
  const chunk = (messageId: string, text: string) => m.update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } });
  expect(chunk('a', 'Hel')).toEqual([{ t: 'message-start' }, { t: 'message-chunk', text: 'Hel' }]);
  expect(chunk('a', 'lo')).toEqual([{ t: 'message-chunk', text: 'lo' }]);
  expect(chunk('b', 'Next')).toEqual([{ t: 'message', id: 'acp-b0', text: 'Hello' }, { t: 'message-start' }, { t: 'message-chunk', text: 'Next' }]);
  expect(m.flush()).toEqual([{ t: 'message', id: 'acp-b1', text: 'Next' }]);
  expect(m.flush()).toEqual([]);
});

it('tool calls carry kinds and end once, on completed or failed only', () => {
  const m = new AcpMapper();
  expect(m.update({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'bash', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }))
    .toEqual([{ t: 'tool-call', id: 'acp-t1', name: 'bash', input: { command: 'ls' }, sub: false, toolKind: 'command' }]);
  expect(m.pendingCall('bash')).toEqual({ command: 'ls' });
  expect(m.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'partial' } }] })).toEqual([]);
  expect(m.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', rawOutput: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }))
    .toEqual([{ t: 'tool-update', id: 'acp-t1', text: 'a\nb', isError: true }]);
  expect(m.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })).toEqual([]);
  expect(m.pendingCall('bash')).toBeUndefined();
  expect(m.update({ sessionUpdate: 'tool_call', toolCallId: 't2', name: 'task', kind: 'other', status: 'completed', rawInput: {} }).map((e) => e.t)).toEqual(['tool-call', 'tool-update']);
  expect([toolKind('edit'), toolKind('read'), toolKind('fetch'), toolKind('think')]).toEqual(['file', 'file', 'search', 'other']);
});

it('content without raw output renders text and diffs', () => {
  expect(updateText({ content: [{ type: 'content', content: { type: 'text', text: 'done' } }, { type: 'diff', path: 'a.txt', oldText: 'x', newText: 'y' }, { type: 'terminal' }] })).toBe('done\na.txt\ny');
});

it('commands updates keep names, descriptions and hints', () => {
  const m = new AcpMapper();
  expect(m.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'green', description: 'G', input: { hint: '<x>' } }, { description: 'nameless' }] }))
    .toEqual([{ t: 'commands', commands: [{ name: 'green', description: 'G', hint: '<x>' }] }]);
});

it('ids are path-safe', () => {
  expect(acpId('../x')).toMatch(/^acp-[0-9a-f]{64}$/);
});
