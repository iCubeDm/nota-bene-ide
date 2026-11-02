import { expect, it } from 'vitest';
import { layout } from './graph.ts';

it('a straight history stays in one lane', () => {
  const rows = layout([{ sha: 'c', parents: ['b'] }, { sha: 'b', parents: ['a'] }, { sha: 'a', parents: [] }]);
  expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
});

it('a branch opens a lane and a merge closes it', () => {
  const rows = layout([
    { sha: 'm', parents: ['b', 'x'] },
    { sha: 'x', parents: ['a'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ]);
  expect(rows[0]!.down).toEqual([[0, 0], [0, 1]]);
  expect(rows[1]!.col).toBe(1);
  expect(rows[2]!.col).toBe(0);
  expect(rows[2]!.down).toEqual([[1, 1], [0, 1]]);
  expect(rows[3]!.col).toBe(1); // both lines meet in the lane already waiting for it
  expect(Math.max(...rows.map((r) => r.width))).toBe(2);
});
