import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, Comment, CutAnchor } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { selectComments } from '@/comments/slice.ts';
import { jumpToFileComment } from '@/files/slice.ts';
import { CutBody } from './CutBody.tsx';
import { clipGone } from './live.ts';
import { SAVE_DELAY } from './useCutDoc.ts';

vi.mock('./thumbs.ts', () => ({ poster: vi.fn(async () => null) }));
vi.mock('./durations.ts', () => ({ srcLength: vi.fn(async () => 4) }));

// comments on an edit's timeline (issue 430)
const fixture = {
  version: 1, width: 1280, height: 720, fps: 25,
  tracks: [{ id: 'v1', kind: 'video', name: 'Main' }, { id: 'a1', kind: 'audio', name: 'Voice' }],
  clips: [
    { id: 'c1', track: 'v1', src: 'media/intro.mp4', at: 0, out: 4 },
    { id: 'c2', track: 'v1', src: 'media/street.webm', at: 6, out: 4 },
    { id: 'c3', track: 'a1', src: 'media/voice.wav', at: 1, in: 2, out: 9 },
  ],
};
const source = { kind: 'file' as const, path: 'e.nbcut.json' };

let disk: { text: string; base: string };
let ver: number;
beforeEach(() => {
  setLang('en');
  ver = 0;
  disk = { text: JSON.stringify(fixture), base: 'b0' };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-timeline-scroll') ? 1160 : 0; },
  });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} takeRecords() { return []; } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/cut/export?')) return Response.json({ ffmpeg: true, job: null });
    if (!url.startsWith('/edit')) return new Response(null, { status: 200 });
    if (init?.method !== 'POST') return Response.json(disk);
    const b = JSON.parse(init.body as string) as { text: string };
    disk = { text: b.text, base: `b${++ver}` };
    return Response.json({ base: disk.base });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth; });

async function show({ protocol = 23, items = [] as Comment[] } = {}) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: (_u, _e, s) => { setTimeout(() => s('open')); return { send: (m: ClientMessage) => (sent.push(m), true), close() {} }; } });
  store.dispatch(serverEvent({ kind: 'hello', protocol } as never));
  store.dispatch(serverEvent({ kind: 'comments', items, rev: 1 } as never));
  const r = render(<Provider store={store}><TooltipProvider><CutBody text={disk.text} src="here" path="e.nbcut.json" tabId="file:e.nbcut.json" active /></TooltipProvider></Provider>);
  await waitFor(() => expect(r.container.querySelector('[data-cut-tools]')).not.toBeNull());
  const pps = () => Number(r.container.querySelector('[data-timeline]')!.getAttribute('data-pps'));
  const clip = (id: string) => r.container.querySelector<HTMLElement>(`[data-clip="${id}"]`)!;
  const seek = (t: number) => {
    const ruler = r.container.querySelector('[data-ruler]')!;
    fireEvent.pointerDown(ruler, { clientX: t * pps(), button: 0, pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: t * pps(), pointerId: 1 });
  };
  const select = (id: string) => {
    fireEvent.pointerDown(clip(id), { clientX: 1, button: 0, pointerId: 1 });
    fireEvent.pointerUp(clip(id), { clientX: 1, pointerId: 1 });
  };
  const time = () => r.container.querySelector('[data-cut-time]')!.textContent;
  const cuts = () => selectComments(store.getState()).map((c) => c.anchor as CutAnchor);
  return { ...r, store, sent, pps, clip, seek, select, time, cuts };
}
const note = (id: string, anchor: Omit<CutAnchor, 'kind' | 'source'>, text = `note ${id}`): Comment =>
  ({ id, text, status: 'pending', createdAt: 1, anchor: { kind: 'cut', source, ...anchor } });
const addNote = (text: string) => {
  fireEvent.change(screen.getByPlaceholderText('Comment…'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
};

it('Comment, its key named in the tooltip: a selected clip under the playhead is pinned there, with the moment in its source', async () => {
  const { seek, select, cuts } = await show();
  const btn = screen.getByRole('button', { name: /^Comment.*\(C\)$/ });
  seek(3.5);
  select('c3');
  fireEvent.click(btn);
  addNote('the tail is cut off');
  expect(cuts()).toEqual([{ kind: 'cut', source, time: 3.5, clip: { id: 'c3', track: 'a1', trackName: 'Voice', src: 'media/voice.wav', srcTime: 4.5 } }]);
});

it('C with the playhead off the selected clip pins it at its start; with nothing selected, the moment of the timeline', async () => {
  const { seek, select, cuts } = await show();
  seek(5);
  select('c2');
  fireEvent.keyDown(document, { code: 'KeyC', key: 'c' });
  addNote('a');
  expect(cuts()[0]).toMatchObject({ time: 6, clip: { id: 'c2', srcTime: 0 } });
  fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
  await waitFor(() => expect(document.querySelector('[data-selected]')).toBeNull());
  fireEvent.keyDown(document, { code: 'KeyC', key: 'c' });
  addNote('b');
  expect(cuts()[1]).toEqual({ kind: 'cut', source, time: 5 });
});

it('an older server (22) would refuse the comment: no Comment', async () => {
  await show({ protocol: 22 });
  expect(screen.queryByRole('button', { name: /^Comment/ })).toBeNull();
});

it('ticks: on the clip and on the ruler, the note on hover; a click seeks there and selects the clip', async () => {
  const { container, clip, time } = await show({ items: [note('k1', { time: 2, clip: { id: 'c3', track: 'a1', src: 'media/voice.wav', srcTime: 3 } }), note('k2', { time: 7.5 })] });
  const onClip = container.querySelector<HTMLElement>('[data-lane-body="a1"] [data-cut-note="k1"]')!;
  const onRuler = container.querySelector<HTMLElement>('[data-ruler] [data-cut-note="k2"]')!;
  expect(onClip.title).toContain('note k1');
  expect(onRuler.title).toContain('note k2');
  fireEvent.click(onClip);
  expect(time()).toMatch(/^0:02\.0/);
  expect(clip('c3')).toHaveAttribute('data-selected');
  fireEvent.click(onRuler);
  expect(time()).toMatch(/^0:07\.5/);
});

it('a moved clip takes its comment along (an edit op with the new anchor); a clip that is gone is known gone', async () => {
  const k1 = note('k1', { time: 2, clip: { id: 'c3', track: 'a1', src: 'media/voice.wav', srcTime: 3 } });
  const { clip, pps, select, cuts, sent } = await show({ items: [k1] });
  expect(clipGone('e.nbcut.json', undefined, 'c3')).toBe(false);
  const p = pps();
  fireEvent.pointerDown(clip('c3'), { clientX: 100, button: 0, pointerId: 1, altKey: true });
  fireEvent.pointerMove(clip('c3'), { clientX: 100 + 2 * p, clientY: 0, pointerId: 1, altKey: true });
  fireEvent.pointerUp(clip('c3'), { clientX: 100 + 2 * p, clientY: 0, pointerId: 1, altKey: true });
  await waitFor(() => expect(cuts()[0]!.time).toBe(4));
  expect(cuts()[0]!.clip!.srcTime).toBe(3);
  await waitFor(() => expect(sent.some((m) => m.type === 'comment-op' && m.ops[0]!.op === 'edit')).toBe(true));
  select('c3');
  fireEvent.keyDown(document, { code: 'Delete', key: 'Delete' });
  await waitFor(() => expect(clipGone('e.nbcut.json', undefined, 'c3')).toBe(true));
  expect(cuts()[0]!.time).toBe(4); // it keeps its time
  await waitFor(() => expect(JSON.parse(disk.text).clips).toHaveLength(2), { timeout: SAVE_DELAY + 1500 });
});

it('the card\'s jump seeks the timeline and selects the clip', async () => {
  const { store, clip, time } = await show({ items: [note('k1', { time: 2.5, clip: { id: 'c1', track: 'v1', src: 'media/intro.mp4', srcTime: 2.5 } })] });
  act(() => void store.dispatch(jumpToFileComment('e.nbcut.json', 'k1')));
  await waitFor(() => expect(time()).toMatch(/^0:02\.5/));
  expect(clip('c1')).toHaveAttribute('data-selected');
  expect(store.getState().files.jump).toBeNull();
});
