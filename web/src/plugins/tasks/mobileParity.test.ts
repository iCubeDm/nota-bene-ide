// The phone keeps its tasks with its own port of the reducer and the drawer's rows (mobile/app/lib/tasks/tasks.dart):
// this writes and checks what the desktop's reduceTasks, orderedTasks, selectTaskRows and counts make of fixed event
// sequences, and what plainOutput and fmtElapsed give, which the app's tasks_test compares with its own (issue 573).
// UPDATE_FIXTURES=1 rewrites the JSON after a deliberate change of either side.
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { orderedTasks, reduceTasks, type ServerEvent, type TasksState, type WireAgentEvent } from '@nota-bene/shared';
import type { RootState } from '@/sdk';
import { plainOutput } from './ansi.ts';
import { selectFinishedCount, selectRunningCount, selectTaskRows, selectWatcherCount } from './slice.ts';
import { fmtElapsed } from './time.ts';

type TaskEvent = Extract<WireAgentEvent, { t: 'task' }>;
let clock = 0;
const ev = (e: Omit<TaskEvent, 't'> | { t: string }, ts = (clock += 1000)): ServerEvent => ({ kind: 'agent', ts, e: { t: 'task', ...e } as TaskEvent });
const start = (id: string, more: Partial<TaskEvent> = {}) => ev({ id, phase: 'started', desc: `do ${id}`, type: 'local_agent', ...more });
const done = (id: string, status?: 'failed' | 'stopped') => ev({ id, phase: 'done', ...(status ? { status } : {}) });

const CASES: Record<string, () => ServerEvent[]> = {
  lifecycle: () => [
    start('a', { call: 'toolu_a', model: 'claude-sonnet-5-5', bg: false }),
    ev({ id: 'a', phase: 'progress', tokens: 1200, tool: 'Read', summary: 'reading' }),
    ev({ id: 'a', phase: 'updated', desc: 'renamed', bg: true }),
    ev({ id: 'nobody', phase: 'progress', tokens: 5 }),
    start('s', { type: 'local_bash', desc: 'npm test' }),
    start('m', { type: 'monitor_mcp', desc: undefined }),
    start('w', { type: 'local_workflow', workflow: 'review' }),
    start('r', { type: 'remote_agent' }),
    start('o', { type: 'something' }),
    start('n', { type: undefined, call: 'toolu_n' }),
    done('a'),
    ev({ id: 'a', phase: 'progress', tokens: 9 }),
    done('a', 'failed'),
    done('s', 'failed'),
    done('o', 'stopped'),
    done('ghost'),
  ],
  resume: () => [
    start('k', { call: 'toolu_1', parent: 'p0', group: 'g1', bg: true, model: 'sonnet' }),
    done('k'),
    start('k', { call: 'toolu_2', parent: 'p9', group: 'g2', desc: 'again' }),
    { kind: 'agent', ts: 99, e: { t: 'message', id: 'm:0', text: 'not a task' } } as ServerEvent,
  ],
  nesting: () => [
    start('p', { call: 'toolu_p' }),
    start('k1', { parent: 'p', type: 'local_bash' }),
    start('k2', { parent: 'p' }),
    start('g', { parent: 'k2', type: 'local_bash' }),
    start('lone', { parent: 'gone' }),
    start('x', { parent: 'y' }),
    start('y', { parent: 'x' }),
    start('self', { parent: 'self' }),
    start('q'),
    start('qk', { parent: 'q' }),
    done('q'),
    done('p'),
    done('k1'),
  ],
  swarm: () => [
    start('a1', { group: 'r1', call: 'toolu_1' }),
    start('a2', { group: 'r1', call: 'toolu_2' }),
    start('a3', { group: 'r1', call: 'toolu_3' }),
    ev({ id: 'a1', phase: 'progress', tokens: 100 }),
    ev({ id: 'a2', phase: 'progress', tokens: 50 }),
    start('solo', { group: 'r2' }),
    start('sh', { group: 'r1', type: 'local_bash' }),
    start('p', { call: 'toolu_p' }),
    start('c1', { parent: 'p', group: 'r3' }),
    start('c2', { parent: 'p', group: 'r3' }),
    done('a1'),
    done('a2', 'failed'),
    done('c1', 'stopped'),
    done('c2'),
  ],
  workflow: () => [
    start('wf', { type: 'local_workflow', workflow: 'audit', desc: 'audit run' }),
    start('i1', { parent: 'wf', inner: true }),
    start('i2', { parent: 'wf', inner: true }),
    ev({ id: 'i1', phase: 'updated', model: 'claude-haiku-5' }),
    start('watch', { type: 'monitor_mcp', ambient: true }),
    done('i1'),
  ],
  watchers: () => [
    start('watch', { type: 'monitor_mcp', ambient: true }),
    start('done1', { type: 'local_bash' }),
    done('done1'),
    start('watch2', { type: 'monitor_mcp', ambient: true }),
    done('watch2'),
  ],
  cap: () => {
    const out: ServerEvent[] = [];
    for (let i = 0; i < 24; i++) out.push(start(`t${i}`, { type: 'local_bash', ...(i % 5 === 0 ? { inner: true, parent: 'wf' } : {}) }));
    out.push(start('wf', { type: 'local_workflow', workflow: 'w' }));
    for (let i = 0; i < 24; i++) out.push(done(`t${i}`));
    out.push(start('live', { type: 'local_bash' }));
    return out;
  },
  replay: () => [
    start('before'),
    { kind: 'replay', events: [start('r1'), start('r2', { type: 'local_bash' }), done('r2'), { kind: 'agent', ts: 1, e: { t: 'reset', prev: 'x' } }, start('r3')] } as ServerEvent,
    start('after'),
    { kind: 'agent', ts: clock + 500, e: { t: 'reset', prev: 'y' } } as ServerEvent,
    start('fresh'),
  ],
};

/** What the drawer's rows are, as both sides hold them. */
function rows(tasks: TasksState) {
  return selectTaskRows({ tasks } as RootState).map((r) => (r.group ? { id: r.id, depth: r.depth, group: r.group } : { id: r.id, depth: r.depth }));
}

const dir = path.resolve(__dirname, '../../../../mobile/app/test/fixtures/tasks');
const write = (name: string, json: string) => {
  const out = path.join(dir, name);
  if (process.env.UPDATE_FIXTURES) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(out, json);
  }
  expect(json).toBe(fs.readFileSync(out, 'utf8'));
};

it('the fixture directory holds exactly the cases', () => {
  expect(fs.readdirSync(dir).sort()).toEqual([...Object.keys(CASES).map((n) => `${n}.json`), 'text.json'].sort());
});

for (const [name, make] of Object.entries(CASES)) {
  it(`the tasks of ${name}`, () => {
    clock = 0;
    const events = make();
    const tasks = events.reduce(reduceTasks, {});
    const s = { tasks } as RootState;
    const counts = { running: selectRunningCount(s), finished: selectFinishedCount(s), watchers: selectWatcherCount(s) };
    write(`${name}.json`, JSON.stringify({ events, tasks, ordered: orderedTasks(tasks).map(([id]) => id), rows: rows(tasks), counts }, null, 1) + '\n');
  });
}

const OUTPUTS: [string, boolean][] = [
  ['\u001b[31mred\u001b[0m and \u001b[1;32;4mbold\u001b[m', false],
  ['a\u001b[2K\u001b[1Gb\u001b[?25l', false],
  ['\u001b]0;title\u0007text', false],
  ['\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\', false],
  ['a\r\nb\r\n', false],
  ['10%\r50%\r100%\ndone', false],
  ['file\n  1%\r 50%\r100%\r', false],
  ['a\r\r\nb', false],
  ['\u001b(B\u001b[mok', false],
  ['\u001b7saved\u001b8 \u001b=\u001b>x\u0007\u0000y', false],
  ['tab\there\nnext', false],
  ['-\b\\\b|\b/\bdone', false],
  ['ab\bc', false],
  ['2;32mcompiling\n', true],
  ['2;32mcompiling\n', false],
  ['plain text\n', true],
  ['ünïcødé ✓ 漢字\u001b[0m', false],
];
const ELAPSED = [0, 400, 500, 59_400, 59_600, 60_000, 125_000, 3_725_000, -5000];

it('the shell output text and the elapsed times', () => {
  write('text.json', JSON.stringify({
    plain: OUTPUTS.map(([raw, truncated]) => ({ raw, truncated, text: plainOutput(raw, truncated) })),
    elapsed: ELAPSED.map((ms) => ({ ms, text: fmtElapsed(ms) })),
  }, null, 1) + '\n');
});
