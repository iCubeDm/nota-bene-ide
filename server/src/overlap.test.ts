import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@nota-bene/shared';
import { editedFiles, overlapWatch, type Overlap } from './overlap.ts';

const call = (name: string, input: Record<string, unknown>, o: Partial<Extract<AgentEvent, { t: 'tool-call' }>> = {}): AgentEvent =>
  ({ t: 'tool-call', id: 'c', name, input, sub: false, ...o });

describe('editedFiles: the files a tool call writes, absolute', () => {
  it('Claude\'s edits, Codex\'s patch, an ACP edit; reads, commands and a subagent\'s call write none here', () => {
    expect(editedFiles(call('Edit', { file_path: '/p/a.ts' }), '/p')).toEqual(['/p/a.ts']);
    expect(editedFiles(call('Write', { file_path: 'b.md' }), '/p')).toEqual(['/p/b.md']);
    expect(editedFiles(call('NotebookEdit', { notebook_path: '/p/n.ipynb' }), '/p')).toEqual(['/p/n.ipynb']);
    expect(editedFiles(call('apply_patch', { changes: [{ path: '/p/x.ts' }, { path: 'y.ts' }] }, { toolKind: 'file' }), '/p')).toEqual(['/p/x.ts', '/p/y.ts']);
    expect(editedFiles(call('edit', { path: '/p/z.ts' }, { toolKind: 'file' }), '/p')).toEqual(['/p/z.ts']);
    expect(editedFiles(call('Read', { file_path: '/p/a.ts' }), '/p')).toEqual([]);
    expect(editedFiles(call('read', { path: '/p/a.ts' }, { toolKind: 'file' }), '/p')).toEqual([]);
    expect(editedFiles(call('Bash', { command: 'echo > a.ts' }), '/p')).toEqual([]);
    expect(editedFiles(call('Edit', { file_path: '/p/a.ts' }, { sub: true }), '/p')).toEqual([]);
    expect(editedFiles({ t: 'turn-end', stop: 'done', secs: 1, answers: [], queued: 0 } as never, '/p')).toEqual([]);
  });
});

describe('overlapWatch: an uncommitted file two agents edit in overlapping turns', () => {
  const setup = (dirty = true) => {
    const found: Overlap[] = [];
    let now = 0;
    const w = overlapWatch({ now: () => now, dirty: async () => dirty, found: (o) => found.push(o) });
    return { w, found, at: (t: number) => { now = t; } };
  };
  const edit = (file: string) => call('Edit', { file_path: file });

  it('both turns running: one warning for the pair and file, said once', async () => {
    const { w, found, at } = setup();
    at(1); w.turn('A', true); w.turn('B', true);
    at(2); await w.event('A', '/p', edit('/p/x.ts'));
    expect(found).toEqual([]);
    at(3); await w.event('B', '/p', edit('/p/x.ts'));
    expect(found).toEqual([{ file: '/p/x.ts', agents: ['B', 'A'] }]);
    at(4); await w.event('B', '/p', edit('/p/x.ts'));
    await w.event('A', '/p', edit('/p/x.ts'));
    expect(found).toHaveLength(1);
  });

  it('the other\'s turn ended before this one began: no overlap; it ended after: overlap', async () => {
    const { w, found, at } = setup();
    at(1); w.turn('A', true);
    at(2); await w.event('A', '/p', edit('/p/x.ts'));
    at(3); w.turn('A', false);
    at(4); w.turn('B', true);
    at(5); await w.event('B', '/p', edit('/p/x.ts'));
    expect(found).toEqual([]);
    at(6); w.turn('C', true);
    at(7); w.turn('B', false);
    at(8); await w.event('C', '/p', edit('/p/x.ts'));
    expect(found).toEqual([{ file: '/p/x.ts', agents: ['C', 'B'] }]);
  });

  it('another file, a committed file, or a gone agent: none', async () => {
    const { w, found, at } = setup(false);
    at(1); w.turn('A', true); w.turn('B', true);
    await w.event('A', '/p', edit('/p/x.ts'));
    await w.event('B', '/p', edit('/p/x.ts'));
    expect(found).toEqual([]);
    const s = setup();
    s.w.turn('A', true); s.w.turn('B', true);
    await s.w.event('A', '/p', edit('/p/x.ts'));
    await s.w.event('B', '/p', edit('/p/y.ts'));
    s.w.forget('A');
    await s.w.event('B', '/p', edit('/p/x.ts'));
    expect(s.found).toEqual([]);
  });

  it('a new pair of turns may warn again', async () => {
    const { w, found, at } = setup();
    at(1); w.turn('A', true); w.turn('B', true);
    await w.event('A', '/p', edit('/p/x.ts'));
    await w.event('B', '/p', edit('/p/x.ts'));
    at(2); w.turn('A', false); w.turn('B', false);
    at(3); w.turn('A', true); w.turn('B', true);
    await w.event('A', '/p', edit('/p/x.ts'));
    await w.event('B', '/p', edit('/p/x.ts'));
    expect(found).toHaveLength(2);
  });
});
