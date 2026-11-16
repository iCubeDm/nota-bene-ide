import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Cut } from '@nota-bene/shared/cut';
import { moveClip } from './ops.ts';
import { SAVE_DELAY, serialize, useCutDoc } from './useCutDoc.ts';

const cut0: Cut = {
  version: 1, width: 640, height: 360, fps: 25,
  tracks: [{ id: 'v1', kind: 'video' }],
  clips: [{ id: 'c1', track: 'v1', src: 'a.mp4', at: 0, out: 3 }],
};
// the file on disk and its version, as the server's /edit keeps them
let disk: { text: string; base: string };
let posts: { text: string; base: string | null }[];
let ver: number;
const write = (text: string) => void (disk = { text, base: `b${++ver}` });
beforeEach(() => {
  ver = 0;
  write(JSON.stringify(cut0));
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.startsWith('/edit')) return new Response(null, { status: 404 });
    if (init?.method !== 'POST') return Response.json(disk);
    const b = JSON.parse(init.body as string) as { text: string; base: string | null };
    posts.push(b);
    if (b.base !== null && b.base !== disk.base) return Response.json({ error: 'changed' }, { status: 409 });
    write(b.text);
    return Response.json({ base: disk.base });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const open = () => renderHook(({ text }) => useCutDoc({ text, path: 'e.nbcut.json' }), { initialProps: { text: disk.text } });
const later = (c: Cut, at: number) => moveClip(c, 'c1', at);

it('is editable once the file version is known; an edit is saved after a pause, the file is the edit', async () => {
  const { result } = open();
  await waitFor(() => expect(result.current.cut).not.toBeNull());
  expect(result.current.status).toBe('saved');
  act(() => result.current.apply(later(result.current.cut!, 1)));
  expect(result.current.status).toBe('unsaved');
  await waitFor(() => expect(result.current.status).toBe('saved'), { timeout: SAVE_DELAY + 1000 });
  expect(posts).toHaveLength(1);
  expect(posts[0]!.base).toBe('b1');
  expect(JSON.parse(disk.text).clips[0].at).toBe(1);
  expect(disk.text).toBe(serialize(result.current.cut!));
});

it('undo and redo go through the edits and save too', async () => {
  const { result } = open();
  await waitFor(() => expect(result.current.cut).not.toBeNull());
  act(() => result.current.apply(later(result.current.cut!, 1)));
  act(() => result.current.apply(later(result.current.cut!, 2)));
  expect(result.current.canUndo).toBe(true);
  act(() => result.current.undo());
  expect(result.current.cut!.clips[0]!.at).toBe(1);
  act(() => result.current.undo());
  expect(result.current.cut!.clips[0]!.at).toBe(0);
  expect(result.current.canUndo).toBe(false);
  // back where the file is: nothing to save
  expect(result.current.status).toBe('saved');
  act(() => result.current.redo());
  expect(result.current.cut!.clips[0]!.at).toBe(1);
  await waitFor(() => expect(JSON.parse(disk.text).clips[0].at).toBe(1), { timeout: SAVE_DELAY + 1000 });
});

it('an outside change with nothing unsaved reloads the edit', async () => {
  const { result, rerender } = open();
  await waitFor(() => expect(result.current.cut).not.toBeNull());
  write(JSON.stringify(later(cut0, 5)));
  rerender({ text: disk.text }); // the file view read it again (after a turn)
  await waitFor(() => expect(result.current.cut!.clips[0]!.at).toBe(5));
  expect(result.current.status).toBe('saved');
  expect(result.current.canUndo).toBe(false);
  // and the next edit saves over that version
  act(() => result.current.apply(later(result.current.cut!, 6)));
  await waitFor(() => expect(JSON.parse(disk.text).clips[0].at).toBe(6), { timeout: SAVE_DELAY + 1000 });
  expect(posts.at(-1)!.base).toBe('b2');
});

it('an outside change reports what it changed in the clips (issue 412); the first read and our own saves do not', async () => {
  const { result, rerender } = open();
  await waitFor(() => expect(result.current.cut).not.toBeNull());
  expect(result.current.changes).toBeNull();
  // our own edit, saved and read back by the file view: no change from outside
  act(() => result.current.apply(later(result.current.cut!, 1)));
  await waitFor(() => expect(result.current.status).toBe('saved'), { timeout: SAVE_DELAY + 1000 });
  rerender({ text: disk.text });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(result.current.changes).toBeNull();
  // the agent moves c1 and adds c2
  const next = later(cut0, 5);
  write(JSON.stringify({ ...next, clips: [...next.clips, { id: 'c2', track: 'v1', src: 'b.mp4', at: 8, out: 1 }] }));
  rerender({ text: disk.text });
  await waitFor(() => expect(result.current.changes).not.toBeNull());
  const first = result.current.changes!;
  expect(first.added).toEqual(['c2']);
  expect(first.changed).toEqual(['c1']);
  expect(first.removed).toEqual([]);
  // the next one is a new report, even if it looks the same
  write(JSON.stringify(cut0));
  rerender({ text: disk.text });
  await waitFor(() => expect(result.current.changes).not.toBe(first));
  expect(result.current.changes!.removed.map((c) => c.id)).toEqual(['c2']);
  expect(result.current.changes!.changed).toEqual(['c1']);
});

it('an edit against an older file asks: nothing is overwritten until the user says so', async () => {
  const { result } = open();
  await waitFor(() => expect(result.current.cut).not.toBeNull());
  write(JSON.stringify(later(cut0, 5))); // the agent wrote it; the view has not reloaded yet
  act(() => result.current.apply(later(result.current.cut!, 1)));
  await waitFor(() => expect(result.current.status).toBe('conflict'), { timeout: SAVE_DELAY + 1000 });
  expect(JSON.parse(disk.text).clips[0].at).toBe(5);
  await act(() => result.current.overwrite());
  expect(JSON.parse(disk.text).clips[0].at).toBe(1);
  expect(result.current.status).toBe('saved');
});

it('the version on disk can be taken instead', async () => {
  const { result, rerender } = open();
  await waitFor(() => expect(result.current.cut).not.toBeNull());
  act(() => result.current.apply(later(result.current.cut!, 1)));
  write(JSON.stringify(later(cut0, 5)));
  rerender({ text: disk.text }); // a reload while the edit is not saved yet: it asks, it does not drop the edit
  await waitFor(() => expect(result.current.status).toBe('conflict'));
  expect(result.current.cut!.clips[0]!.at).toBe(1);
  await act(() => result.current.takeDisk());
  expect(result.current.cut!.clips[0]!.at).toBe(5);
  expect(result.current.status).toBe('saved');
  expect(JSON.parse(disk.text).clips[0].at).toBe(5);
});

it('without the file version (another source, an old server) the edit is not editable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  const { result } = open();
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(result.current.cut).toBeNull();
  const none = renderHook(() => useCutDoc({ text: disk.text, path: undefined }));
  expect(none.result.current.cut).toBeNull();
});

it('a file with CRLF line ends: the server keeps them, and the next read is no outside change', async () => {
  // as the server's withLineEnds: a file mostly CRLF is written CRLF
  write(serialize(cut0).replace(/\n/g, '\r\n'));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json(disk);
    const b = JSON.parse(init.body as string) as { text: string; base: string | null };
    if (b.base !== null && b.base !== disk.base) return Response.json({ error: 'changed' }, { status: 409 });
    write(b.text.replace(/\r?\n/g, '\r\n'));
    return Response.json({ base: disk.base });
  }));
  const { result, rerender } = open();
  await waitFor(() => expect(result.current.cut).not.toBeNull());
  act(() => result.current.apply(later(result.current.cut!, 1)));
  await waitFor(() => expect(result.current.status).toBe('saved'), { timeout: SAVE_DELAY + 1000 });
  expect(disk.text).toContain('\r\n');
  rerender({ text: disk.text }); // the view reads the file again
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(result.current.status).toBe('saved');
  expect(result.current.canUndo).toBe(true); // not reloaded as if the agent had written it
  // the next edit saves over the version the server wrote
  act(() => result.current.apply(later(result.current.cut!, 2)));
  await waitFor(() => expect(JSON.parse(disk.text).clips[0].at).toBe(2), { timeout: SAVE_DELAY + 1000 });
});

it('closed while a save is in flight: the last edit is written after it, over its new version', async () => {
  let release!: () => void;
  let held = true;
  const real = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && held) { held = false; await new Promise<void>((r) => { release = r; }); }
    return real(url, init);
  }));
  const { result, unmount } = open();
  await waitFor(() => expect(result.current.cut).not.toBeNull());
  act(() => result.current.apply(later(result.current.cut!, 1)));
  await waitFor(() => expect(result.current.status).toBe('saving'), { timeout: SAVE_DELAY + 1000 });
  act(() => result.current.apply(later(result.current.cut!, 2)));
  unmount();
  release();
  await waitFor(() => expect(JSON.parse(disk.text).clips[0].at).toBe(2));
  expect(posts.map((p) => p.base)).toEqual(['b1', 'b2']);
});

it('a page closed or reloaded within the pause still writes the last edit', async () => {
  const { result } = open();
  await waitFor(() => expect(result.current.cut).not.toBeNull());
  act(() => result.current.apply(later(result.current.cut!, 3)));
  window.dispatchEvent(new Event('pagehide'));
  await waitFor(() => expect(JSON.parse(disk.text).clips[0].at).toBe(3));
  const init = vi.mocked(fetch).mock.calls.find(([, i]) => i?.method === 'POST')![1]!;
  expect(init.keepalive).toBe(true);
  await new Promise((r) => setTimeout(r, SAVE_DELAY + 200));
  expect(posts).toHaveLength(1); // the pause's save found it written
});
