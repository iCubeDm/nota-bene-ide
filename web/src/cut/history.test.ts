import { expect, it } from 'vitest';
import { commit, redo, start, undo } from './history.ts';

it('commits, undoes and redoes; a commit after an undo drops the redo', () => {
  let h = start('a');
  h = commit(h, 'b');
  h = commit(h, 'c');
  expect(h.now).toBe('c');
  h = undo(h);
  expect(h.now).toBe('b');
  h = undo(h);
  h = undo(h); // nothing before: stays
  expect(h.now).toBe('a');
  h = redo(h);
  expect(h.now).toBe('b');
  h = commit(h, 'd');
  expect(redo(h)).toBe(h);
  expect(undo(h).now).toBe('b');
});

it('the same value is no new step; the oldest steps go past the limit', () => {
  let h = start(0);
  expect(commit(h, 0)).toBe(h);
  for (let i = 1; i <= 5; i++) h = commit(h, i, 3);
  expect(h.past).toEqual([2, 3, 4]);
});
