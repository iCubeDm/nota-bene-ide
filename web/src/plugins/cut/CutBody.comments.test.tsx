import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Comment, CutAnchor } from '@nota-bene/shared';
import { serverEvent } from '@/core/store/store.ts';
import { renderWith } from '@/core/testing';
import { selectComments } from '@/plugins/comments/slice.ts';
import { jumpToFileComment } from '@/plugins/files/slice.ts';
import { CutBody } from './CutBody.tsx';
import { liveCutState } from './live.ts';
import { SAVE_DELAY } from './useCutDoc.ts';
import { disk, elapse, onDisk, setupCut, write } from './testCut.tsx';

vi.mock('./thumbs.ts', () => ({ poster: vi.fn(async () => null) }));
// the waveforms (peaks.ts) are their own tests' (CutBody.edit.test.tsx): here they ask nothing of the server
vi.mock('./peaks.ts', () => ({ peaksOf: vi.fn(async () => null) }));
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

setupCut(fixture);

async function show({ protocol = 23, items = [] as Comment[] } = {}) {
  const ui = (text: string) => <CutBody text={text} src="here" path="e.nbcut.json" tabId="file:e.nbcut.json" active />;
  const r = renderWith(ui(disk.text), { hello: { protocol }, events: [{ kind: 'comments', items, rev: 1 }] });
  const { store, conn: { sent } } = r;
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
  const reload = (text: string) => r.rerender(ui(text));
  return { ...r, sent, pps, clip, seek, select, time, cuts, reload };
}
const note = (id: string, anchor: Omit<CutAnchor, 'kind' | 'source'>, text = `note ${id}`): Comment =>
  ({ id, text, status: 'pending', createdAt: 1, anchor: { kind: 'cut', source, ...anchor } });
const addNote = (text: string) => {
  fireEvent.change(screen.getByPlaceholderText('Comment…'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
};

it('Comment, its key named in the tooltip: a selected clip under the playhead is pinned there, with the moment in its source', async () => {
  const { seek, select, cuts } = await show();
  const btn = screen.getByRole('button', { name: /^Comment.*\(M\)$/ });
  seek(3.5);
  select('c3');
  fireEvent.click(btn);
  addNote('the tail is cut off');
  expect(cuts()).toEqual([{ kind: 'cut', source, time: 3.5, clip: { id: 'c3', track: 'a1', trackName: 'Voice', src: 'media/voice.wav', srcTime: 4.5 } }]);
});

it('M with the playhead off the selected clip pins it at its start; with nothing selected, the moment of the timeline', async () => {
  const { seek, select, cuts } = await show();
  seek(5);
  select('c2');
  fireEvent.keyDown(document, { code: 'KeyM', key: 'm' });
  addNote('a');
  expect(cuts()[0]).toMatchObject({ time: 6, clip: { id: 'c2', srcTime: 0 } });
  fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
  await waitFor(() => expect(document.querySelector('[data-selected]')).toBeNull());
  fireEvent.keyDown(document, { code: 'KeyM', key: 'm' });
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
  expect(liveCutState(k1.anchor as CutAnchor)).toBe('ok');
  const p = pps();
  fireEvent.pointerDown(clip('c3'), { clientX: 100, button: 0, pointerId: 1, altKey: true });
  fireEvent.pointerMove(clip('c3'), { clientX: 100 + 2 * p, clientY: 0, pointerId: 1, altKey: true });
  fireEvent.pointerUp(clip('c3'), { clientX: 100 + 2 * p, clientY: 0, pointerId: 1, altKey: true });
  await waitFor(() => expect(cuts()[0]!.time).toBe(4));
  expect(cuts()[0]!.clip!.srcTime).toBe(3);
  await waitFor(() => expect(sent.some((m) => m.type === 'comment-op' && m.ops[0]!.op === 'edit')).toBe(true));
  select('c3');
  fireEvent.keyDown(document, { code: 'Delete', key: 'Delete' });
  await waitFor(() => expect(liveCutState(k1.anchor as CutAnchor)).toBe('gone'));
  expect(cuts()[0]!.time).toBe(4); // it keeps its time
  await waitFor(() => expect(onDisk().clips).toHaveLength(2), { timeout: SAVE_DELAY + 1500 });
});

it('only this window\'s own changes move a comment: never the edit as loaded, a reload of the file or an incoming edit of the comment', async () => {
  const stale = note('k1', { time: 9, clip: { id: 'c3', track: 'a1', src: 'media/voice.wav', srcTime: 3 } }); // c3 puts it at 2
  const { sent, reload, store, cuts, container } = await show({ items: [stale] });
  const edits = () => sent.filter((m) => m.type === 'comment-op').length;
  await elapse(50);
  expect(edits()).toBe(0);
  // the tick is drawn where the clip puts it all the same
  expect(container.querySelector<HTMLElement>('[data-cut-note="k1"]')!.title).toMatch(/^0:02\.000/);
  write(JSON.stringify({ ...fixture, clips: fixture.clips.map((c) => (c.id === 'c3' ? { ...c, at: 3 } : c)) }));
  reload(disk.text);
  await waitFor(() => expect(container.querySelector<HTMLElement>('[data-cut-note="k1"]')!.title).toMatch(/^0:04\.000/));
  store.dispatch(serverEvent({ kind: 'comments', items: [{ ...stale, anchor: { ...stale.anchor, time: 7 } as CutAnchor }], rev: 2 } as never));
  await elapse(50);
  expect(edits()).toBe(0);
  expect(cuts()[0]!.time).toBe(7);
});

it('the card\'s jump seeks the timeline and selects the clip', async () => {
  const { store, clip, time } = await show({ items: [note('k1', { time: 2.5, clip: { id: 'c1', track: 'v1', src: 'media/intro.mp4', srcTime: 2.5 } })] });
  act(() => void store.dispatch(jumpToFileComment('e.nbcut.json', 'k1')));
  await waitFor(() => expect(time()).toMatch(/^0:02\.5/));
  expect(clip('c1')).toHaveAttribute('data-selected');
  expect(store.getState().jump).toBeNull();
});

it('a blade cut takes a comment on the right part along to it, as S does (issue 432)', async () => {
  const k1 = note('k1', { time: 5, clip: { id: 'c3', track: 'a1', src: 'media/voice.wav', srcTime: 6 } });
  const { clip, pps, cuts } = await show({ items: [k1] });
  fireEvent.keyDown(document, { code: 'KeyC', key: 'c' });
  fireEvent.pointerDown(clip('c3'), { clientX: 3 * pps(), clientY: 0, button: 0, pointerId: 1 });
  fireEvent.pointerUp(clip('c3'), { clientX: 3 * pps(), clientY: 0, pointerId: 1 });
  await waitFor(() => expect(cuts()[0]!.clip!.id).not.toBe('c3'));
  expect(cuts()[0]).toMatchObject({ time: 5, clip: { src: 'media/voice.wav', srcTime: 6 } });
  await waitFor(() => expect(onDisk().clips).toHaveLength(4), { timeout: SAVE_DELAY + 1500 });
});
