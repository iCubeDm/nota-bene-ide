import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PLUGINS } from '@/plugins.ts';
import { makeStore, useService } from '@/core/store/store.ts';
import { useComposerField } from './composerField.ts';
import type { TabKinds } from '@/core/tabs/slice.ts';
import { buildRegistry } from './registry.ts';
import { kindOf } from '../refs/kinds.ts';
import { CORE_COMMANDS, keysFor, withKey } from '../shell/keymap.ts';
import type { Plugin } from './plugin.ts';
import type { FeedKind, KeyId, ToolItem } from './registry.ts';

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
    'header.title': ['10 ProjectTitle', '20 HomeTitle'],
    'header.center': ['10 GitBranch'],
    'header.end': ['10 ConnNote', '20 UpdateNotice', '30 CompactPending', '40 RestartMenu', '50 ModelPill', '80 StopButton'],
    'header.menu': ['10 RemoteMenuRow'],
    'header.badge': ['10 RemoteDot'],
    'strip.left': ['5 ProjectsToggle', '10 FilesToggle', '20 VcsToggles'],
    'strip.right': ['10 CommentsToggle'],
    'tabs.chat': ['10 AgentTabs'],
    'panel.left': ['10 ProjectRail', '25 ProjectsPanel', '30 Tree', '40 ChangesPanel'],
    'panel.right': ['10 Comments'],
    chat: ['10 ChatFeed', '20 HighlightLayer'],
    panes: ['10 TasksDrawer'],
    footer: ['5 HomeFooter', '10 TasksIndicator', '20 Composer'],
    overlay: ['10 SelectionComment', '20 CommentCardPopover', '40 RecentFiles', '50 Starter', '60 Activity', '70 Seen', '75 AppIcon'],
    home: ['10 ProjectsHome'],
    // the composer's (issue 545); the pickers serve the comment popup's field as well
    'composer.status': ['10 CtxNudge'],
    'composer.tools': ['10 ModePill'],
    'composer.end': ['10 AgentAccount', '20 Meters', '30 CompactClear'],
    'composer.pickers': ['10 MentionPart', '20 ShortcodePart'],
  });
});

const cmd = (id: string, order: number, key: KeyId = 'hk_files'): Plugin => ({ id, commands: [{ id: key, codes: ['KeyF'], mods: { alt: true }, inFields: false, order, run: () => {} }] });

it('a command id two plugins declare fails the build, and so does one order taken twice', () => {
  expect(() => buildRegistry([cmd('a', 1), cmd('b', 2)])).toThrow('the command "hk_files" is declared twice');
  expect(() => buildRegistry([cmd('a', 1, 'hk_closeTab')], CORE_COMMANDS)).toThrow('the command "hk_closeTab" is declared twice'); // the core's own
  expect(() => buildRegistry([cmd('a', 1), cmd('b', 1, 'hk_wrap')])).toThrow('two commands at order 1');
});

// the order of the ? help and of matching: today's BINDINGS, the core's and the plugins' interleaved by `order`
it('the commands come in the help\'s order, core and plugins alike', () => {
  expect(buildRegistry(PLUGINS, CORE_COMMANDS).commands.map((c) => c.id)).toEqual([
    'hk_closeTab', 'hk_reopenTab', 'hk_prevTab', 'hk_nextTab', 'hk_tabN', 'hk_recent', 'hk_projects', 'hk_agentPrev', 'hk_agentNext', 'hk_promptHistory',
    'hk_promptOlder', 'hk_promptNewer', 'hk_files', 'hk_comments', 'hk_tasks', 'hk_voice', 'hk_wrap', 'hk_scaleUp',
    'hk_scaleDown', 'hk_scaleReset', 'hk_reveal', 'hk_composer',
  ]);
  expect(Object.isFrozen(buildRegistry(PLUGINS, CORE_COMMANDS).commands)).toBe(true);
});

it('every command\'s tooltip key resolves through withKey and keysFor, and every tooltip names a command', () => {
  const { commands } = buildRegistry(PLUGINS, CORE_COMMANDS);
  const ids = commands.map((c) => c.id);
  for (const id of ids) {
    expect(keysFor(commands, id), id).not.toBe('');
    expect(withKey(commands, 'X', id)).toBe(`X (${keysFor(commands, id)})`);
  }
  // a key no plugin of the store registers names nothing
  expect(keysFor(CORE_COMMANDS, 'hk_files')).toBe('');
  expect(withKey(CORE_COMMANDS, 'X', 'hk_files')).toBe('X');
  const src = path.resolve(import.meta.dirname, '../..');
  const named = fs.readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
    .flatMap((f) => [...fs.readFileSync(path.join(src, f), 'utf8').matchAll(/\b(?:withKey|keysFor)\([^\n]*?'(hk_\w+)'/g)].map((m) => m[1]));
  expect(named.length).toBeGreaterThan(5);
  expect(named.filter((id) => !ids.includes(id as never))).toEqual([]);
});

it('every kind of feed item but actions is drawn by one plugin, and a kind drawn twice fails the build', () => {
  const kinds: Record<FeedKind, true> = { user: true, assistant: true, done: true, permission: true, shell: true, marker: true, notice: true, overlap: true };
  expect([...buildRegistry(PLUGINS).feed.keys()].sort()).toEqual(Object.keys(kinds).sort());
  const notice = (id: string): Plugin => ({ id, feed: [{ kind: 'notice', render: () => null }] });
  expect(() => buildRegistry([notice('a'), notice('b')])).toThrow('the feed item kind "notice" is drawn twice');
});

it('a subagent\'s call is the one action a plugin draws itself', () => {
  const tool = (p: Partial<ToolItem>): ToolItem => ({ kind: 'tool', id: 't', name: 'Bash', arg: '', sub: false, input: {}, ...p });
  const { tools } = buildRegistry(PLUGINS);
  const drawn = (it: ToolItem) => tools.filter((r) => r.match(it)).map((r) => r.render.name);
  expect(drawn(tool({ name: 'Agent' }))).toEqual(['AgentCard']);
  expect(drawn(tool({ name: 'Task' }))).toEqual(['AgentCard']);
  expect(drawn(tool({ name: 'spawn', toolKind: 'agent' }))).toEqual(['AgentCard']);
  expect(drawn(tool({ name: 'Bash' }))).toEqual([]);
});

// today's order of a user message's body; two parts at one order fail the build
it('a user message\'s parts come in today\'s order', () => {
  expect(buildRegistry(PLUGINS).userParts.map((u) => `${u.order} ${u.id}`)).toEqual(['10 voice', '20 text', '30 images', '40 comments']);
  const part = (id: string): Plugin => ({ id, userParts: [{ id, order: 10, render: () => null }] });
  expect(() => buildRegistry([part('a'), part('b')])).toThrow('two user message parts at order 10');
});

it('a file view id two plugins declare fails the build', () => {
  const fv = (id: string): Plugin => ({ id, fileViews: [{ id: 'x', order: 10, media: true, match: () => true, render: () => null }] });
  expect(() => buildRegistry([fv('a'), fv('b')])).toThrow('the file view "x" is declared twice');
});

it('a file is shown by the first view that matches it: an edit, a page, a media file; any other as text', () => {
  const r = buildRegistry(PLUGINS);
  expect(r.fileViews.map((v) => `${v.order} ${v.id}`)).toEqual(['10 cut', '20 page', '30 media']);
  const of = (p: string) => r.fileViews.find((v) => v.match(p, kindOf(p)))?.id;
  expect(['e.nbcut.json', 'a.html', 'b.HTM', 'p.png', 'v.mp4', 's.mp3', 'n.md', 'x.ts'].map(of)).toEqual(['cut', 'page', 'page', 'media', 'media', 'media', undefined, undefined]);
});

it('an anchor kind two plugins show fails the build', () => {
  const av = (id: string): Plugin => ({ id, anchorViews: [{ kind: 'page', orphan: false }] });
  expect(() => buildRegistry([av('a'), av('b')])).toThrow('the anchor kind "page" is shown twice');
});

it('each kind of anchor is shown by its plugin, with what it adds to the comments\' own', () => {
  const parts = (v: object) => Object.keys(v).filter((k) => k !== 'kind').sort().join(' ');
  expect(Object.fromEntries([...buildRegistry(PLUGINS).anchorViews].map(([k, v]) => [k, parts(v)]))).toEqual({
    attachment: 'Card reveal', cut: 'Card orphan', media: 'Card composite orphan', page: 'orphan place',
  });
});

// Settings keeps its order of sections and Defaults rows though five plugins register them (issue 511, step 11)
it('the Settings sections and rows come in today\'s order; one id twice, or one order twice in a section, fails the build', () => {
  const r = buildRegistry(PLUGINS);
  expect(r.settings.filter((s) => !s.in).map((s) => s.id)).toEqual(['windows', 'storage', 'dictation', 'defaults', 'themes', 'about']);
  expect(r.settings.filter((s) => s.in === 'defaults').map((s) => s.id)).toEqual(['lang', 'scale', 'mode', 'updateCheck', 'updateAuto', 'audit', 'rail', 'sounds', 'shell']);
  const part = (id: string, order: number, at?: string): Plugin => ({ id, settings: [{ id: `${id}-part`, order, ...(at ? { in: at } : {}) }] });
  expect(() => buildRegistry([part('a', 1), { id: 'b', settings: [{ id: 'a-part', order: 2 }] }])).toThrow('the settings part "a-part" is declared twice');
  expect(() => buildRegistry([part('a', 1), part('b', 1)])).toThrow('two settings parts at order 1');
  expect(() => buildRegistry([part('a', 1, 'x'), part('b', 1, 'x')])).toThrow('two settings parts in "x" at order 1');
  expect(() => buildRegistry([part('a', 1), part('b', 1, 'x')])).not.toThrow();
});

it('the plugins\' resources are registered by id; a registered one needs an id, and one id twice fails the build', () => {
  expect([...buildRegistry(PLUGINS).resources.keys()].sort()).toEqual(['controls.info', 'cut.export', 'projects.list', 'projects.shortcut', 'settings.about', 'settings.storage', 'settings.windows', 'update.auto', 'update.status', 'usage.report', 'vcs.branches', 'vcs.commit', 'vcs.diff', 'vcs.log', 'vcs.patch', 'voice.dictation']);
  const res = (id: string | undefined) => ({ ...(id ? { id } : {}), key: () => '', route: () => '/x' });
  expect(() => buildRegistry([{ id: 'a', resources: [res(undefined)] }])).toThrow('a registered resource needs an id');
  expect(() => buildRegistry([{ id: 'a', resources: [res('r')] }, { id: 'b', resources: [res('r')] }])).toThrow('the resource "r" is declared twice');
});

// a send takes the composer's draft first, then the comments that ride along (issue 511, step 10d)
it('a send\'s parts come in today\'s order; one id or one order twice fails the build', () => {
  expect(buildRegistry(PLUGINS).sendParts.map((p) => `${p.order} ${p.id}`)).toEqual(['10 draft', '30 comments']);
  const sp = (id: string, order: number): Plugin => ({ id, sendParts: [{ id: 'x', order, take: () => null }] });
  expect(() => buildRegistry([sp('a', 1), sp('b', 2)])).toThrow('the send part "x" is declared twice');
  expect(() => buildRegistry([{ ...sp('a', 1), sendParts: [{ id: 'y', order: 1, take: () => null }] }, sp('b', 1)])).toThrow('two send parts at order 1');
});

// other plugins' views reach the comments through the SDK, never the comments plugin's modules (issue 545)
it('the comments\' service is provided by one plugin; a second fails the build; a view without one is told why', () => {
  const service = buildRegistry(PLUGINS).comments!;
  expect(Object.keys(service).sort()).toEqual(['CommentPopup', 'HighlightLayer', 'flashRange', 'flashRects', 'moveCutComment', 'openCommentCard',
    'removeComment', 'selectComments', 'selectMediaComments', 'selectPendingCountByPath']);
  const provides = (id: string): Plugin => ({ id, comments: service });
  expect(() => buildRegistry([provides('a'), provides('b')])).toThrow('two plugins provide the comments');
  const bare = makeStore({ url: 'u', connect: () => ({ send: () => true, close() {} }), plugins: [] });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(Provider, { store: bare, children });
  expect(() => renderHook(() => useService('comments'), { wrapper })).toThrow('no plugin provides the comments');
});

// the composer and the comment popup reach voice and attachments through the SDK (issue 545)
it('the voice and the attachments are each one plugin\'s service; a second fails the build; a host without one is told why', () => {
  const r = buildRegistry(PLUGINS);
  expect(Object.keys(r.voice!).sort()).toEqual(['ClipRow', 'RecordBar', 'WhisperPrompt', 'onRefused', 'send', 'transcribe', 'useRecorder']);
  expect(Object.keys(r.attachments!).sort()).toEqual(['Attachments', 'ComposerAttachments', 'useIntake']);
  expect(() => buildRegistry([{ id: 'a', voice: r.voice }, { id: 'b', voice: r.voice }])).toThrow('two plugins provide the voice');
  expect(() => buildRegistry([{ id: 'a', attachments: r.attachments }, { id: 'b', attachments: r.attachments }])).toThrow('two plugins provide the attachments');
  const bare = makeStore({ url: 'u', connect: () => ({ send: () => true, close() {} }), plugins: [] });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(Provider, { store: bare, children });
  expect(() => renderHook(() => useService('voice'), { wrapper })).toThrow('no plugin provides the voice');
  expect(() => renderHook(() => useService('attachments'), { wrapper })).toThrow('no plugin provides the attachments');
});

// other plugins' state and views are read through their owners' services, never their modules (issue 545)
it('the files, git, projects, feed, tasks, edits, media and composer services are each one plugin\'s, with only what the others read', () => {
  const r = buildRegistry(PLUGINS);
  const keys = (k: 'files' | 'vcs' | 'projects' | 'feedUi' | 'tasks' | 'cut' | 'media' | 'composer') => Object.keys(r[k]!).sort();
  expect(keys('files')).toEqual(['diskChanged', 'inTree', 'jumpToFileComment', 'pickSource', 'selectDiskSeq', 'selectFileLoad', 'selectFileVersion',
    'selectRefreshSeq', 'selectSource', 'selectTreeOpen', 'setTreeOpen']);
  expect(keys('vcs')).toEqual(['showCommit']);
  expect(keys('projects')).toEqual(['openFolder']);
  expect(keys('feedUi')).toEqual(['Feed', 'revealTool', 'selectFolds']);
  expect(keys('tasks')).toEqual(['CallMenu']);
  expect(keys('cut')).toEqual(['liveCutState']);
  expect(keys('media')).toEqual(['AttachmentMarkup', 'ChatPlayer']);
  expect(keys('composer')).toEqual(['field']);
  expect(() => buildRegistry([{ id: 'a', files: r.files }, { id: 'b', files: r.files }])).toThrow('two plugins provide the files');
  const bare = makeStore({ url: 'u', connect: () => ({ send: () => true, close() {} }), plugins: [] });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(Provider, { store: bare, children });
  expect(() => renderHook(() => useService('files'), { wrapper })).toThrow('no plugin provides the files');
});

// Markdown is core: the diagram plugin draws its code blocks, each language by one plugin (issue 545)
it('a fenced language is drawn by one plugin; a second fails the build', () => {
  const r = buildRegistry(PLUGINS);
  expect([...r.codeBlocks.keys()]).toEqual(['mermaid', 'svg']);
  const twice: Plugin = { id: 'b', codeBlocks: [r.codeBlocks.get('svg')!] };
  expect(() => buildRegistry([{ id: 'a', codeBlocks: [r.codeBlocks.get('svg')!] }, twice])).toThrow('the code block "svg" is drawn twice');
});

// the Files tree hosts the edits' menu items and drag (issue 545)
it('the tree\'s file rows take other plugins\' parts by order; an id or an order twice fails the build', () => {
  expect(buildRegistry(PLUGINS).treeActions.map((a) => `${a.order} ${a.id}`)).toEqual(['10 cut']);
  expect(() => buildRegistry([{ id: 'a', treeActions: [{ id: 'x', order: 1 }] }, { id: 'b', treeActions: [{ id: 'x', order: 2 }] }])).toThrow('the tree action "x" is declared twice');
  expect(() => buildRegistry([{ id: 'a', treeActions: [{ id: 'x', order: 1 }] }, { id: 'b', treeActions: [{ id: 'y', order: 1 }] }])).toThrow('two tree actions at order 1');
});

it('a picker outside a message field is told why', () => {
  expect(() => renderHook(() => useComposerField())).toThrow('outside a message field');
});
