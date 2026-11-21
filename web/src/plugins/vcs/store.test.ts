import { beforeEach, expect, it } from 'vitest';
import { setTreeOpen } from '@/plugins/files/treeSlice.ts';
import { makeStore } from '@/core/testing';
import { pickBase, setPanel, setSplit } from './store.ts';

// the git views' state is the vcs slice (issue 545); its listeners save what outlives the page and share the left side
const store = () => makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });

beforeEach(() => localStorage.clear());

it('the diff layout and the bases are saved when they change, and a new store starts from them', () => {
  const s = store();
  s.dispatch(setSplit(true));
  expect(localStorage.getItem('vcs:split')).toBe('1');
  s.dispatch(pickBase('/p', 'here', 'main'));
  expect(JSON.parse(localStorage.getItem('vcs:bases')!)).toEqual({ '/p\0here': 'main' });
  expect(store().getState().vcs).toMatchObject({ split: true, bases: { '/p\0here': 'main' } });
  s.dispatch(pickBase('/p', 'here', null));
  expect(JSON.parse(localStorage.getItem('vcs:bases')!)).toEqual({});
});

it('the tree opening closes the Changes panel', () => {
  const s = store();
  s.dispatch(setTreeOpen(false));
  s.dispatch(setPanel(true));
  expect(s.getState().vcs.panel).toBe(true);
  s.dispatch(setTreeOpen(true));
  expect(s.getState().vcs.panel).toBe(false);
});
