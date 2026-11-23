// The phone builds its chat feed with its own port of reduce() (mobile/app/lib/chat/feed.dart): this writes and checks
// what the desktop's reduce() makes of fixed event sequences, as `{ events, items }`, which the app's feed_test replays
// and compares. `items` projects the fields both models hold; `phase` is the phone's header pill phase for a tool,
// computed here because the web has none. UPDATE_FIXTURES=1 rewrites the JSON after a deliberate change of either side.
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ServerEvent, WireAgentEvent } from '@nota-bene/shared';
import { emptyFeed, reduce, retriedVoice, type FeedItem } from './feed.ts';

type ToolItem = Extract<FeedItem, { kind: 'tool' }>;

const PHASE_BY_KIND: Partial<Record<NonNullable<ToolItem['toolKind']>, string>> = { command: 'running', search: 'searching', agent: 'delegating' };
const PHASE_BY_NAME: Record<string, string> = {
  read: 'reading', notebookread: 'reading',
  grep: 'searching', glob: 'searching', ls: 'searching', find: 'searching', search: 'searching', websearch: 'searching', webfetch: 'searching',
  edit: 'editing', multiedit: 'editing', write: 'editing', notebookedit: 'editing', apply_patch: 'editing',
  bash: 'running', shell: 'running', exec: 'running',
  task: 'delegating', agent: 'delegating',
};

/** What the phone's pill says while this tool runs: the normalized kind first, the tool's name for the rest. */
function phase(it: ToolItem): string | null {
  return (it.toolKind && PHASE_BY_KIND[it.toolKind]) ?? PHASE_BY_NAME[it.name.toLowerCase()] ?? null;
}

function project(it: FeedItem): Record<string, unknown> {
  switch (it.kind) {
    case 'user':
      return { kind: it.kind, id: it.id, text: it.text, force: !!it.force, duringWork: !!it.duringWork, idle: !!it.idle,
        voice: it.voice?.id ?? null, voiceText: it.voiceText ?? null, voiceError: it.voiceError ?? null, voiceLang: it.voiceLang ?? null };
    case 'assistant':
      return { kind: it.kind, id: it.id, text: it.text, final: it.final };
    case 'tool':
      return { kind: it.kind, id: it.id, name: it.name, arg: it.arg, sub: it.sub, result: it.result?.text ?? null, isError: it.result?.isError ?? false, phase: phase(it) };
    case 'marker':
      return { kind: it.kind, key: it.key, what: it.what, pre: it.pre ?? null, error: it.error ?? null };
    case 'done':
      return { kind: it.kind, key: it.key, secs: it.secs, status: it.status, error: it.error ?? null };
    case 'permission':
      return { kind: it.kind, id: it.id, toolName: it.toolName, answer: it.answer ?? null, archived: !!it.archived };
    case 'shell':
      return { kind: it.kind, id: it.id, cmd: it.cmd, output: it.output, running: it.running, code: it.code };
    case 'notice':
      return { kind: it.kind, key: it.key, text: it.text };
    case 'overlap': // not on the phone yet: no case below has one
      return { kind: it.kind, key: it.key, file: it.file, agent: it.agent };
  }
}

const a = (e: WireAgentEvent | { t: string }, ts = 1) => ({ kind: 'agent', e, ts }) as ServerEvent;
const user = (id: string, text: string, more: Record<string, unknown> = {}) => ({ kind: 'user', id, text, ts: 1, ...more }) as ServerEvent;
const tool = (id: string, name: string, input: Record<string, unknown>, more: Record<string, unknown> = {}) =>
  a({ t: 'tool-call', id, name, input, sub: false, ...more } as WireAgentEvent);
const result = (id: string, text: string, isError = false, more: Record<string, unknown> = {}) =>
  a({ t: 'tool-update', id, text, isError, ...more } as WireAgentEvent);
const end = (more: Record<string, unknown> = {}) => a({ t: 'turn-end', stop: 'done', secs: 3, answers: 'all', queued: 0, ...more } as WireAgentEvent);
const session: ServerEvent = { kind: 'session', id: 'sess-1', root: '/project', title: 'Fixture', model: 'model-a' };
const voice = { id: 'v1', ms: 1200, wave: [1, 2, 3] };

const CASES: Record<string, ServerEvent[]> = {
  replay: [
    user('live', 'dropped by the replay'),
    { kind: 'replay', earlier: 2, events: [
      session,
      user('u1', 'hi', { historic: true }),
      a({ t: 'message', id: 'a1:0', text: 'hello' }),
      tool('t1', 'Read', { file_path: 'src/a.ts' }),
      result('t1', 'line 1'),
      end({ answers: ['u1'] }),
      { kind: 'resumed', id: '0123456789abcdef' },
    ] },
    user('u2', 'after the replay'),
  ],
  stream: [
    user('u1', 'go'),
    a({ t: 'message-start' }),
    a({ t: 'message-chunk', text: 'Hel' }),
    a({ t: 'message-chunk', text: 'lo' }),
    a({ t: 'message-start' }),
    a({ t: 'message-chunk', text: 'second' }),
    a({ t: 'message', id: 'm1:0', text: 'Hello!' }),
    a({ t: 'message', id: 'm1:1', text: 'second block' }),
    a({ t: 'message', id: 'm1:2', text: 'with no open stream' }),
    a({ t: 'message-start' }),
    a({ t: 'message-chunk', text: 'cut short' }),
    a({ t: 'message-start' }),
    end({ answers: ['u1'] }),
  ],
  tools: [
    user('u1', 'work'),
    tool('t1', 'Bash', { command: 'npm test\nmore', description: 'x' }),
    result('t1', 'ok'),
    tool('t2', 'Grep', { pattern: 'x'.repeat(200) }),
    result('t2', 'no match', true),
    tool('t3', 'Edit', { file_path: '', description: 'falls through empty values' }),
    tool('t4', 'Agent', { description: 'look around', prompt: 'find it' }, { toolKind: 'agent', childSessionId: 'child-1' }),
    a({ t: 'tool-call', id: 't5', name: 'Read', input: { file_path: 'b.ts' }, sub: true }),
    result('t5', 'sub result'),
    result('t4', 'found it'),
    tool('t6', 'read', { path: 'c.ts' }, { toolKind: 'file' }),
    tool('t7', 'run', { command: 'ls' }, { toolKind: 'command' }),
    tool('t8', 'lookup', { query: 'docs' }, { toolKind: 'other' }),
    result('t8', 'found', false, { toolKind: 'search' }),
    tool('t9', 'mcp__srv__do', { n: 1 }, { toolKind: 'mcp' }),
    tool('t10', 'apply_patch', { patch: '...' }),
    tool('t11', 'WebFetch', { url: 'https://example.com/page' }),
    tool('t12', 'Skill', { skill: 'some-skill' }),
    result('missing', 'no tool with this id'),
    end({ answers: ['u1'] }),
  ],
  permission: [
    user('u1', 'edit it'),
    { kind: 'permission', id: 'p1', toolName: 'Edit', input: { file_path: 'a.ts' }, ts: 1 },
    { kind: 'permission-done', id: 'p1', allow: true, ts: 2 },
    { kind: 'permission', id: 'p2', toolName: 'Bash', input: { command: 'rm x' }, ts: 3 },
    { kind: 'permission-done', id: 'p2', allow: false, ts: 4 },
    { kind: 'permission', id: 'p3', toolName: 'exec', input: { command: 'make' }, ts: 5,
      prompt: { title: 'Run make?', choices: [{ id: 'yes', label: 'Yes', allow: true }, { id: 'no', label: 'No', allow: false }] } },
    { kind: 'permission-done', id: 'missing', allow: true, ts: 6 },
  ],
  plan: [
    user('u1', 'plan it'),
    { kind: 'mode', mode: 'plan' },
    { kind: 'permission', id: 'p1', toolName: 'ExitPlanMode', input: { plan: '# Plan\n\n1. one\n2. two' }, ts: 1 },
    { kind: 'permission-done', id: 'p1', allow: true, ts: 2 },
    { kind: 'mode', mode: 'default' },
    a({ t: 'message', id: 'm1:0', text: 'doing it' }),
    end({ answers: ['u1'] }),
  ],
  shell: [
    { kind: 'shell-start', id: 's1', cmd: 'ls', ts: 1 },
    { kind: 'shell-out', id: 's1', text: 'a', truncated: false },
    { kind: 'shell-out', id: 's1', text: 'a\nb', truncated: false },
    { kind: 'shell-end', id: 's1', cmd: 'ls', output: 'a\nb\n', truncated: false, code: 0, ts: 2 },
    { kind: 'shell-out', id: 's1', text: 'late frame', truncated: false },
    { kind: 'shell-end', id: 's2', cmd: 'false', output: '', truncated: false, code: 1, ts: 3 },
    { kind: 'shell-start', id: 's3', cmd: 'sleep 9', ts: 4 },
    { kind: 'shell-start', id: 's3', cmd: 'sleep 9 again', ts: 5 },
  ] as ServerEvent[],
  compaction: [
    session,
    user('u1', 'go'),
    a({ t: 'compacting' }, 10),
    a({ t: 'compacting' }, 40),
    a({ t: 'compacted', preTokens: 150000, ms: 4000 }),
    a({ t: 'compact-failed', error: 'not compacting: ignored' }),
    a({ t: 'compacting' }),
    a({ t: 'compact-failed', error: 'too long' }),
    a({ t: 'compacting' }),
    a({ t: 'compact-end' }),
    end({ answers: ['u1'] }),
  ],
  clear: [
    session,
    user('u1', 'before'),
    end({ answers: ['u1'] }),
    a({ t: 'reset', prev: 'sess-0' }),
    end(),
    user('u2', 'after'),
    end({ answers: ['u2'] }),
  ],
  held: [
    user('u1', 'first'),
    { kind: 'send-held', id: 'u2' },
    { kind: 'compact-pending', pending: true, held: [] },
    user('u2', 'during work'),
    user('u3', 'queued'),
    end({ answers: ['u1'], queued: 1 }),
    a({ t: 'cancelled', sendId: 'u3' }),
    end({ answers: ['u2'] }),
    user('u4', 'forced', { force: true }),
    end({ stop: 'failed', answers: 'none' }),
    user('u5', 'crash'),
    end({ stop: 'failed', error: 'the agent died', answers: 'all' }),
    // an agent's exception with an empty message: no error text, so a forced send's interruption stays one
    user('u6', 'forced again', { force: true }),
    end({ stop: 'failed', error: '', answers: 'all' }),
    user('u7', 'empty error'),
    end({ stop: 'failed', error: '', answers: 'all' }),
    a({ t: 'turn-start' }),
    end({ answers: 'none', secs: 1 }),
  ],
  voice: [
    user('u1', '', { voice }),
    { kind: 'voice-text', id: 'u1', error: 'failed', ts: 2 },
    user('u2', '', { voice }),
    { kind: 'voice-text', id: 'u2', text: 'the transcript', lang: 'en', ts: 3 },
    user('u3', 'typed', { voice: { id: 'v2', ms: 500, wave: [] }, voiceLang: 'de', historic: true }),
    { kind: 'voice-text', id: 'u4', text: 'no such message', ts: 4 },
    user('u5', 'idle compact', { idle: true, historic: true }),
    user('u6', '', { voice: { id: 'v3', ms: 300, wave: [0] }, historic: true }),
    { kind: 'voice-text', id: 'u6', error: 'off', ts: 5 },
  ],
  unknown: [
    { kind: 'from-a-newer-server', x: 1 } as unknown as ServerEvent,
    a({ t: 'from-a-newer-agent' }),
    a({ t: 'mode', mode: 'plan' } as WireAgentEvent),
    a({ t: 'task', id: 'k1', phase: 'started' } as WireAgentEvent),
    a({ t: 'suggestion', text: 'next?' } as WireAgentEvent),
    { kind: 'restart-pending', pending: true },
    { kind: 'server-error', where: 'x', message: 'y' },
    a({ t: 'message', id: 'm1:0', text: 'still here' }),
  ],
};

const dir = path.resolve(__dirname, '../../../../mobile/app/test/fixtures/feed');

it('the fixture directory holds exactly the cases', () => {
  expect(fs.readdirSync(dir).sort()).toEqual(Object.keys(CASES).map((n) => `${n}.json`).sort());
});

for (const [name, events] of Object.entries(CASES)) {
  it(`the feed of ${name}`, () => {
    const items = events.reduce(reduce, emptyFeed).items;
    const hidden = retriedVoice(items); // drawn by neither side; the phone drops them from its model
    const json = JSON.stringify({ events, items: items.filter((it) => !(it.kind === 'user' && hidden.has(it.id))).map(project) }, null, 1) + '\n';
    const out = path.join(dir, `${name}.json`);
    if (process.env.UPDATE_FIXTURES) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(out, json);
    }
    expect(json).toBe(fs.readFileSync(out, 'utf8'));
  });
}
