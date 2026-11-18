import { act, cleanup, createEvent, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { PATH_MIME } from './drag.ts';
import { FLASH_MS } from './changes.ts';
import { SAVE_DELAY } from './useCutDoc.ts';
import { currentEditTarget } from './targets.ts';
import { clipOnDisk, drag, elapse, fixture, onDisk, saved, setupCut, show, valid, write } from './testCut.tsx';

vi.mock('./thumbs.ts', () => ({ poster: vi.fn(async () => null) }));
vi.mock('./durations.ts', () => ({ srcLength: vi.fn(async (url: string) => (url.includes('unread') ? null : 4)) }));
vi.mock('./peaks.ts', () => ({
  peaksOf: vi.fn(async (src: string) => (src === 'media/street.webm' ? { none: 'no-audio' } : { peaks: new Uint8Array(800).fill(128) })),
}));

setupCut();

it('a click selects a clip, a drag moves it and the file follows; undo and redo', async () => {
  const { clip, pps } = await show();
  const p = pps();
  fireEvent.pointerDown(clip('c2'), { clientX: 100, button: 0, pointerId: 1 });
  fireEvent.pointerUp(clip('c2'), { clientX: 100, pointerId: 1 });
  expect(clip('c2')).toHaveAttribute('data-selected');
  drag(clip('c2'), 100, 100 + 1.5 * p, { altKey: true }); // Alt: no snapping
  expect(clip('c2').style.left).toBe(`${7.5 * p}px`);
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(7.5));
  valid();
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(6));
  fireEvent.click(screen.getByRole('button', { name: /^Redo/ }));
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(7.5));
});

it('a drag snaps to a clip edge and never overlaps the neighbour', async () => {
  const { clip, pps } = await show();
  const p = pps();
  drag(clip('c2'), 100, 100 - 1.95 * p); // to 4.05: snaps to the end of c1 at 4
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(4));
  drag(clip('c2'), 100, 100 - 3 * p, { altKey: true }); // over c1: stays after it
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(4));
  valid();
});

it('an edge trims the clip', async () => {
  const { container, pps } = await show();
  const p = pps();
  const end = container.querySelector('[data-clip="c1"] [data-trim="end"]')!;
  drag(end, 100, 100 - p, { altKey: true });
  await saved(() => expect(clipOnDisk('c1')).toMatchObject({ at: 0, out: 3 }));
  const start = container.querySelector('[data-clip="c2"] [data-trim="start"]')!;
  drag(start, 100, 100 + p, { altKey: true });
  await saved(() => expect(clipOnDisk('c2')).toMatchObject({ at: 7, in: 1, out: 4 }));
  valid();
});

it('keys: S splits at the playhead, Delete deletes, arrows nudge, ⌘Z and ⇧⌘Z', async () => {
  const { container, clip } = await show();
  const ruler = container.querySelector('[data-ruler]')!;
  const p = Number(container.querySelector('[data-timeline]')!.getAttribute('data-pps'));
  fireEvent.pointerDown(ruler, { clientX: 2 * p, button: 0, pointerId: 9 });
  fireEvent.pointerUp(ruler, { clientX: 2 * p, pointerId: 9 });
  fireEvent.pointerDown(clip('c1'), { clientX: 10, button: 0, pointerId: 1 });
  fireEvent.pointerUp(clip('c1'), { clientX: 10, pointerId: 1 });
  fireEvent.keyDown(document.body, { code: 'KeyS', key: 's' });
  await saved(() => expect(onDisk().clips.filter((c) => c.src === 'media/intro.mp4')).toHaveLength(2));
  expect(clipOnDisk('c1')).toMatchObject({ at: 0, out: 2 });
  valid();
  fireEvent.keyDown(document.body, { code: 'ArrowRight', key: 'ArrowRight' }); // c1 is still selected: no room after it
  fireEvent.keyDown(document.body, { code: 'Delete', key: 'Delete' });
  await saved(() => expect(clipOnDisk('c1')).toBeUndefined());
  fireEvent.keyDown(document.body, { code: 'KeyZ', key: 'z', metaKey: true });
  await saved(() => expect(clipOnDisk('c1')).toBeDefined());
  fireEvent.keyDown(document.body, { code: 'KeyZ', key: 'z', metaKey: true, shiftKey: true });
  await saved(() => expect(clipOnDisk('c1')).toBeUndefined());
  // with c2 selected, → nudges it a frame
  fireEvent.pointerDown(clip('c2'), { clientX: 10, button: 0, pointerId: 1 });
  fireEvent.pointerUp(clip('c2'), { clientX: 10, pointerId: 1 });
  fireEvent.keyDown(document.body, { code: 'ArrowRight', key: 'ArrowRight' });
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(6.04));
  valid();
});

it('the tools say their keys', async () => {
  await show();
  expect(screen.getByRole('button', { name: /^Split at the playhead.*\(S\)$/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Delete the selected clips \(Delete\)/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Undo \(/ }).getAttribute('title')).toMatch(/Z/);
});

it('tracks: add, rename, mute, reorder, remove', async () => {
  const { container } = await show();
  fireEvent.click(screen.getByRole('button', { name: 'Add a video track' }));
  await saved(() => expect(onDisk().tracks.map((t) => t.id)).toEqual(['v1', 'a1', 'v2']));
  fireEvent.doubleClick(container.querySelector('[data-track-head="v2"] [data-track-name]')!);
  const input = screen.getByRole('textbox', { name: 'Track name' });
  fireEvent.change(input, { target: { value: 'Logo' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await saved(() => expect(onDisk().tracks[2]).toMatchObject({ name: 'Logo' }));
  fireEvent.click(container.querySelector('[data-track-head="a1"] [aria-label="Mute"]')!);
  await saved(() => expect(onDisk().tracks[1]).toMatchObject({ mute: true }));
  // the track's gain (issue 410): a click types it, Esc keeps the old one, Enter applies it
  const level = () => container.querySelector<HTMLButtonElement>('[data-track-head="a1"] [data-track-gain]')!;
  const field = () => screen.getByRole('textbox', { name: /^Track gain/ });
  expect(level().textContent).toBe('0 dB');
  fireEvent.click(level());
  fireEvent.change(field(), { target: { value: '-4' } });
  fireEvent.keyDown(field(), { key: 'Escape' });
  expect(level().textContent).toBe('0 dB');
  fireEvent.click(level());
  fireEvent.change(field(), { target: { value: '-4.5' } });
  fireEvent.keyDown(field(), { key: 'Enter' });
  await saved(() => expect(onDisk().tracks[1]).toMatchObject({ gain: -4.5 }));
  expect(level().textContent).toBe('−4.5 dB');
  // v1 down under v2 in the picture: before it in the file
  fireEvent.click(container.querySelector('[data-track-head="v2"] [aria-label="Move the track down"]')!);
  await saved(() => expect(onDisk().tracks.map((t) => t.id)).toEqual(['v2', 'a1', 'v1']));
  fireEvent.click(container.querySelector('[data-track-head="a1"] [aria-label="Delete track"]')!);
  await saved(() => expect(onDisk().tracks.map((t) => t.id)).toEqual(['v2', 'v1']));
  expect(onDisk().clips.map((c) => c.id)).toEqual(['c1', 'c2']);
  valid();
});

it('the track gain field (issue 410): opened and left unchanged it changes nothing, even a gain the field would not take', async () => {
  const tracks = [{ id: 'v1', kind: 'video', name: 'Main', gain: -80 }, { id: 'a1', kind: 'audio', name: 'Voice', gain: -3.25 }];
  write(JSON.stringify({ ...fixture, tracks }));
  const { container } = await show();
  const level = (id: string) => container.querySelector<HTMLButtonElement>(`[data-track-head="${id}"] [data-track-gain]`)!;
  expect(level('v1').textContent).toBe('−80 dB');
  expect(level('a1').textContent).toBe('−3.3 dB');
  for (const [id, shown] of [['v1', '-80'], ['a1', '-3.25']] as const) {
    fireEvent.click(level(id));
    const field = screen.getByRole('textbox', { name: /^Track gain/ });
    expect(field).toHaveValue(shown);
    fireEvent.blur(field);
    expect(screen.queryByRole('textbox', { name: /^Track gain/ })).toBeNull();
  }
  // retyped to the same number, still nothing
  fireEvent.click(level('a1'));
  fireEvent.change(screen.getByRole('textbox', { name: /^Track gain/ }), { target: { value: '-3.250' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: /^Track gain/ }), { key: 'Enter' });
  await elapse(SAVE_DELAY + 200);
  expect(onDisk().tracks).toEqual(tracks);
  expect(screen.getByRole('button', { name: /^Undo/ })).toBeDisabled();
});

it('the track gain field (issue 410): leaving it applies a typed value, with a comma or a minus sign; a bad one is marked and kept', async () => {
  const { container } = await show();
  const level = () => container.querySelector<HTMLButtonElement>('[data-track-head="a1"] [data-track-gain]')!;
  const field = () => screen.getByRole('textbox', { name: /^Track gain/ });
  fireEvent.click(level());
  expect(field()).toHaveAttribute('inputmode', 'decimal');
  fireEvent.change(field(), { target: { value: '−2,5' } });
  fireEvent.blur(field());
  await saved(() => expect(onDisk().tracks[1]).toMatchObject({ gain: -2.5 }));
  expect(level().textContent).toBe('−2.5 dB');
  // a value the user typed is still held to the range
  fireEvent.click(level());
  fireEvent.change(field(), { target: { value: '-90' } });
  fireEvent.blur(field());
  await saved(() => expect(onDisk().tracks[1]).toMatchObject({ gain: -60 }));
  fireEvent.click(level());
  for (const bad of ['abc', '', '1..2']) {
    fireEvent.change(field(), { target: { value: bad } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(field()).toHaveAttribute('title', 'Not a valid value here');
  }
  fireEvent.change(field(), { target: { value: '-1' } });
  expect(field()).not.toHaveAttribute('aria-invalid');
  fireEvent.keyDown(field(), { key: 'Escape' });
  expect(level().textContent).toBe('−60 dB');
});

it('a file dropped from the tree becomes a clip of its whole length; a new track when dropped below', async () => {
  const { container, pps } = await show();
  const p = pps();
  const dt = (path: string) => ({ types: [PATH_MIME], getData: (k: string) => (k === PATH_MIME ? path : ''), dropEffect: 'none' });
  const body = container.querySelector('[data-lane-body="a1"]')!;
  // jsdom's drag events take no clientX from their init
  const at = (ev: Event, x: number) => (Object.defineProperty(ev, 'clientX', { value: x }), ev);
  fireEvent(body, at(createEvent.dragOver(body, { dataTransfer: dt('media/music.mp3') }), 9 * p));
  fireEvent(body, at(createEvent.drop(body, { dataTransfer: dt('media/music.mp3') }), 9 * p));
  await saved(() => expect(onDisk().clips.find((c) => c.src === 'media/music.mp3')).toMatchObject({ track: 'a1', at: 9, out: 4 }));
  // below the lanes: a new track of the file's kind
  const zone = container.querySelector('[data-cut-drop]')!;
  fireEvent(zone, at(createEvent.drop(zone, { dataTransfer: dt('media/logo.png') }), 0));
  await saved(() => expect(onDisk().clips.find((c) => c.src === 'media/logo.png')).toMatchObject({ track: 'v2', dur: 5 }));
  valid();
});

it('Add to edit from the Files tree (issue 426): the edit is a target while shown; the files go after each kind\'s first track, one undo step', async () => {
  const { container } = await show();
  const target = currentEditTarget();
  expect(target?.path).toBe('e.nbcut.json');
  await act(async () => { await target!.add(['media/music.mp3', 'media/unread.mp4', 'media/logo.png', 'notes.txt']); });
  await saved(() => expect(onDisk().clips.filter((c) => !['c1', 'c2', 'c3'].includes(c.id)).map((c) => [c.track, c.src, c.at])).toEqual([
    ['a1', 'media/music.mp3', 8], ['v1', 'media/logo.png', 10],
  ]));
  expect(onDisk().clips.some((c) => c.src === 'media/unread.mp4')).toBe(false);
  valid();
  // what no track takes is said, and the added clips are selected
  // a video whose length the browser cannot read is not guessed at: it is named with them
  expect(screen.getByText(/unread\.mp4, notes\.txt cannot go into the edit/)).toBeInTheDocument();
  expect(container.querySelectorAll('[data-clip][data-selected]')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(onDisk().clips).toHaveLength(3));
  cleanup();
  expect(currentEditTarget()).toBeNull();
});

it('the inspector edits the selected clip; a value the format refuses is marked, not saved', async () => {
  const { clip } = await show();
  fireEvent.pointerDown(clip('c3'), { clientX: 10, button: 0, pointerId: 1 });
  fireEvent.pointerUp(clip('c3'), { clientX: 10, pointerId: 1 });
  const gain = screen.getByRole('spinbutton', { name: 'Gain, dB' });
  fireEvent.change(gain, { target: { value: '-6' } });
  fireEvent.blur(gain);
  await saved(() => expect(clipOnDisk('c3')).toMatchObject({ gain: -6 }));
  const fade = screen.getByRole('spinbutton', { name: 'Fade in, s' });
  fireEvent.change(fade, { target: { value: '99' } });
  fireEvent.blur(fade);
  expect(fade).toHaveAttribute('aria-invalid', 'true');
  expect(clipOnDisk('c3')!).not.toHaveProperty('fadeIn');
  expect(screen.queryByRole('spinbutton', { name: 'Opacity, %' })).toBeNull(); // an audio clip has no picture
});

it('the inspector reverses the selected clip (issue 492): saved, marked while its copy is made, undoable', async () => {
  const { clip, container } = await show();
  fireEvent.pointerDown(clip('c3'), { clientX: 10, button: 0, pointerId: 1 });
  fireEvent.pointerUp(clip('c3'), { clientX: 10, pointerId: 1 });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Reverse' }));
  await saved(() => expect(clipOnDisk('c3')).toMatchObject({ reverse: true }));
  valid();
  await waitFor(() => expect(container.querySelector('[data-clip="c3"] [data-reversing="making"]')).toHaveTextContent('reversing…'));
  expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith('/cut/reverse?path=media%2Fvoice.wav&in=0&out='))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(clipOnDisk('c3')).not.toHaveProperty('reverse'));
  expect(container.querySelector('[data-clip="c3"] [data-reversing]')).toBeNull();
});

it('the selected video clip has its frame on the preview: dragged, resized, opacity, fit to frame', async () => {
  const { container, clip } = await show();
  fireEvent.pointerDown(clip('c1'), { clientX: 10, button: 0, pointerId: 1 });
  fireEvent.pointerUp(clip('c1'), { clientX: 10, pointerId: 1 });
  const frame = container.querySelector<HTMLElement>('[data-cut-frame]')!;
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON() {} });
  const box = container.querySelector('[data-place-box]')!;
  const se = box.querySelector('[data-corner="se"]')!;
  fireEvent.pointerDown(se, { clientX: 1000, clientY: 500, button: 0, pointerId: 2 });
  fireEvent.pointerMove(se, { clientX: 500, clientY: 400, pointerId: 2 });
  fireEvent.pointerUp(se, { clientX: 500, clientY: 400, pointerId: 2 });
  await saved(() => expect(clipOnDisk('c1')!).toMatchObject({ place: { x: 0, y: 0, w: 0.8, h: 0.8 } })); // aspect kept
  fireEvent.pointerDown(box, { clientX: 100, clientY: 100, button: 0, pointerId: 3 });
  fireEvent.pointerMove(box, { clientX: 200, clientY: 150, pointerId: 3 });
  fireEvent.pointerUp(box, { clientX: 200, clientY: 150, pointerId: 3 });
  await saved(() => expect(clipOnDisk('c1')!).toMatchObject({ place: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } }));
  const op = screen.getByRole('spinbutton', { name: 'Opacity, %' });
  fireEvent.change(op, { target: { value: '50' } });
  fireEvent.keyDown(op, { key: 'Enter' });
  await saved(() => expect(clipOnDisk('c1')!.place).toMatchObject({ opacity: 0.5 }));
  fireEvent.click(screen.getByRole('button', { name: 'Fit to frame' }));
  await saved(() => expect(clipOnDisk('c1')!).not.toHaveProperty('place'));
  valid();
});

it('an outside change reloads the edit when nothing is unsaved', async () => {
  const { clip, reload } = await show();
  write(JSON.stringify({ ...fixture, clips: fixture.clips.map((c) => (c.id === 'c2' ? { ...c, at: 9 } : c)) }));
  act(() => reload());
  await waitFor(() => expect(clip('c2').style.left).toBe(`${9 * Number(clip('c2').closest('[data-timeline]')!.getAttribute('data-pps'))}px`));
});

const agentEdit = (out: number) => write(JSON.stringify({
  ...fixture,
  clips: [
    { ...fixture.clips[0]!, out }, // trimmed
    fixture.clips[2]!, // as it was
    { id: 'c9', track: 'a1', src: 'media/music.wav', at: 8, out: 2 }, // added
  ], // c2 removed
}));
const mark = (el: Element) => el.querySelector<HTMLElement>(':scope > [data-changed-mark]');

it('the agent\'s change is highlighted for a moment (issue 412): changed and added clips, a ghost where a removed one was', async () => {
  const { container, clip, reload } = await show();
  // c1 selected: its selection ring stays while it is highlighted, the highlight is a layer of its own
  fireEvent.pointerDown(clip('c1'), { clientX: 10, button: 0, pointerId: 1 });
  fireEvent.pointerUp(clip('c1'), { clientX: 10, pointerId: 1 });
  agentEdit(3);
  act(() => reload());
  await waitFor(() => expect(clip('c9')).toHaveAttribute('data-changed'));
  expect(clip('c1')).toHaveAttribute('data-changed');
  expect(clip('c3')).not.toHaveAttribute('data-changed');
  expect(mark(clip('c3'))).toBeNull();
  const m = mark(clip('c1'))!;
  expect(m.className).toMatch(/\bnb-cut-flash\b/);
  expect(m.className).toMatch(/\bpointer-events-none\b/);
  expect(m.style.getPropertyValue('--nb-flash-ms')).toBe(`${FLASH_MS}ms`);
  expect(clip('c1').className).not.toMatch(/nb-cut-flash/);
  expect(clip('c1').className).toMatch(/\bring-2\b/);
  const ghost = container.querySelector<HTMLElement>('[data-lane-body="v1"] [data-removed-clip="c2"]')!;
  expect(ghost).not.toBeNull();
  expect(ghost).toHaveTextContent('street.webm'); // shown in it: a pointer never reaches it for a tooltip
  expect(ghost).toHaveAttribute('aria-label', expect.stringContaining('media/street.webm'));
  expect(ghost.style.getPropertyValue('--nb-flash-ms')).toBe(`${FLASH_MS}ms`);
  // it fades and is gone after a moment
  await waitFor(() => expect(container.querySelector('[data-changed], [data-changed-mark], [data-removed-clip]')).toBeNull(), { timeout: FLASH_MS + 1500 });
});

it('another write by the agent within the highlight starts its fade again, the clip itself stays', async () => {
  const { clip, reload } = await show();
  agentEdit(3);
  act(() => reload());
  await waitFor(() => expect(mark(clip('c1'))).not.toBeNull());
  const [el, m] = [clip('c1'), mark(clip('c1'))];
  agentEdit(2);
  act(() => reload());
  await waitFor(() => expect(mark(clip('c1'))).not.toBe(m));
  expect(mark(clip('c1'))).not.toBeNull();
  expect(clip('c1')).toBe(el); // its poster and waveform are not loaded again
});

it('in a tab not shown the highlight waits: its moment starts when the tab is shown', async () => {
  const { container, clip, reload, setActive } = await show();
  setActive(false);
  agentEdit(3);
  act(() => reload());
  await waitFor(() => expect(clip('c1').style.width).toBe(`${3 * Number(clip('c1').closest('[data-timeline]')!.getAttribute('data-pps'))}px`));
  expect(container.querySelector('[data-changed-mark], [data-removed-clip]')).toBeNull();
  await elapse(FLASH_MS + 200);
  setActive(true);
  expect(mark(clip('c1'))).not.toBeNull();
  expect(container.querySelector('[data-removed-clip="c2"]')).not.toBeNull();
  await waitFor(() => expect(container.querySelector('[data-changed-mark], [data-removed-clip]')).toBeNull(), { timeout: FLASH_MS + 1500 });
});

it('our own edit is not highlighted, nor the edit as first opened: its save read back is no reload', async () => {
  const { container, clip, pps, reread } = await show();
  expect(container.querySelector('[data-changed]')).toBeNull();
  drag(clip('c2'), 100, 100 + 1.5 * pps(), { altKey: true });
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(7.5));
  await reread(); // the file view reads our own save back
  expect(container.querySelector('[data-changed], [data-changed-mark], [data-removed-clip]')).toBeNull();
  // not reloaded as if from outside: the undo history is still there
  expect(screen.getByRole('button', { name: /^Undo/ })).toBeEnabled();
});

it('a drag that an outside change overtook is dropped: the agent\'s version stays', async () => {
  const { clip, pps, reload } = await show();
  const p = pps();
  fireEvent.pointerDown(clip('c2'), { clientX: 100, clientY: 0, button: 0, pointerId: 1, altKey: true });
  fireEvent.pointerMove(clip('c2'), { clientX: 100 + p, clientY: 0, pointerId: 1, altKey: true });
  // the agent moves c1 while the drag goes on; the view reads it
  write(JSON.stringify({ ...fixture, clips: fixture.clips.map((c) => (c.id === 'c1' ? { ...c, at: 1 } : c)) }));
  act(() => reload());
  await waitFor(() => expect(clip('c1').style.left).toBe(`${1 * p}px`));
  fireEvent.pointerUp(clip('c2'), { clientX: 100 + p, clientY: 0, pointerId: 1 });
  await elapse(SAVE_DELAY + 300);
  expect(clipOnDisk('c1')!.at).toBe(1);
  expect(clipOnDisk('c2')!.at).toBe(6);
});

it('a frame drag that an outside change overtook is dropped too', async () => {
  const { container, clip, reload } = await show();
  fireEvent.pointerDown(clip('c1'), { clientX: 10, button: 0, pointerId: 1 });
  fireEvent.pointerUp(clip('c1'), { clientX: 10, pointerId: 1 });
  const frame = container.querySelector<HTMLElement>('[data-cut-frame]')!;
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON() {} });
  const se = container.querySelector('[data-place-box] [data-corner="se"]')!;
  fireEvent.pointerDown(se, { clientX: 1000, clientY: 500, button: 0, pointerId: 2 });
  fireEvent.pointerMove(se, { clientX: 500, clientY: 400, pointerId: 2 });
  write(JSON.stringify({ ...fixture, clips: fixture.clips.map((c) => (c.id === 'c2' ? { ...c, at: 9 } : c)) }));
  act(() => reload());
  await waitFor(() => expect(clip('c2').style.left).toContain(String(9 * Number(clip('c2').closest('[data-timeline]')!.getAttribute('data-pps')))));
  fireEvent.pointerUp(se, { clientX: 500, clientY: 400, pointerId: 2 });
  await elapse(SAVE_DELAY + 300);
  expect(clipOnDisk('c2')!.at).toBe(9);
  expect(clipOnDisk('c1')!).not.toHaveProperty('place');
});

it('Escape in the Files tree is the tree\'s, even with a clip selected', async () => {
  const { clip } = await show();
  const tree = document.createElement('aside');
  tree.id = 'tree-sheet';
  const row = document.createElement('button');
  tree.append(row);
  document.body.append(tree);
  try {
    fireEvent.pointerDown(clip('c2'), { clientX: 10, button: 0, pointerId: 1 });
    fireEvent.pointerUp(clip('c2'), { clientX: 10, pointerId: 1 });
    row.focus();
    const ev = createEvent.keyDown(row, { key: 'Escape', code: 'Escape' });
    fireEvent(row, ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(clip('c2')).toHaveAttribute('data-selected');
  } finally {
    tree.remove();
  }
});

it('the track toggles are in the UI language', async () => {
  setLang('ru');
  const { container } = await show();
  const head = container.querySelector('[data-track-head="v1"]')!;
  const label = (name: string) => head.querySelector(`[aria-label="${name}"]`)!.textContent;
  expect(label('Заглушить')).toBe('М');
  expect(label('Соло')).toBe('С');
  expect(label('Скрыть изображение дорожки')).toBe('Скр');
});

// the clip's sound on the timeline (issue 431): the gain line, the fade handles, the waveform
const tall = (el: HTMLElement, h: number) => {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: h, right: 400, bottom: h, x: 0, y: 0, toJSON() {} });
};
const vdrag = (el: Element, from: number, to: number, opts: Record<string, unknown> = {}) => {
  fireEvent.pointerDown(el, { clientX: 0, clientY: from, button: 0, pointerId: 1, ...opts });
  fireEvent.pointerMove(el, { clientX: 0, clientY: to, pointerId: 1, ...opts });
  fireEvent.pointerUp(el, { clientX: 0, clientY: to, pointerId: 1, ...opts });
};

it('the gain line: dragged up the clip is louder, the dB shows meanwhile; Shift moves it in fine steps; an undo takes it back', async () => {
  const { clip, container } = await show();
  tall(clip('c3'), 40);
  const line = container.querySelector('[data-clip="c3"] [data-gain]')!;
  expect(line).toHaveAttribute('title', expect.stringMatching(/gain/i));
  fireEvent.pointerDown(line, { clientX: 0, clientY: 100, button: 0, pointerId: 1 });
  fireEvent.pointerMove(line, { clientX: 0, clientY: 96, pointerId: 1 });
  const shown = container.querySelector('[data-clip="c3"] [data-gain-value]')!;
  expect(shown.textContent).toMatch(/^\+\d+(\.5)? dB$/);
  fireEvent.pointerUp(line, { clientX: 0, clientY: 96, pointerId: 1 });
  expect(container.querySelector('[data-gain-value]')).toBeNull();
  await saved(() => expect(clipOnDisk('c3')!.gain).toBeGreaterThan(0));
  const coarse = clipOnDisk('c3')!.gain!;
  expect(Number.isInteger(coarse * 2)).toBe(true);
  valid();
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(clipOnDisk('c3')).not.toHaveProperty('gain'));
  vdrag(container.querySelector('[data-clip="c3"] [data-gain]')!, 100, 96, { shiftKey: true });
  await saved(() => expect(clipOnDisk('c3')!.gain).toBeGreaterThan(0));
  expect(clipOnDisk('c3')!.gain!).toBeLessThan(coarse);
  // down by a lot: the line's floor
  vdrag(container.querySelector('[data-clip="c3"] [data-gain]')!, 0, 400);
  await saved(() => expect(clipOnDisk('c3')!.gain).toBe(-60));
  valid();
});

it('the fade handles at the top corners: dragged inward they set the fades, which never add up past the clip', async () => {
  const { container, pps } = await show();
  const p = pps();
  const handle = (edge: string) => container.querySelector(`[data-clip="c3"] [data-fade="${edge}"]`)!;
  expect(handle('in')).toHaveAttribute('title', expect.stringMatching(/fade/i));
  drag(handle('in'), 100, 100 + 1.5 * p);
  await saved(() => expect(clipOnDisk('c3')!.fadeIn).toBe(1.5));
  drag(handle('out'), 100, 100 - 2 * p);
  await saved(() => expect(clipOnDisk('c3')!.fadeOut).toBe(2));
  // the slopes are drawn
  expect(container.querySelectorAll('[data-clip="c3"] [data-fade-slope]')).toHaveLength(2);
  drag(handle('in'), 100, 100 + 50 * p); // 8 s long, 2 s of fade-out
  await saved(() => expect(clipOnDisk('c3')!.fadeIn).toBe(6));
  drag(handle('in'), 100, 100 - 50 * p);
  await saved(() => expect(clipOnDisk('c3')).not.toHaveProperty('fadeIn'));
  valid();
  // a video clip's fades too (they fade its picture)
  drag(container.querySelector('[data-clip="c1"] [data-fade="in"]')!, 100, 100 + p);
  await saved(() => expect(clipOnDisk('c1')!.fadeIn).toBe(1));
});

it('a gain or fade drag that an outside change overtook is dropped: the agent\'s version stays', async () => {
  const { clip, container, reload } = await show();
  tall(clip('c3'), 40);
  const line = container.querySelector('[data-clip="c3"] [data-gain]')!;
  fireEvent.pointerDown(line, { clientX: 0, clientY: 100, button: 0, pointerId: 1 });
  fireEvent.pointerMove(line, { clientX: 0, clientY: 90, pointerId: 1 });
  write(JSON.stringify({ ...fixture, clips: fixture.clips.map((c) => (c.id === 'c1' ? { ...c, at: 1 } : c)) }));
  act(() => reload());
  await waitFor(() => expect(clip('c1').style.left).not.toBe('0px'));
  fireEvent.pointerUp(line, { clientX: 0, clientY: 90, pointerId: 1 });
  await elapse(SAVE_DELAY + 300);
  expect(clipOnDisk('c1')!.at).toBe(1);
  expect(clipOnDisk('c3')).not.toHaveProperty('gain');
});

it('a clip with sound draws its waveform once in view; a photo has no gain line', async () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  const drawn: number[] = [];
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { clearRect() {}, fillRect: (_x: number, _y: number, _w: number, h: number) => void drawn.push(h), set fillStyle(_v: string) {}, setTransform() {} } as unknown as CanvasRenderingContext2D;
  } as never);
  try {
    write(JSON.stringify({ ...fixture, tracks: [...fixture.tracks, { id: 'v2', kind: 'video' }], clips: [...fixture.clips, { id: 'p', track: 'v2', src: 'media/logo.png', at: 0, dur: 2 }] }));
    const { container } = await show();
    await waitFor(() => expect(container.querySelector('[data-clip="c3"] canvas[data-wave]')).not.toBeNull());
    expect(drawn.length).toBeGreaterThan(0);
    expect(container.querySelector('[data-clip="p"] [data-gain]')).toBeNull();
    expect(container.querySelector('[data-clip="p"] canvas[data-wave]')).toBeNull();
    expect(container.querySelector('[data-clip="p"] [data-fade="in"]')).not.toBeNull();
  } finally {
    getContext.mockRestore();
  }
});

it('a video without sound has no gain line once that is known; a sideways drag from the gain line moves the clip', async () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  const { container, clip, pps } = await show();
  const p = pps();
  await waitFor(() => expect(container.querySelector('[data-clip="c2"] [data-gain]')).toBeNull());
  expect(container.querySelector('[data-clip="c1"] [data-gain]')).not.toBeNull();
  tall(clip('c3'), 40);
  // the first movement is sideways: a move, not a gain
  drag(container.querySelector('[data-clip="c3"] [data-gain]')!, 100, 100 + 1.5 * p, { altKey: true });
  await saved(() => expect(clipOnDisk('c3')!.at).toBe(1.5));
  expect(clipOnDisk('c3')).not.toHaveProperty('gain');
});

it('a fade handle with no fade sits inside the trim edge: both stay grabbable', async () => {
  const { container } = await show();
  const fin = container.querySelector<HTMLElement>('[data-clip="c3"] [data-fade="in"]')!;
  const fout = container.querySelector<HTMLElement>('[data-clip="c3"] [data-fade="out"]')!;
  expect(fin.style.left).toBe('6px');
  expect(fout.style.right).toBe('6px');
});
