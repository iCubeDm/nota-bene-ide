#!/usr/bin/env node
// Scripted ACP agent (omp's wire shapes) for tests; no model API or account files.
// env: NB_ACP_FIXTURE_STATE (JSON file of stored sessions), NB_ACP_FIXTURE_VERSION (agentInfo.version)
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const argv = process.argv.slice(2);
if (argv[0] === 'session' && argv[1] === 'lease') { process.stdout.write(JSON.stringify({ held: [], unknown: [] }) + '\n'); process.exit(0); }
const approval = argv[argv.indexOf('--approval-mode') + 1] ?? 'yolo';
const store = process.env.NB_ACP_FIXTURE_STATE;
const read = () => { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return { sessions: {} }; } };
const save = (s) => { if (store) fs.writeFileSync(store, JSON.stringify(s)); };
const out = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const reply = (id, result) => out({ id, result });
const update = (sessionId, u) => out({ method: 'session/update', params: { sessionId, update: u } });
const asks = new Map(); let askId = 0;
const ask = (method, params) => new Promise((resolve) => { const id = `ask-${++askId}`; asks.set(id, resolve); out({ id, method, params }); });

const config = (s) => [
  { id: 'mode', currentValue: s.mode ?? 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
  { id: 'model', currentValue: s.model ?? 'fixture/alpha', options: [{ value: 'fixture/alpha', name: 'Alpha' }, { value: 'fixture/beta', name: 'Beta' }, { value: 'other/gamma', name: 'Gamma' }] },
  { id: 'thinking', currentValue: s.thinking ?? 'high', options: ['off', 'auto', 'low', 'high'].map((value) => ({ value, name: value })) },
];
const commands = (sessionId) => update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }, { name: 'rename', description: 'Rename', input: { hint: '<title>' } }, { name: 'green', description: 'A user command' }] });
const live = new Map(); // sessionId -> settings of this process
let running; // { id, sessionId, cancel() }

function newSession(cwd, from) {
  const s = read(), n = Object.keys(s.sessions).length + 1;
  const id = `01a1a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  s.sessions[id] = { cwd, title: 'ACP fixture', updatedAt: new Date(Date.now() + n).toISOString(), turns: from ? [...s.sessions[from].turns] : [] };
  save(s); live.set(id, {});
  return id;
}

async function prompt(r) {
  const { sessionId } = r.params, text = (r.params.prompt ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (running) { const old = running; running = undefined; old.cancel(); }
  let cancelled = false, wake;
  const me = { id: r.id, sessionId, cancel: () => { cancelled = true; wake?.(); } };
  running = me;
  const finish = (reply_, stopReason = 'end_turn') => {
    if (running === me) running = undefined;
    if (stopReason === 'end_turn' && reply_ !== undefined) {
      const mid = `msg-${r.id}`;
      update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: mid, content: { type: 'text', text: reply_ } });
      update(sessionId, { sessionUpdate: 'usage_update', size: 1000, used: 200, cost: { amount: 0.01, currency: 'USD' } });
      const s = read(); s.sessions[sessionId].turns.push({ user: text, text: reply_ }); s.sessions[sessionId].updatedAt = new Date().toISOString(); save(s);
    }
    reply(r.id, { stopReason, ...(stopReason === 'end_turn' ? { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } : {}) });
  };
  const tool = (toolCallId, name, kind, rawInput) => update(sessionId, { sessionUpdate: 'tool_call', toolCallId, name, title: name, kind, status: 'pending', rawInput, locations: [] });
  const done = (toolCallId, ok, text_) => update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: ok ? 'completed' : 'failed', rawOutput: { content: [{ type: 'text', text: text_ }] } });
  const rename = /^\/rename\s+(.+)$/.exec(text);
  if (rename) { const s = read(); s.sessions[sessionId].title = rename[1]; save(s); return finish(undefined); }
  if (text.includes('slow')) {
    await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 5000); });
    return cancelled ? finish(undefined, 'cancelled') : finish('omp: ' + text);
  }
  if (cancelled) return finish(undefined, 'cancelled');
  if (text.includes('run')) {
    const id = `run-${r.id}`;
    let ok = true;
    if (approval !== 'yolo') {
      const a = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: id, title: 'echo hi', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } }, options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }, { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' }] });
      ok = a?.outcome?.outcome === 'selected' && a.outcome.optionId.startsWith('allow');
    }
    if (cancelled) return finish(undefined, 'cancelled');
    tool(id, 'bash', 'execute', { command: 'echo hi' }); done(id, ok, ok ? 'ok' : 'Tool call denied by user: bash');
    return finish(ok ? 'ran it' : 'it was denied');
  }
  if (text.includes('write')) {
    const id = `write-${r.id}`;
    tool(id, 'write', 'edit', { path: 'hello.txt', content: 'hi\n' });
    let ok = true;
    if (approval === 'always-ask') {
      const a = await ask('elicitation/create', { mode: 'form', sessionId, message: 'Allow tool: write\nPath: hello.txt\nContent:\nhi\n', requestedSchema: { type: 'object', properties: { value: { type: 'string', enum: ['Approve', 'Approve write for this session', 'Deny'] } }, required: ['value'] } });
      ok = a?.action === 'accept' && String(a.content?.value).startsWith('Approve');
    }
    done(id, ok, ok ? 'wrote hello.txt' : 'Tool call denied by user: write');
    return finish(ok ? 'wrote it' : 'it was denied');
  }
  if (text.includes('question')) {
    const id = `ask-${r.id}`;
    tool(id, 'ask', 'other', { question: 'Which colour?' });
    const a = await ask('elicitation/create', { mode: 'form', sessionId, message: 'Which colour?', requestedSchema: { type: 'object', properties: { q0: { type: 'string', title: 'Which colour?', oneOf: [{ const: 'Blue', title: 'Blue' }, { const: 'Green', title: 'Green' }] }, q0__other: { type: 'string', title: 'Other (type your own)' } } } });
    const answer = a?.action === 'accept' ? a.content?.q0 ?? a.content?.q0__other ?? '' : '';
    done(id, a?.action === 'accept', answer);
    return finish('Answer: ' + answer);
  }
  return finish('omp: ' + text);
}

function handle(r) {
  const p = r.params ?? {};
  if (!r.method) { asks.get(r.id)?.(r.result); asks.delete(r.id); return; }
  if (r.method === 'session/cancel') { if (running?.sessionId === p.sessionId) { const old = running; running = undefined; old.cancel(); } return; }
  if (r.id === undefined) return;
  const fail = (details) => out({ id: r.id, error: { code: -32603, message: 'Internal error', data: { details } } });
  switch (r.method) {
    case 'initialize': return reply(r.id, { protocolVersion: 1, agentInfo: { name: 'omp', title: 'omp', version: process.env.NB_ACP_FIXTURE_VERSION ?? '18.16.0' }, authMethods: [], agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} } } });
    case 'session/new': { const id = newSession(p.cwd); reply(r.id, { sessionId: id, configOptions: config({}) }); return commands(id); }
    case 'session/fork': {
      if (!read().sessions[p.sessionId]) return fail(`ACP session not found: ${p.sessionId}`);
      const id = newSession(p.cwd, p.sessionId); reply(r.id, { sessionId: id, configOptions: config({}) }); return commands(id);
    }
    case 'session/load': {
      const s = read().sessions[p.sessionId];
      if (!s) return fail(`ACP session not found: ${p.sessionId}`);
      s.turns.forEach((t, i) => {
        update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: t.user } });
        update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: `replay-${i}`, content: { type: 'text', text: t.text } });
      });
      live.set(p.sessionId, live.get(p.sessionId) ?? {});
      reply(r.id, { configOptions: config(live.get(p.sessionId)) }); return commands(p.sessionId);
    }
    case 'session/list': {
      const sessions = Object.entries(read().sessions).filter(([, s]) => !p.cwd || s.cwd === p.cwd).map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt, _meta: { messageCount: s.turns.length * 2, size: 100 } }));
      return reply(r.id, { sessions });
    }
    case 'session/set_config_option': {
      const s = live.get(p.sessionId) ?? {}; live.set(p.sessionId, s);
      s[p.configId] = p.value;
      if (p.configId === 'mode') update(p.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: p.value });
      return reply(r.id, { configOptions: config(s) });
    }
    case 'session/close': return reply(r.id, {});
    case 'session/prompt': return void prompt(r);
    default: return out({ id: r.id, error: { code: -32601, message: 'Method not found' } });
  }
}

const decoder = new StringDecoder('utf8'); let text = '';
process.stdin.on('data', (data) => {
  text += decoder.write(data);
  for (let i; (i = text.indexOf('\n')) >= 0;) { const line = text.slice(0, i); text = text.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
process.stdin.on('end', () => process.exit(0));
