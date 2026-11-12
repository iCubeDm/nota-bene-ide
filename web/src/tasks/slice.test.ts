import { expect, it } from 'vitest';
import type { WireAgentEvent } from '@nota-bene/shared';
import { shortModel } from '@nota-bene/shared';
import { makeStore, serverEvent } from '@/store/store.ts';
import { selectFinishedCount, selectRunningCount, selectTaskIdByCall, selectTaskRows } from './slice.ts';

type Task = Extract<WireAgentEvent, { t: 'task' }>;
function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  let ts = 0;
  const task = (e: Task) => store.dispatch(serverEvent({ kind: 'agent', e, ts: ++ts }));
  return { store, task };
}
const start = (id: string, extra: Partial<Task> = {}): Task => ({ t: 'task', phase: 'started', id, desc: id, type: 'local_bash', ...extra });
const done = (id: string, status?: 'failed' | 'stopped'): Task => ({ t: 'task', phase: 'done', id, ...(status ? { status } : {}) });

it('counts: running and finished apart; a finished task leaves the running count but stays listed', () => {
  const { store, task } = setup();
  task(start('a')); task(start('b')); task(done('a'));
  expect(selectRunningCount(store.getState())).toBe(1);
  expect(selectFinishedCount(store.getState())).toBe(1);
  expect(store.getState().tasks.a).toMatchObject({ status: 'done' });
});

it('rows: running first (oldest first), then finished newest first', () => {
  const { store, task } = setup();
  task(start('a')); task(start('b')); task(start('c')); task(done('a')); task(done('c', 'failed'));
  expect(selectTaskRows(store.getState()).map((r) => `${r.id}:${r.task?.status}`)).toEqual(['b:running', 'c:failed', 'a:done']);
});

it('rows: a task with a known parent is nested under it; an unknown parent stands alone; a cycle does not loop', () => {
  const { store, task } = setup();
  task(start('p', { type: 'local_agent' }));
  task(start('k1', { parent: 'p' }));
  task(start('k2', { parent: 'p' }));
  task(start('o', { parent: 'gone' }));
  task(start('x', { parent: 'y' }));
  task(start('y', { parent: 'x' }));
  expect(selectTaskRows(store.getState()).map((r) => `${r.depth}${r.id}`)).toEqual(['0p', '1k1', '1k2', '0o']);
});

it('a finished child stays under its running parent', () => {
  const { store, task } = setup();
  task(start('p', { type: 'local_agent' })); task(start('k', { parent: 'p' })); task(done('k'));
  expect(selectTaskRows(store.getState()).map((r) => `${r.depth}${r.id}`)).toEqual(['0p', '1k']);
});

const tag = (r: ReturnType<typeof selectTaskRows>[number]) => `${r.depth}${r.group ? `[${r.group.ids.join(',')}]` : r.id}`;

it('rows: agents launched by one response sit under one umbrella, wherever its first member stands; one alone or a shell stays plain', () => {
  const { store, task } = setup();
  task(start('a', { type: 'local_agent', group: 'msg_1' }));
  task(start('solo', { type: 'local_agent', group: 'msg_2' }));
  task(start('b', { type: 'local_agent', group: 'msg_1' }));
  task(start('sh1', { group: 'msg_3' })); task(start('sh2', { group: 'msg_3' })); // shells are not a swarm
  task(start('c', { type: 'local_agent', group: 'msg_1' }));
  task(done('a'));
  expect(selectTaskRows(store.getState()).map(tag)).toEqual(['0solo', '0[b,c,a]', '1b', '1c', '1a', '0sh1', '0sh2']);
  expect(selectTaskRows(store.getState())[1]!.id).toBe('group:msg_1');
});

it('rows: an umbrella aggregates its members: status, counts, tokens and the span from the first start to the last end', () => {
  const { store, task } = setup(); // event ts 1, 2, 3, ...
  task(start('a', { type: 'local_agent', group: 'g' })); task(start('b', { type: 'local_agent', group: 'g' })); task(start('c', { type: 'local_agent', group: 'g' }));
  task({ t: 'task', phase: 'progress', id: 'a', tokens: 100 }); task({ t: 'task', phase: 'progress', id: 'b', tokens: 50 });
  task(done('a')); task(done('b', 'failed'));
  let g = selectTaskRows(store.getState())[0]!.group!;
  expect(g).toMatchObject({ status: 'running', total: 3, running: 1, done: 1, failed: 1, stopped: 0, tokens: 150, start: 1 });
  expect(g.live).toEqual(['c']);
  expect(g.end).toBeUndefined();
  task(done('c', 'stopped'));
  g = selectTaskRows(store.getState())[0]!.group!;
  expect(g).toMatchObject({ status: 'failed', running: 0, stopped: 1, end: 8 });
  task(start('d', { type: 'local_agent', group: 'h' })); task(start('e', { type: 'local_agent', group: 'h' })); task(done('d')); task(done('e', 'stopped'));
  expect(selectTaskRows(store.getState()).find((r) => r.id === 'group:h')!.group!.status).toBe('stopped');
});

it('rows: a subagent\'s own parallel agents get an umbrella under it; the same group under two parents is two umbrellas', () => {
  const { store, task } = setup();
  task(start('p', { type: 'local_agent' }));
  task(start('k1', { type: 'local_agent', parent: 'p', group: 'm' })); task(start('k2', { type: 'local_agent', parent: 'p', group: 'm' }));
  task(start('q', { type: 'local_agent' }));
  task(start('k3', { type: 'local_agent', parent: 'q', group: 'm' }));
  expect(selectTaskRows(store.getState()).map(tag)).toEqual(['0p', '1[k1,k2]', '2k1', '2k2', '0q', '1k3']);
});

it('selectTaskByCall finds the running task of a call only', () => {
  const { store, task } = setup();
  task(start('a', { call: 'toolu_A' }));
  expect(selectTaskIdByCall(store.getState(), 'toolu_A')).toBe('a');
  task(done('a'));
  expect(selectTaskIdByCall(store.getState(), 'toolu_A')).toBeUndefined();
});

it('selectTaskIdByCall is a plain id: the same value while nothing changes, whatever else is dispatched', () => {
  const { store, task } = setup();
  task(start('a', { call: 'toolu_A' }));
  const a = selectTaskIdByCall(store.getState(), 'toolu_A');
  task(start('b'));
  expect(selectTaskIdByCall(store.getState(), 'toolu_A')).toBe(a);
});

it('model: kept from started, replaced by a progress that knows better, kept by a plain progress, a resume and a replay', () => {
  const { store, task } = setup();
  task(start('a', { type: 'local_agent', model: 'sonnet' }));
  expect(store.getState().tasks.a.model).toBe('sonnet');
  task({ t: 'task', phase: 'progress', id: 'a', tokens: 5 });
  expect(store.getState().tasks.a.model).toBe('sonnet');
  task({ t: 'task', phase: 'progress', id: 'a', tokens: 6, model: 'claude-sonnet-5-5' });
  expect(store.getState().tasks.a.model).toBe('claude-sonnet-5-5');
  task({ t: 'task', phase: 'updated', id: 'a', model: 'claude-opus-5-5' });
  expect(store.getState().tasks.a.model).toBe('claude-opus-5-5');
  task(start('a', { type: 'local_agent' })); // a resume does not say it again
  expect(store.getState().tasks.a.model).toBe('claude-opus-5-5');
  const events = [start('b', { model: 'claude-haiku-5-5' }), { t: 'task', phase: 'progress', id: 'b', tokens: 1 } as Task];
  store.dispatch(serverEvent({ kind: 'replay', events: events.map((e) => ({ kind: 'agent' as const, e, ts: 1 })) }));
  expect(store.getState().tasks.b.model).toBe('claude-haiku-5-5');
});

it('shortModel: a Claude id reads as a name and version, an alias as a name, anything else as given', () => {
  expect(shortModel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
  expect(shortModel('claude-opus-4-1')).toBe('Opus 4.1');
  expect(shortModel('claude-haiku-5-5')).toBe('Haiku 5.5');
  expect(shortModel('claude-opus-4-1-20250805')).toBe('Opus 4.1');
  expect(shortModel('claude-sonnet-5')).toBe('Sonnet 5');
  expect(shortModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5');
  expect(shortModel('claude-fable-5-2')).toBe('Fable 5.2');
  expect(shortModel('claude-fable-5[1m]')).toBe('Fable 5');
  expect(shortModel('sonnet')).toBe('Sonnet');
  expect(shortModel('fable')).toBe('Fable');
  expect(shortModel('opus')).toBe('Opus');
  expect(shortModel('gpt-5-codex')).toBe('gpt-5-codex');
});
