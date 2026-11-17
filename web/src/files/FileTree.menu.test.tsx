import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TreeEntry } from '@nota-bene/shared';
import type { Cut } from '@nota-bene/shared/cut';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { setTreeOpen } from '@/tree/slice.ts';
import { selectTabs } from '@/tabs/slice.ts';
import { registerEditTarget, touchEditTarget } from '@/cut/targets.ts';
import { getToasts, resetToasts } from '@/shell/toast.ts';
import { FileTree } from './FileTree.tsx';

// the browser reads a source's length from its metadata; jsdom has no media
// (slow.mp4 waits for `gate`, to see a second New edit refused while the first one reads)
let gate: Promise<void> = Promise.resolve();
vi.mock('@/cut/durations.ts', () => ({
  srcLength: async (url: string) => (url.includes('slow') ? gate.then(() => 2) : url.includes('long') ? 12 : 3),
  srcSize: async (url: string) => (url.includes('a.mp4') ? { width: 1280, height: 720 } : null),
}));

// the page's own host: jsdom's is localhost; a test flips it to a page reached through a relay
const localPage = vi.hoisted(() => ({ on: true }));
vi.mock('@/net/local.ts', () => ({ isLocalPage: () => localPage.on }));

let fs: Record<string, TreeEntry[]>;
let posts: { url: string; body: unknown }[];
let undo: (() => void)[];
beforeEach(() => {
  localStorage.clear();
  setLang('en');
  posts = [];
  undo = [];
  fs = {
    '': [{ name: 'media', dir: true }, { name: 'notes.md', dir: false }],
    media: [{ name: 'a.mp4', dir: false }, { name: 'b.png', dir: false }, { name: 'long.wav', dir: false }, { name: 'readme.txt', dir: false }, { name: 'slow.mp4', dir: false }],
  };
  gate = Promise.resolve();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ path: 'media/edit.nbcut.json' }), { status: 201 });
    }
    const rel = decodeURIComponent(new URL(url, 'http://x').searchParams.get('path') ?? '');
    const list = fs[rel];
    return new Response(JSON.stringify(list ?? []), { status: list ? 200 : 404 });
  }));
});
afterEach(() => { for (const f of undo) f(); cleanup(); vi.unstubAllGlobals(); });

async function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  store.dispatch(setTreeOpen(true));
  render(<Provider store={store}><FileTree /></Provider>);
  fireEvent.click(await screen.findByRole('button', { name: /^media/ }));
  await screen.findByRole('button', { name: /^a\.mp4/ });
  return store;
}
const row = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name.replace(/\./g, '\\.')}`) });
const selected = () => [...document.querySelectorAll<HTMLElement>('[data-selected]')].map((e) => e.dataset.path);
const menu = (name: string) => { fireEvent.contextMenu(row(name)); return screen.getByRole('menu'); };

it('Cmd/Ctrl-click picks files one by one without opening them; Shift-click picks the run from the last one clicked; a click picks one and opens it', async () => {
  const store = await setup();
  fireEvent.click(row('long.wav'), { metaKey: true });
  fireEvent.click(row('a.mp4'), { ctrlKey: true });
  expect(selected()).toEqual(['media/a.mp4', 'media/long.wav']);
  expect(selectTabs(store.getState()).active).toBe('chat');
  fireEvent.click(row('a.mp4'), { metaKey: true }); // again: out
  expect(selected()).toEqual(['media/long.wav']);
  // the run from the last one clicked (a.mp4) to this one
  fireEvent.click(row('readme.txt'), { shiftKey: true });
  expect(selected()).toEqual(['media/a.mp4', 'media/b.png', 'media/long.wav', 'media/readme.txt']);
  fireEvent.click(row('b.png'), { shiftKey: true });
  expect(selected()).toEqual(['media/a.mp4', 'media/b.png']);
  fireEvent.click(row('b.png'));
  expect(selected()).toEqual(['media/b.png']);
  expect(selectTabs(store.getState()).active).toBe('file:media/b.png');
});

it('a media file\'s menu: Add to edit is off while no edit is open; it adds the picked media, in the order picked, to the most recent edit', async () => {
  await setup();
  let m = menu('a.mp4');
  expect(screen.getByRole('menuitem', { name: /open an edit/i })).toHaveAttribute('data-disabled');
  fireEvent.keyDown(m, { key: 'Escape' });
  const got: [string, readonly string[]][] = [];
  undo.push(registerEditTarget({ path: 'cuts/old.nbcut.json', add: (f) => void got.push(['old', f]) }));
  undo.push(registerEditTarget({ path: 'cuts/main.nbcut.json', add: (f) => void got.push(['main', f]) }));
  touchEditTarget('cuts/old.nbcut.json');
  fireEvent.click(row('long.wav'));
  fireEvent.click(row('readme.txt'), { metaKey: true });
  fireEvent.click(row('a.mp4'), { metaKey: true });
  m = menu('a.mp4');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add 2 files to old.nbcut.json' }));
  expect(got).toEqual([['old', ['media/long.wav', 'media/a.mp4']]]);
  expect(m).not.toBeInTheDocument();
});

it('a right-click outside the picked files picks that file alone; a file that is not media has no edit items', async () => {
  await setup();
  undo.push(registerEditTarget({ path: 'e.nbcut.json', add: () => {} }));
  fireEvent.click(row('a.mp4'), { metaKey: true });
  fireEvent.click(row('b.png'), { metaKey: true });
  menu('long.wav');
  expect(selected()).toEqual(['media/long.wav']);
  expect(screen.getByRole('menuitem', { name: 'Add to e.nbcut.json' })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  menu('readme.txt');
  expect(screen.queryByRole('menuitem', { name: /edit/i })).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeInTheDocument();
});

it('New edit from selection writes an edit of the picked media back to back beside them, then opens it', async () => {
  const store = await setup();
  fireEvent.click(row('b.png'), { metaKey: true });
  fireEvent.click(row('a.mp4'), { metaKey: true });
  fireEvent.click(row('long.wav'), { metaKey: true });
  menu('a.mp4');
  fireEvent.click(screen.getByRole('menuitem', { name: 'New edit from 3 files' }));
  await waitFor(() => expect(selectTabs(store.getState()).active).toBe('file:media/edit.nbcut.json'));
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe('/cut/new');
  const { dir, cut } = posts[0]!.body as { dir: string; cut: Cut };
  expect(dir).toBe('media');
  // the frame of the first video that has one
  expect([cut.width, cut.height, cut.fps]).toEqual([1280, 720, 30]);
  expect(cut.clips.map((c) => [c.src, c.at, c.dur ?? c.out])).toEqual([['media/b.png', 0, 5], ['media/a.mp4', 5, 3], ['media/long.wav', 0, 12]]);
});

it('two open edits of the same name are told apart by their paths in the menu', async () => {
  await setup();
  undo.push(registerEditTarget({ path: 'one/edit.nbcut.json', add: () => {} }));
  undo.push(registerEditTarget({ path: 'two/edit.nbcut.json', add: () => {} }));
  touchEditTarget('two/edit.nbcut.json');
  menu('a.mp4');
  expect(screen.getByRole('menuitem', { name: 'Add to two/edit.nbcut.json' })).toBeInTheDocument();
});

it('New edit runs once at a time: while it reads the lengths the item says so and is off', async () => {
  let open!: () => void;
  gate = new Promise<void>((r) => { open = r; });
  const store = await setup();
  menu('slow.mp4');
  fireEvent.click(screen.getByRole('menuitem', { name: 'New edit from this file' }));
  menu('slow.mp4');
  const busy = screen.getByRole('menuitem', { name: 'Creating the edit…' });
  expect(busy).toHaveAttribute('data-disabled');
  fireEvent.click(busy);
  open();
  await waitFor(() => expect(selectTabs(store.getState()).active).toBe('file:media/edit.nbcut.json'));
  expect(posts).toHaveLength(1);
});

it('a long press (touch) opens the menu of the row pressed', async () => {
  await setup();
  undo.push(registerEditTarget({ path: 'e.nbcut.json', add: () => {} }));
  fireEvent.click(row('a.mp4'));
  fireEvent.pointerDown(row('long.wav'), { pointerType: 'touch', button: 0, pointerId: 1 });
  await screen.findByRole('menu', {}, { timeout: 2000 });
  expect(selected()).toEqual(['media/long.wav']);
  expect(screen.getByRole('menuitem', { name: 'Add to e.nbcut.json' })).toBeInTheDocument();
});

it('the selection lets go of files the filter hides or that are gone', async () => {
  await setup();
  fireEvent.click(row('a.mp4'));
  fireEvent.click(row('b.png'), { metaKey: true });
  fireEvent.click(row('long.wav'), { metaKey: true });
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '.wav' } });
  await waitFor(() => expect(selected()).toEqual(['media/long.wav']));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  expect(selected()).toEqual(['media/long.wav']);
});

// issue 461: Download everywhere; Show in Finder and Open only on the computer the window runs on
const platformWas = navigator.platform;
const onPlatform = (p: string) => {
  Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
  undo.push(() => Object.defineProperty(navigator, 'platform', { value: platformWas, configurable: true }));
};

it('Show in Finder and Open post the row to the server; a refused Open says why', async () => {
  resetToasts();
  onPlatform('MacIntel');
  await setup();
  const answers: Record<string, Response> = { '/os/open': new Response(JSON.stringify({ error: 'refused' }), { status: 403 }) };
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.startsWith('/os/')) {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return answers[url] ?? new Response('{"ok":true}', { status: 200 });
    }
    return base(url, init);
  }));
  menu('readme.txt');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show in Finder' }));
  await waitFor(() => expect(posts).toEqual([{ url: '/os/reveal', body: { path: 'media/readme.txt' } }]));
  menu('readme.txt');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open in default app' }));
  await waitFor(() => expect(getToasts().at(-1)).toMatchObject({ title: 'Could not open readme.txt', msg: expect.stringMatching(/^Programs and scripts are not opened from here/) }));
  expect(posts[1]).toEqual({ url: '/os/open', body: { path: 'media/readme.txt' } });
});

it.each([
  [404, 'not found', 'The file is no longer there'],
  [403, 'local-only', 'Only the window on the computer it runs on can do this'],
  [403, 'outside project', 'The file is outside the project'],
  [500, 'EACCES: boom', 'It did not work; try again'],
])('a refused Show in Finder says why in words, never the raw code (%s %s)', async (status, error, msg) => {
  resetToasts();
  onPlatform('MacIntel');
  await setup();
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
    (url === '/os/reveal' ? new Response(JSON.stringify({ error }), { status }) : base(url, init))));
  menu('readme.txt');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show in Finder' }));
  await waitFor(() => expect(getToasts().at(-1)).toMatchObject({ title: 'Could not open readme.txt', msg }));
});

it.each([['Win32', 'Show in Explorer'], ['Linux x86_64', 'Open containing folder']])('the reveal item is named for the system: %s', async (platform, name) => {
  onPlatform(platform);
  await setup();
  menu('readme.txt');
  expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
});

it('Download saves each picked file through /file (cookie only: no token or key in the link)', async () => {
  await setup();
  const links: { href: string; download: string }[] = [];
  const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    links.push({ href: this.getAttribute('href')!, download: this.download });
  });
  undo.push(() => spy.mockRestore());
  fireEvent.click(row('readme.txt'), { metaKey: true });
  fireEvent.click(row('b.png'), { metaKey: true });
  menu('b.png');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }));
  expect(links).toEqual([
    { href: '/file?path=media%2Freadme.txt&download=1', download: 'readme.txt' },
    { href: '/file?path=media%2Fb.png&download=1', download: 'b.png' },
  ]);
  expect(document.querySelectorAll('a[download]')).toHaveLength(0); // each link is gone again
});

it('a page not on this computer (through a relay) has Download but no Show in Finder or Open', async () => {
  localPage.on = false;
  undo.push(() => void (localPage.on = true));
  onPlatform('MacIntel');
  await setup();
  menu('readme.txt');
  expect(screen.getByRole('menuitem', { name: 'Download' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Show in Finder' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Open in default app' })).toBeNull();
});
