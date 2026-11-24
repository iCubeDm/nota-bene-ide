import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMode, Interaction } from '@nota-bene/shared';
import { AcpError, type AcpConnection, type AcpRequest } from './rpc.ts';
import { AcpSession, tooOld } from './session.ts';
import { OMP } from './omp.ts';

const CONFIG = [
  { id: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'plan' }] },
  { id: 'model', currentValue: 'a/one', options: [{ value: 'a/one', name: 'One' }, { value: 'b/two', name: 'Two' }] },
  { id: 'thinking', currentValue: 'high', options: ['off', 'auto', 'low', 'high'].map((value) => ({ value })) },
];

export class Script implements AcpConnection {
  end!: () => void;
  closed = new Promise<void>((r) => { this.end = r; });
  ready: Promise<Record<string, unknown>>;
  listener = (_m: string, _p: Record<string, unknown>) => {};
  handler: (r: AcpRequest, s: AbortSignal) => Promise<unknown> = async () => ({});
  calls: { method: string; params: Record<string, unknown> }[] = [];
  notes: { method: string; params: unknown }[] = [];
  prompts: { resolve(v: unknown): void; reject(e: Error): void }[] = [];
  constructor(version = '18.16.0') { this.ready = Promise.resolve({ agentInfo: { name: 'omp', version } }); }
  reply = async (method: string, _p: Record<string, unknown>): Promise<unknown> => {
    if (method === 'session/new') return { sessionId: 'sid-1', configOptions: CONFIG };
    if (method === 'session/fork') return { sessionId: 'sid-fork', configOptions: CONFIG };
    if (method === 'session/load') return { configOptions: CONFIG };
    if (method === 'session/prompt') return new Promise((resolve, reject) => { this.prompts.push({ resolve, reject }); });
    return {};
  };
  async request(method: string, params: unknown = {}): Promise<unknown> { this.calls.push({ method, params: params as Record<string, unknown> }); return this.reply(method, params as Record<string, unknown>); }
  notify(method: string, params?: unknown) { this.notes.push({ method, params }); }
  onNotification(f: typeof this.listener) { this.listener = f; return () => {}; }
  onRequest(f: typeof this.handler) { this.handler = f; }
  async close() { this.end(); }
  update(u: Record<string, unknown>, sessionId = 'sid-1') { this.listener('session/update', { sessionId, update: u }); }
  ask(method: string, params: Record<string, unknown>) { return this.handler({ id: 1, method, params: { sessionId: 'sid-1', ...params } }, new AbortController().signal); }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 10));
function setup(o: { mode?: AgentMode; resume?: string; fork?: boolean; replay?: string; interact?: (p: Interaction, input: Record<string, unknown>, signal: AbortSignal) => Promise<{ choice: string; values?: Record<string, string> } | null>; version?: string } = {}) {
  const scripts: Script[] = [];
  const connect = () => {
    const s = new Script(o.version); scripts.push(s);
    if (o.replay) { const base = s.reply; s.reply = async (m, p) => { if (m === 'session/load') s.update({ sessionUpdate: 'agent_message_chunk', messageId: 'old', content: { type: 'text', text: o.replay } }); return base(m, p); }; }
    return s;
  };
  const session = new AcpSession({ cwd: '/tmp', permissionMode: o.mode ?? 'omp-yolo', ask: async () => false, ...(o.resume ? { resume: o.resume } : {}), ...(o.fork ? { fork: true } : {}), ...(o.interact ? { interact: o.interact } : {}) }, { ...OMP, beforeResume: undefined }, connect);
  const events: AgentEvent[] = [];
  const reading = (async () => { for await (const e of session.messages) events.push(e); })().catch(() => {});
  return { scripts, rpc: () => scripts.at(-1)!, session, events, async close() { session.close(); await reading; } };
}
const send = (s: AcpSession, uuid: string, priority: 'next' | 'now' = 'next') => s.send({ uuid, text: uuid, priority });
const ends = (events: AgentEvent[]) => events.filter((e) => e.t === 'turn-end');

describe('ACP session', () => {
  it('starts a session, announces its id/model/mode and ends a prompt with its answer', async () => {
    const s = setup(); await s.session.ready; await flush();
    expect(s.events[0]).toEqual({ t: 'init', sessionId: 'sid-1', model: 'a/one', mode: 'omp-yolo' });
    send(s.session, 'a'); await flush();
    s.rpc().update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hi' } });
    s.rpc().prompts[0]!.resolve({ stopReason: 'end_turn' }); await flush();
    expect(s.events.map((e) => e.t)).toEqual(['init', 'message-start', 'message-chunk', 'message', 'turn-end']);
    expect(ends(s.events)).toMatchObject([{ stop: 'done', answers: ['a'] }]);
    await s.close();
  });

  it('a send while a prompt runs steers it: one turn-end answers both', async () => {
    const s = setup(); await s.session.ready;
    send(s.session, 'a'); await flush(); send(s.session, 'b'); await flush();
    expect(s.rpc().calls.filter((c) => c.method === 'session/prompt')).toHaveLength(2);
    s.rpc().prompts[0]!.resolve({ stopReason: 'cancelled' }); await flush();
    expect(ends(s.events)).toEqual([]);
    s.rpc().prompts[1]!.resolve({ stopReason: 'end_turn' }); await flush();
    expect(ends(s.events)).toMatchObject([{ stop: 'done', answers: ['a', 'b'] }]);
    await s.close();
  });

  it('a steer withdraws what the steered run still asks', async () => {
    let withdrawn = false;
    const s = setup({ interact: (_p, _input, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => { withdrawn = true; resolve(null); }); }) });
    await s.session.ready;
    send(s.session, 'a'); await flush();
    const asked = s.rpc().ask('session/request_permission', { toolCall: { toolCallId: 't', title: 'sleep 15' }, options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }] });
    send(s.session, 'b'); await flush();
    s.rpc().prompts[0]!.resolve({ stopReason: 'cancelled' });
    expect(await asked).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(withdrawn).toBe(true);
    await s.close();
  });

  it('a force send cancels the running prompt first; Stop ends it interrupted', async () => {
    const s = setup(); await s.session.ready;
    send(s.session, 'a'); await flush(); send(s.session, 'b', 'now'); await flush();
    expect(s.rpc().notes).toEqual([{ method: 'session/cancel', params: { sessionId: 'sid-1' } }]);
    expect(s.rpc().calls.filter((c) => c.method === 'session/prompt')).toHaveLength(1);
    s.rpc().prompts[0]!.resolve({ stopReason: 'cancelled' }); await flush();
    expect(ends(s.events)).toMatchObject([{ stop: 'interrupted', answers: ['a'] }]);
    expect(s.rpc().calls.filter((c) => c.method === 'session/prompt')).toHaveLength(2);
    await s.session.interrupt();
    expect(s.rpc().notes).toHaveLength(2);
    s.rpc().prompts[1]!.resolve({ stopReason: 'cancelled' }); await flush();
    expect(ends(s.events).at(-1)).toMatchObject({ stop: 'interrupted', answers: ['b'] });
    await s.close();
  });

  it('/clear starts a new session: reset, init with the new id, turn-end', async () => {
    const s = setup(); await s.session.ready;
    s.rpc().reply = async (m) => m === 'session/new' ? { sessionId: 'sid-2', configOptions: CONFIG } : {};
    s.session.send({ uuid: 'c', text: '/clear', priority: 'next' }); await flush();
    expect(s.events.slice(1).map((e) => e.t)).toEqual(['reset', 'init', 'turn-end']);
    expect(s.events[1]).toEqual({ t: 'reset', newId: 'sid-2' });
    expect(s.session.sessionId).toBe('sid-2');
    await s.close();
  });

  it('maps permission requests to choices and the answer to an optionId', async () => {
    const asked: Interaction[] = [];
    const s = setup({ interact: async (p) => { asked.push(p); return { choice: 'allow_always' }; } }); await s.session.ready;
    const options = [['allow_once', 'Allow once'], ['allow_always', 'Always allow'], ['reject_once', 'Reject'], ['reject_always', 'Always reject']].map(([optionId, name]) => ({ optionId, name, kind: optionId }));
    const r = await s.rpc().ask('session/request_permission', { toolCall: { toolCallId: 't', title: 'echo hi', rawInput: { command: 'echo hi' } }, options });
    expect(asked[0]!.choices.map((c) => [c.id, c.allow])).toEqual([['allow_once', true], ['allow_always', true], ['reject_once', false], ['reject_always', false]]);
    expect(r).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
    await s.close();
  });

  it('a tool approval form shows the pending call\'s input and answers with the enum value', async () => {
    const seen: [Interaction, Record<string, unknown>][] = [];
    const s = setup({ interact: async (p, input) => { seen.push([p, input]); return { choice: 'Deny' }; } }); await s.session.ready;
    s.rpc().update({ sessionUpdate: 'tool_call', toolCallId: 'w', name: 'write', kind: 'edit', status: 'pending', rawInput: { path: 'hello.txt', content: 'hi\n' } });
    const r = await s.rpc().ask('elicitation/create', { mode: 'form', message: 'Allow tool: write\nPath: hello.txt', requestedSchema: { type: 'object', properties: { value: { type: 'string', enum: ['Approve', 'Approve write for this session', 'Deny'] } }, required: ['value'] } });
    expect(seen[0]![0].title).toBe('Allow tool: write');
    expect(seen[0]![0].choices.map((c) => c.allow)).toEqual([true, true, false]);
    expect(seen[0]![1]).toEqual({ path: 'hello.txt', content: 'hi\n' });
    expect(r).toEqual({ action: 'accept', content: { value: 'Deny' } });
    await s.close();
  });

  it('a generic form becomes fields; answers are typed by the schema; no answer cancels', async () => {
    let answer: { choice: string; values?: Record<string, string> } | null = { choice: 'accept', values: { q0: 'Blue', n: '3' } };
    let fields: Interaction['fields'];
    const s = setup({ interact: async (p) => { fields = p.fields; return answer; } }); await s.session.ready;
    const params = { mode: 'form', message: 'Which colour?', requestedSchema: { type: 'object', properties: { q0: { type: 'string', title: 'Which colour?', oneOf: [{ const: 'Blue' }, { const: 'Green' }] }, n: { type: 'integer' }, q0__other: { type: 'string', title: 'Other' } }, required: ['q0'] } };
    expect(await s.rpc().ask('elicitation/create', params)).toEqual({ action: 'accept', content: { q0: 'Blue', n: 3 } });
    expect(fields).toEqual([{ id: 'q0', label: 'Which colour?', options: ['Blue', 'Green'], required: true }, { id: 'n', label: 'n', required: false }, { id: 'q0__other', label: 'Other', required: false }]);
    answer = null;
    expect(await s.rpc().ask('elicitation/create', params)).toEqual({ action: 'cancel' });
    await s.close();
  });

  it('switches plan on the same process; another approval level respawns on the same session while idle only', async () => {
    const s = setup({ mode: 'omp-ask' }); await s.session.ready;
    await s.session.setPermissionMode('omp-plan');
    expect(s.scripts).toHaveLength(1);
    expect(s.rpc().calls.at(-1)).toEqual({ method: 'session/set_config_option', params: { sessionId: 'sid-1', configId: 'mode', value: 'plan' } });
    send(s.session, 'a'); await flush();
    await expect(s.session.setPermissionMode('omp-write')).rejects.toThrow(/finish/);
    s.rpc().prompts[0]!.resolve({ stopReason: 'end_turn' }); await flush();
    await s.session.setPermissionMode('omp-write');
    expect(s.scripts).toHaveLength(2);
    expect(s.rpc().calls[0]).toEqual({ method: 'session/load', params: { sessionId: 'sid-1', cwd: '/tmp', mcpServers: [] } });
    s.rpc().update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live' } });
    await flush();
    expect(s.events.at(-1)).toEqual({ t: 'message-chunk', text: 'live' });
    await s.close();
  });

  it('model and effort go to set_config_option; none is off, no effort is auto', async () => {
    const s = setup(); await s.session.ready;
    await s.session.setModel('b/two'); await s.session.setEffort('none'); await s.session.setEffort(null);
    expect(s.rpc().calls.filter((c) => c.method === 'session/set_config_option').map((c) => [c.params.configId, c.params.value])).toEqual([['model', 'b/two'], ['thinking', 'off'], ['thinking', 'auto']]);
    await expect(s.session.setModel('c/three')).rejects.toThrow(/Unknown omp model/);
    await expect(s.session.setEffort('max')).rejects.toThrow(/effort/);
    expect((await s.session.supportedModels())[0]).toMatchObject({ value: 'a/one', efforts: ['none', 'low', 'high'], defaultEffort: 'high' });
    await s.close();
  });

  it('a refusal and an auth error end the turn failed with a readable reason', async () => {
    const s = setup(); await s.session.ready;
    send(s.session, 'a'); await flush(); s.rpc().prompts[0]!.resolve({ stopReason: 'refusal' }); await flush();
    send(s.session, 'b'); await flush(); s.rpc().prompts[1]!.reject(new AcpError('Authentication required', -32000)); await flush();
    expect(ends(s.events)).toMatchObject([{ stop: 'failed', error: 'omp refused the request' }, { stop: 'failed', error: OMP.errors.auth }]);
    await s.close();
  });

  it('resume loads without replaying into the feed; fork branches; an old omp is refused', async () => {
    const r = setup({ resume: 'old' });
    r.scripts[0]!.reply = async (m) => { if (m === 'session/load') r.scripts[0]!.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } }, 'old'); return { configOptions: CONFIG }; };
    await r.session.ready; await flush();
    expect(r.events).toEqual([{ t: 'init', sessionId: 'old', model: 'a/one', mode: 'omp-yolo' }]);
    await r.close();
    const f = setup({ resume: 'old', fork: true }); await f.session.ready;
    expect(f.session.sessionId).toBe('sid-fork');
    await f.close();
    const o = setup({ version: '18.15.0' });
    await expect(o.session.ready).rejects.toThrow(/omp 18\.15\.0 is too old/);
    expect(tooOld('18.16.1', '18.16.0')).toBeNull();
    expect(tooOld('banner', '18.16.0')).toBeNull();
  });

  it('follows omp leaving plan mode by itself', async () => {
    const s = setup({ mode: 'omp-plan' }); await s.session.ready; await flush();
    s.rpc().update({ sessionUpdate: 'current_mode_update', currentModeId: 'default' }); await flush();
    expect(s.events.at(-1)).toEqual({ t: 'mode', mode: 'omp-ask' });
    await s.close();
  });

  it('a send right after a mode change waits for the new process', async () => {
    const s = setup(); await s.session.ready;
    const switched = s.session.setPermissionMode('omp-write');
    send(s.session, 'a');
    await switched; await flush();
    expect(s.scripts).toHaveLength(2);
    expect(s.scripts[0]!.calls.some((c) => c.method === 'session/prompt')).toBe(false);
    expect(s.rpc().calls.map((c) => c.method).slice(0, 2)).toEqual(['session/load', 'session/prompt']);
    await s.close();
  });

  it('reply ids continue the replay\'s count, so they survive a reload', async () => {
    const s = setup({ resume: 'old' });
    s.scripts[0]!.reply = async (m) => {
      if (m === 'session/load') for (const mid of ['x', 'y']) s.scripts[0]!.update({ sessionUpdate: 'agent_message_chunk', messageId: mid, content: { type: 'text', text: mid } }, 'old');
      return m === 'session/prompt' ? new Promise(() => {}) : { configOptions: CONFIG };
    };
    await s.session.ready; send(s.session, 'q'); await flush();
    s.rpc().update({ sessionUpdate: 'agent_message_chunk', messageId: 'z', content: { type: 'text', text: 'live' } }, 'old');
    s.rpc().update({ sessionUpdate: 'tool_call', toolCallId: 't', name: 'bash', kind: 'execute', status: 'pending', rawInput: {} }, 'old'); await flush();
    expect(s.events.find((e) => e.t === 'message')).toMatchObject({ id: 'acp-b2', text: 'live' });
    await s.close();
  });

  it('a respawn does not bring the replay\'s last reply out again with the next one', async () => {
    const s = setup({ replay: 'old reply' }); await s.session.ready;
    await s.session.setPermissionMode('omp-write'); await flush();
    expect(s.scripts).toHaveLength(2);
    s.rpc().update({ sessionUpdate: 'agent_message_chunk', messageId: 'new', content: { type: 'text', text: 'new reply' } });
    s.rpc().update({ sessionUpdate: 'tool_call', toolCallId: 't', name: 'bash', kind: 'execute', status: 'pending', rawInput: {} }); await flush();
    expect(s.events.filter((e) => e.t === 'message')).toMatchObject([{ text: 'new reply' }]);
    await s.close();
  });
});
