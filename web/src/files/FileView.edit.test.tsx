import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { FileView } from './FileView.tsx';

let disk: string;
let version: number;
let posts: { path: string; text: string; base: string | null }[];
let refuse: { status: number; body?: object } | null;
beforeEach(() => {
  localStorage.clear();
  setLang('en');
  disk = 'hello\r\nworld';
  version = 1;
  posts = [];
  refuse = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/edit')) {
      if (method === 'GET') return Response.json({ text: disk, base: `v${version}` });
      const body = JSON.parse(String(init!.body)) as (typeof posts)[number];
      posts.push(body);
      if (refuse) return Response.json(refuse.body ?? {}, { status: refuse.status });
      if (body.base !== null && body.base !== `v${version}`) return Response.json({ error: 'changed' }, { status: 409 });
      disk = body.text;
      version++;
      return Response.json({ base: `v${version}` });
    }
    const size = new TextEncoder().encode(disk).length;
    if (method === 'HEAD') return new Response(null, { headers: { 'content-length': String(size) } });
    return new Response(disk);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(o: { path?: string; src?: string } = {}) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  return render(<Provider store={store}><TooltipProvider><FileView path={o.path ?? 'a.txt'} active {...(o.src ? { src: o.src, refName: 'other' } : {})} /></TooltipProvider></Provider>);
}
const open = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  return await screen.findByRole('textbox', { name: 'a.txt' }) as HTMLTextAreaElement;
};
const type = (box: HTMLTextAreaElement, value: string) => fireEvent.change(box, { target: { value } });

it('edits, saves with the version it started from, and shows the saved text', async () => {
  setup();
  const box = await open();
  expect(box.value).toBe('hello\nworld');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  type(box, 'hello there');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(posts).toEqual([{ path: 'a.txt', text: 'hello there', base: 'v1' }]));
  await screen.findByText('hello there');
  expect(screen.queryByRole('textbox', { name: 'a.txt' })).toBeNull();
  expect(localStorage.getItem('nb.edit.a.txt')).toBeNull();
});

it('Alt+S and Cmd+S save', async () => {
  setup();
  const box = await open();
  type(box, 'one');
  fireEvent.keyDown(box, { code: 'KeyS', altKey: true });
  await waitFor(() => expect(posts).toHaveLength(1));
  const again = await open();
  type(again, 'two');
  fireEvent.keyDown(again, { code: 'KeyS', metaKey: true });
  await waitFor(() => expect(posts).toHaveLength(2));
});

it('a change on disk is not overwritten: it asks, and the typed text stays until it is answered', async () => {
  setup();
  const box = await open();
  type(box, 'mine');
  disk = 'the agent wrote this';
  version++;
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect((await screen.findByRole('alert')).textContent).toContain('The file changed on disk');
  expect(disk).toBe('the agent wrote this');
  expect(box.value).toBe('mine');
  fireEvent.click(screen.getByRole('button', { name: 'Overwrite it' }));
  await waitFor(() => expect(disk).toBe('mine'));
  expect(posts.at(-1)!.base).toBeNull();
});

it('or it takes the version on disk', async () => {
  setup();
  const box = await open();
  type(box, 'mine');
  disk = 'theirs';
  version++;
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Take the version on disk' }));
  await waitFor(() => expect(box.value).toBe('theirs'));
  expect(localStorage.getItem('nb.edit.a.txt')).toBeNull();
});

it('unsaved text survives a closed tab, with the version it started from', async () => {
  const first = setup();
  type(await open(), 'draft');
  first.unmount();
  setup();
  const box = await screen.findByRole('textbox', { name: 'a.txt' }) as HTMLTextAreaElement;
  expect(box.value).toBe('draft');
  disk = 'theirs';
  version++;
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('alert');
  expect(disk).toBe('theirs');
});

it('cancel asks only when there is something to lose', async () => {
  setup();
  const box = await open();
  type(box, 'mine');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(box.value).toBe('mine');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(screen.queryByRole('textbox', { name: 'a.txt' })).toBeNull();
  expect(localStorage.getItem('nb.edit.a.txt')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('textbox', { name: 'a.txt' })).toBeNull();
});

it('a refused save says why and keeps the text', async () => {
  refuse = { status: 403, body: { error: 'read-only' } };
  setup();
  const box = await open();
  type(box, 'mine');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect((await screen.findByRole('alert')).textContent).toBe('This file is read-only.');
  expect(box.value).toBe('mine');
});

it('Tab indents like the file does', async () => {
  disk = 'a\n\tb';
  setup();
  const box = await open();
  box.setSelectionRange(1, 1);
  fireEvent.keyDown(box, { key: 'Tab' });
  await waitFor(() => expect(box.value).toBe('a\t\n\tb'));
});

it('another source and a binary file have no edit button', async () => {
  setup({ src: 'branch:x' });
  await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  cleanup();
  setup({ path: 'a.png' });
  await waitFor(() => expect(screen.getByText('a.png')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});
