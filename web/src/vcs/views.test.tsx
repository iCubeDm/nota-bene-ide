import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent, VcsDiff } from '@nota-bene/shared';
import { selectComments } from '@/comments/slice.ts';
import { setSources, resetSources } from '@/files/sources.ts';
import { jumpToFileComment } from '@/files/slice.ts';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { openChanges, openLog, selectTabs } from '@/tabs/slice.ts';
import { pickSource } from '@/tree/slice.ts';
import { ChangesPanel } from './ChangesPanel.tsx';
import { ChangesView } from './ChangesView.tsx';
import { LogView } from './LogView.tsx';
import { baseOf, resetVcs, setPanel } from './store.ts';

const repo = (over: Partial<Extract<VcsDiff, { repo: true }>> = {}): VcsDiff => ({
  repo: true, branch: 'agent/one', live: true, base: null, detected: 'main', how: 'none', uncommitted: true, unrelated: false, mergeBase: null,
  commits: [], candidates: ['main', 'feature/parent'], truncated: false,
  files: [{ path: 'новый файл.md', status: 'A', add: null, del: null, binary: false }, { path: 'src/b.ts', old: 'src/a.ts', status: 'R', add: 1, del: 1, binary: false }],
  ...over,
});
const PATCH = 'diff --git "a/\\320\\275" "b/\\320\\275"\n--- /dev/null\n+++ "b/\\320\\275"\n@@ -0,0 +1 @@\n+hello\n';
let diff: VcsDiff;
let status: number;
let urls: string[];
beforeEach(() => {
  localStorage.clear();
  setLang('en');
  resetVcs();
  resetSources();
  diff = repo();
  status = 200;
  urls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url.startsWith('/vcs-diff')) return new Response(JSON.stringify(diff), { status });
    if (url.startsWith('/vcs-file')) return new Response(JSON.stringify({ patch: PATCH, truncated: false }));
    if (url.startsWith('/vcs-log')) return new Response(JSON.stringify({ repo: true, tip: 'a'.repeat(40), more: true, commits: [{ sha: 'a'.repeat(40), parents: [], author: 'me', at: 1, subject: 'first', refs: ['HEAD -> main'] }] }));
    if (url.startsWith('/vcs-commit-file')) return new Response(JSON.stringify({ patch: PATCH, truncated: false }));
    if (url.startsWith('/vcs-commit')) return new Response(JSON.stringify({ sha: 'a'.repeat(40), author: 'me', at: 1, message: 'first', truncated: false, files: [{ path: 'x.md', status: 'M', add: 1, del: 0, binary: false }] }));
    return new Response('[]');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(ui: React.ReactNode) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  act(() => void store.dispatch(serverEvent({ kind: 'session', id: null, root: '/p/main', title: null, model: null } as ServerEvent)));
  render(<Provider store={store}>{ui}</Provider>);
  return store;
}

it('shows one file, named by the list row even when the patch quotes it, and asks only for that file', async () => {
  setup(<ChangesView active />);
  const body = await screen.findByText('hello');
  expect(body.closest('[data-file-path]')).toHaveAttribute('data-file-path', 'новый файл.md');
  expect(urls.filter((u) => u.startsWith('/vcs-file'))).toHaveLength(1);
  expect(screen.getByText('1 of 2')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next file' }));
  await waitFor(() => expect(urls.some((u) => u.includes('old=src%2Fa.ts'))).toBe(true));
});

it('says there are no changes only when git said so; a failure keeps the last list', async () => {
  diff = repo({ files: [] });
  setup(<ChangesView active />);
  await screen.findByText('No changes');
  cleanup();
  resetVcs();
  status = 503;
  setup(<ChangesView active />);
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('Git did not answer');
  expect(screen.queryByText('No changes')).toBeNull();
});

it('says when a base shares no history', async () => {
  diff = repo({ base: 'main', uncommitted: false, unrelated: true, files: [] });
  setup(<ChangesView active />);
  expect(await screen.findByRole('alert')).toHaveTextContent('This branch shares no history with main');
});

it('the selector defaults to uncommitted, offers the whole branch, and remembers per project and source', async () => {
  const store = setup(<ChangesPanel />);
  act(() => setPanel(true));
  const sel = await screen.findByRole('combobox', { name: 'What to compare' }) as HTMLSelectElement;
  expect([...sel.options].map((o) => o.text)).toEqual(['Uncommitted', 'Whole branch from main', 'Whole branch from main', 'Whole branch from feature/parent']);
  expect(sel.value).toBe('');
  fireEvent.change(sel, { target: { value: 'BASE' } });
  await waitFor(() => expect(urls.some((u) => u.includes('base=BASE'))).toBe(true));
  expect(baseOf(JSON.parse(localStorage.getItem('vcs:bases')!) as Record<string, string>, '/p/main', 'here')).toBe('BASE');
  act(() => void store.dispatch(pickSource('ref:old')));
  await waitFor(() => expect(urls.some((u) => u.includes('src=ref%3Aold') && !u.includes('base='))).toBe(true));
});

it('a branch without a folder starts from the whole branch', async () => {
  diff = repo({ live: false, uncommitted: false, base: 'main' });
  setup(<ChangesPanel />);
  act(() => setPanel(true));
  const sel = await screen.findByRole('combobox', { name: 'What to compare' }) as HTMLSelectElement;
  expect(sel.options[0]!.text).toBe('Whole branch from main');
});

it('the list of another project is not shown under this one', async () => {
  const store = setup(<ChangesView active />);
  await screen.findByText('hello');
  diff = repo({ files: [] });
  act(() => void store.dispatch(serverEvent({ kind: 'session', id: null, root: '/p/other', title: null, model: null } as ServerEvent)));
  await screen.findByText('No changes');
  expect(urls.at(-1)).toContain('/vcs-');
});

it('a comment made on a commit opens that commit and file in the log', async () => {
  setSources([{ id: 'here', kind: 'checkout', label: 'main', ref: 'main' }]);
  const store = setup(<LogView active />);
  await screen.findByText('first');
  expect(screen.getByText('The latest 1 commits are shown')).toBeInTheDocument();
  act(() => void store.dispatch(jumpToFileComment('x.md', 'c1', 'aaaaaaa')));
  expect(selectTabs(store.getState()).active).toBe('log');
  await screen.findByText('hello');
  expect(urls).toContain('/vcs-commit?sha=aaaaaaa');
  expect(urls.some((u) => u.startsWith('/vcs-commit-file') && u.includes('path=x.md'))).toBe(true);
  expect(selectComments(store.getState())).toEqual([]);
});

it('a ref that is a branch stays a branch, whatever it looks like', () => {
  setSources([{ id: 'here', kind: 'checkout', label: 'main', ref: 'main' }, { id: 'ref:abcdef0', kind: 'branch', label: 'abcdef0', ref: 'abcdef0' }]);
  const store = setup(<div />);
  act(() => void store.dispatch(jumpToFileComment('x.md', 'c1', 'abcdef0')));
  expect(selectTabs(store.getState()).active).toBe('file:ref:abcdef0:x.md');
  act(() => { store.dispatch(openChanges()); store.dispatch(openLog()); });
  expect(selectTabs(store.getState()).open.map((t) => t.id)).toEqual(expect.arrayContaining(['changes', 'log']));
});
