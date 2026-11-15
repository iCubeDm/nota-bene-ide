import { expect, it } from 'vitest';
import { badgeOf, foldRows, titlePrefix } from './rows.ts';
import type { RunningRow } from './api.ts';

const row = (o: Partial<RunningRow>): RunningRow => ({
  provider: 'claude', port: 4791, root: '/w/a', title: null, session: null, state: 'idle', current: false, clients: 0, unseen: 0, last: null, ...o,
});

it('the windows of one folder make one row: the most urgent state, the summed unseen, the newest last message', () => {
  const rows = foldRows([
    row({ port: 1, root: '/w/site', state: 'idle', unseen: 2, last: { role: 'assistant', text: 'old', at: 10 } }),
    row({ port: 2, root: '/w/site', provider: 'codex', state: 'working', unseen: 1, last: { role: 'assistant', text: 'new', at: 20 } }),
    row({ port: 3, root: '/w/notes', state: 'restarting' }),
  ]);
  const site = rows.find((r) => r.root === '/w/site')!;
  expect(site).toMatchObject({ state: 'working', unseen: 3, last: { text: 'new' }, current: false });
  expect(site.windows.map((w) => w.port)).toEqual([2, 1]); // newest event first
  expect(rows.find((r) => r.root === '/w/notes')!.state).toBe('restarting');
});

it('waiting beats working beats idle beats silent beats restarting; a folder with this window is current', () => {
  expect(foldRows([row({ state: 'silent' }), row({ port: 2, state: 'waiting' })])[0]!.state).toBe('waiting');
  expect(foldRows([row({ state: 'idle' }), row({ port: 2, state: 'silent' })])[0]!.state).toBe('idle');
  expect(foldRows([row({ state: 'restarting' }), row({ port: 2, state: 'silent', current: true })])[0]).toMatchObject({ state: 'silent', current: true });
});

it('rows sort: waiting, then with unseen replies, then the rest; newest first within each; then by folder name', () => {
  const at = (n: number) => ({ role: 'assistant' as const, text: 'x', at: n });
  const order = foldRows([
    row({ root: '/w/b', last: at(50) }),
    row({ root: '/w/a', last: at(50) }),
    row({ root: '/w/new', unseen: 1, last: at(10) }),
    row({ root: '/w/newer', unseen: 4, last: at(30) }),
    row({ root: '/w/ask', state: 'waiting', last: at(1) }),
    row({ root: '/w/latest', last: at(90) }),
  ]).map((r) => r.root);
  expect(order).toEqual(['/w/ask', '/w/newer', '/w/new', '/w/latest', '/w/a', '/w/b']);
});

it('one badge over the other projects: ! when any waits, else the unseen count, else none', () => {
  const r = (o: Partial<{ state: RunningRow['state']; unseen: number; current: boolean }>) => ({ state: 'idle' as const, unseen: 0, current: false, ...o });
  expect(badgeOf([r({ unseen: 3 }), r({ state: 'waiting' })])).toBe('!');
  expect(badgeOf([r({ unseen: 3 }), r({ unseen: 1 })])).toBe(4);
  expect(badgeOf([r({ state: 'waiting', current: true, unseen: 5 })])).toBeNull();
  expect(badgeOf([])).toBeNull();
});

it('the tab title carries the same badge', () => {
  expect(titlePrefix('!')).toBe('(!) ');
  expect(titlePrefix(4)).toBe('(4) ');
  expect(titlePrefix(null)).toBe('');
});
