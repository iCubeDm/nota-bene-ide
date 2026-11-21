import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PLUGINS } from '@/plugins.ts';
import { makeStore } from '@/store/store.ts';
import type { TabKinds } from '@/tabs/slice.ts';
import { buildRegistry } from './registry.ts';
import { keyLabel, withKey } from '../shell/keymap.ts';
import type { Plugin } from './plugin.ts';
import type { KeyId } from './registry.ts';

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

it('two parts at one order of a slot fail the build', () => {
  const part = (id: string): Plugin => ({ id, slots: [{ slot: 'footer', order: 10, render: () => null }] });
  expect(() => buildRegistry([part('a'), part('b')])).toThrow('the slot "footer" has two parts at order 10');
});

// the frame's own parts sit between these at the orders its components give them (shell/frame.test.tsx pins the DOM)
it('each slot lists the plugins\' parts in the frame\'s order', () => {
  const slots = Object.fromEntries([...buildRegistry(PLUGINS).slots].map(([k, v]) => [k, v.map((s) => `${s.order} ${s.render.name}`)]));
  expect(slots).toEqual({
    'header.title': ['10 ProjectTitle'],
    'header.center': ['10 GitBranch'],
    'header.end': ['10 ConnNote', '20 UpdateNotice', '30 CompactPending', '40 RestartMenu', '50 ModelPill', '80 StopButton'],
    'header.menu': ['10 RemoteMenuRow'],
    'header.badge': ['10 RemoteDot'],
    'strip.left': ['10 FilesToggle', '20 VcsToggles'],
    'strip.right': ['10 CommentsToggle'],
    'panel.left': ['10 ProjectRail', '30 Tree', '40 ChangesPanel'],
    'panel.right': ['10 Comments'],
    chat: ['10 ChatFeed', '20 HighlightLayer'],
    panes: ['10 TasksDrawer'],
    footer: ['10 TasksIndicator', '20 Composer'],
    overlay: ['10 SelectionComment', '20 CommentCardPopover', '40 RecentFiles', '50 Starter', '60 Activity', '70 Seen'],
  });
});

const cmd = (id: string, order: number, key: KeyId = 'hk_files'): Plugin => ({ id, commands: [{ id: key, codes: ['KeyF'], mods: { alt: true }, inFields: false, order, run: () => {} }] });

it('a command id two plugins declare fails the build, and so does one order taken twice', () => {
  expect(() => buildRegistry([cmd('a', 1), cmd('b', 2)])).toThrow('the command "hk_files" is declared twice');
  expect(() => buildRegistry([cmd('a', 1, 'hk_closeTab')])).toThrow('the command "hk_closeTab" is declared twice'); // the core's own
  expect(() => buildRegistry([cmd('a', 1), cmd('b', 1, 'hk_wrap')])).toThrow('two commands at order 1');
});

// the order of the ? help and of matching: today's BINDINGS, the core's and the plugins' interleaved by `order`
it('the commands come in the help\'s order, core and plugins alike', () => {
  expect(buildRegistry(PLUGINS).commands.map((c) => c.id)).toEqual([
    'hk_closeTab', 'hk_reopenTab', 'hk_prevTab', 'hk_nextTab', 'hk_tabN', 'hk_recent', 'hk_projects', 'hk_promptHistory',
    'hk_promptOlder', 'hk_promptNewer', 'hk_files', 'hk_comments', 'hk_tasks', 'hk_voice', 'hk_wrap', 'hk_scaleUp',
    'hk_scaleDown', 'hk_scaleReset', 'hk_reveal', 'hk_composer',
  ]);
  expect(Object.isFrozen(buildRegistry(PLUGINS).commands)).toBe(true);
});

it('every command\'s tooltip key resolves through withKey and keyLabel, and every tooltip names a command', () => {
  makeStore({ url: 'u', connect: () => ({ send: () => true, close() {} }), plugins: PLUGINS });
  const ids = buildRegistry(PLUGINS).commands.map((c) => c.id);
  for (const id of ids) {
    expect(keyLabel(id), id).not.toBe('');
    expect(withKey('X', id)).toBe(`X (${keyLabel(id)})`);
  }
  const src = path.resolve(import.meta.dirname, '..');
  const named = fs.readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
    .flatMap((f) => [...fs.readFileSync(path.join(src, f), 'utf8').matchAll(/\b(?:withKey\([^\n]*?|keyLabel\()'(hk_\w+)'/g)].map((m) => m[1]));
  expect(named.length).toBeGreaterThan(5);
  expect(named.filter((id) => !ids.includes(id as never))).toEqual([]);
});
