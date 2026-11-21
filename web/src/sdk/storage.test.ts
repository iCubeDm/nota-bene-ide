import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { stubRoutes, testStore } from '@/testing';
import { readSavedTabs, tabsKey } from '@/tabs/slice.ts';
import { readSavedDirs, treeKey } from '@/files/treeSlice.ts';
import { readRecent, recentKey } from '@/files/recent.ts';
import { expectedCompactMs } from '@/feed/compactTiming.ts';
import { wrapLines } from '@/files/wrap.ts';
import { seekStep } from '@/store/seekStep.ts';
import { hasDraft } from '@/files/view/FileEditor.tsx';
import { theme } from '@/shell/theme.ts';
import { uiScale } from '@/shell/uiScale.ts';
import { railPref } from '@/projects/railPref.ts';
import { getLang, resetUnsyncedLang, setLang } from '@/i18n/index.ts';
import { flag } from './flags.ts';
import { bool, json, oneOf, storage, string, useStored } from './storage.ts';

let stub: ReturnType<typeof stubRoutes> | null = null;
beforeEach(() => {
  localStorage.clear();
  theme.reload();
  uiScale.reload();
  railPref.reload();
  resetUnsyncedLang();
});
afterEach(() => {
  stub?.restore();
  stub = null;
  vi.restoreAllMocks();
  localStorage.clear();
  theme.reload();
  uiScale.reload();
  resetUnsyncedLang();
  setLang('en');
});

const tick = () => new Promise((r) => setTimeout(r, 0));

it('reads every key family as the code before issue 511 wrote it', () => {
  // the raw values below are what the earlier modules wrote, byte for byte
  localStorage.setItem('lang', 'ru');
  localStorage.setItem('nb.theme', 'github-light');
  localStorage.setItem('nb.uiScale', '1.25');
  localStorage.setItem('nb.projectRail', '0');
  theme.reload();
  uiScale.reload();
  railPref.reload();
  resetUnsyncedLang();
  expect([getLang(), theme.get(), uiScale.get(), railPref.get()]).toEqual(['ru', 'github-light', 1.25, false]);

  localStorage.setItem('nb.wrap', '0');
  localStorage.setItem('nb.seekStep', '0.5');
  localStorage.setItem('nb.compactMs', '[1000,3000,2000]');
  localStorage.setItem(tabsKey('/p'), JSON.stringify({ tabs: [{ file: { path: 'a.md' } }], active: 'file:a.md' }));
  localStorage.setItem(treeKey('/p'), '["src"]');
  localStorage.setItem(treeKey('/p', 'wt'), '["lib"]');
  localStorage.setItem(recentKey('/p'), '[{"path":"b.md"}]');
  localStorage.setItem('nb.edit.c.md', '{"text":"x","base":null}');
  expect(wrapLines.get()).toBe(false);
  expect(seekStep.get()).toBe(0.5);
  expect(expectedCompactMs()).toBe(2000);
  expect(readSavedTabs('/p')).toEqual({ tabs: [{ file: { path: 'a.md' } }], active: 'file:a.md' });
  expect([readSavedDirs('/p'), readSavedDirs('/p', 'wt')]).toEqual([['src'], ['lib']]);
  expect(readRecent('/p')).toEqual([{ path: 'b.md' }]);
  expect([hasDraft('c.md'), hasDraft('d.md')]).toEqual([true, false]);
});

it('writes the same bytes the earlier code wrote', () => {
  storage.local('k.bool', bool, false).set(true);
  storage.local('k.str', string, '').set('v1');
  storage.local('k.num', oneOf([0.1, 5] as const), 5).set(0.1);
  storage.local('k.json', json<string[]>(), []).set(['a', 'b']);
  expect(['k.bool', 'k.str', 'k.num', 'k.json'].map((k) => localStorage.getItem(k))).toEqual(['1', 'v1', '0.1', '["a","b"]']);
  wrapLines.set(false);
  seekStep.set(1);
  expect([localStorage.getItem('nb.wrap'), localStorage.getItem('nb.seekStep')]).toEqual(['0', '1']);
});

it('a local item: unknown values fall back, an unchanged value keeps its object, subscribers hear a set, remove forgets', () => {
  const item = storage.local('k.list', json((v): v is string[] => Array.isArray(v)), ['none']);
  localStorage.setItem('k.list', '{"not":"a list"}');
  expect(item.get()).toEqual(['none']);
  localStorage.setItem('k.list', '["x"]');
  expect(item.get()).toBe(item.get());
  const { result } = renderHook(() => useStored(item));
  expect(result.current).toEqual(['x']);
  act(() => item.set(['y']));
  expect(result.current).toEqual(['y']);
  act(() => item.remove());
  expect(localStorage.getItem('k.list')).toBeNull();
  expect(result.current).toEqual(['none']);
});

// issue 545: before, another tab's write showed only at this tab's next unrelated render
it('another tab\'s write re-renders at once: its key\'s listeners, and every key\'s on a clear', () => {
  const a = storage.local('k.tabA', string, 'a0');
  const b = storage.local('k.tabB', string, 'b0');
  const ra = renderHook(() => useStored(a));
  const rb = renderHook(() => useStored(b));
  const fromOtherTab = (key: string | null, value: string | null) => act(() => {
    if (key === null) localStorage.clear();
    else if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
  });
  fromOtherTab('k.tabA', 'a1');
  expect([ra.result.current, rb.result.current]).toEqual(['a1', 'b0']);
  fromOtherTab('k.tabB', 'b1');
  expect([ra.result.current, rb.result.current]).toEqual(['a1', 'b1']);
  fromOtherTab(null, null);
  expect([ra.result.current, rb.result.current]).toEqual(['a0', 'b0']);
});

it('storage unavailable: reads fall back, a set holds for the page', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  const item = storage.local('k.off', bool, true);
  expect(item.get()).toBe(true);
  item.set(false);
  expect(item.get()).toBe(false);
  expect(flag('demo' as never)).toBe(false); // a flag nobody stored reads as off
});

it('storage full (a set throws, reads work): the set reads back for the page', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  localStorage.removeItem('nb.wrap');
  wrapLines.set(false);
  expect(wrapLines.get()).toBe(false);
  vi.mocked(Storage.prototype.setItem).mockRestore();
  wrapLines.set(true); // a later write that succeeds is what reads see again
  expect([wrapLines.get(), localStorage.getItem('nb.wrap')]).toEqual([true, '1']);
});

it('a flag reads nb.flag.<name>', () => {
  localStorage.setItem('nb.flag.demo', '1');
  expect(flag('demo' as never)).toBe(true);
});

it('pref sets go through the connection one at a time and the last one wins', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const posted: unknown[] = [];
  stub = stubRoutes({ '/system/prefs': async (req) => { posted.push(await req.json()); await gate; return Response.json({}); } });
  const pref = storage.pref('theme');
  void pref.set('plannotator');
  void pref.set('github-light');
  void pref.set('solarized-dark');
  await tick();
  expect(posted).toEqual([{ theme: 'plannotator' }]);
  expect(pref.get()).toBe('solarized-dark');
  release();
  await vi.waitFor(() => expect(posted).toEqual([{ theme: 'plannotator' }, { theme: 'solarized-dark' }]));
  expect(localStorage.getItem('nb.theme')).toBe('solarized-dark');
});

it('a hello adopts its prefs in one place; a pending local choice is not undone by an older one', () => {
  stub = stubRoutes({ '/system/prefs': () => new Promise<Response>(() => {}) }); // the POST never answers
  const { conn } = testStore({ hello: { theme: 'github-light', uiScale: 1.1, lang: 'de' } });
  expect([theme.get(), uiScale.get(), getLang()]).toEqual(['github-light', 1.1, 'de']);
  theme.choose('darcula');
  conn.emit({ kind: 'hello', protocol: 1, theme: 'github-light', lang: 'de' } as never);
  expect(theme.get()).toBe('darcula');
});

it('a hello resend waits its turn like a choice: the server and the unconfirmed value end on the newer choice', async () => {
  const answers: ((r: Response) => void)[] = [];
  const posted: unknown[] = [];
  stub = stubRoutes({ '/system/prefs': async (req) => { posted.push((await req.json() as { theme: string }).theme); return new Promise<Response>((res) => answers.push(res)); } });
  const pref = storage.pref('theme');
  void pref.set('plannotator');
  await vi.waitFor(() => expect(posted).toEqual(['plannotator']));
  answers.shift()!(new Response('down', { status: 503 })); // not confirmed
  await tick();
  pref.adopt('darcula'); // a hello: the unconfirmed choice is sent again
  await vi.waitFor(() => expect(posted).toEqual(['plannotator', 'plannotator']));
  void pref.set('github-light'); // a newer choice while the resend is in flight: it waits
  await tick();
  expect(posted).toHaveLength(2);
  answers.shift()!(Response.json({})); // the resend lands: it does not confirm the newer choice
  await vi.waitFor(() => expect(posted).toEqual(['plannotator', 'plannotator', 'github-light']));
  answers.shift()!(new Response('down', { status: 503 })); // and the newer one fails
  await tick();
  pref.adopt('plannotator'); // so the next hello neither undoes it nor forgets it
  expect(pref.get()).toBe('github-light');
  await vi.waitFor(() => expect(posted.at(-1)).toBe('github-light'));
});
