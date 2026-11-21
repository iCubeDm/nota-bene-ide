import { expect, it } from 'vitest';
import { PLUGINS } from '@/plugins.ts';
import { makeStore } from '@/store/store.ts';
import type { TabKinds } from '@/tabs/slice.ts';
import { buildRegistry } from './registry.ts';
import type { Plugin } from './plugin.ts';

const view = (id: string): Plugin => ({ id, tabs: [{ kind: 'settings', label: () => id }] });

it('a tab kind two plugins declare fails the build, and so the store', () => {
  expect(() => buildRegistry([view('a'), view('b')])).toThrow('the tab kind "settings" is declared twice');
  expect(() => makeStore({ url: 'u', connect: () => ({ send: () => true, close() {} }), plugins: [view('a'), view('b')] })).toThrow('declared twice');
});

it('the registry is frozen', () => {
  expect(Object.isFrozen(buildRegistry([view('a')]))).toBe(true);
});

it('the app shows every tab kind: each has one view among PLUGINS', () => {
  const kinds: Record<keyof TabKinds, true> = { chat: true, file: true, diagram: true, agent: true, shell: true, settings: true, usage: true, remote: true, changes: true, log: true };
  expect([...buildRegistry(PLUGINS).tabs.keys()].sort()).toEqual(Object.keys(kinds).sort());
});
