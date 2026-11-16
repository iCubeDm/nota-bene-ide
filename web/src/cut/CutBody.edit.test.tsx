import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateCut, type Cut } from '@nota-bene/shared/cut';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { CutBody } from './CutBody.tsx';
import { PATH_MIME } from './drag.ts';
import { FLASH_MS } from './changes.ts';
import { SAVE_DELAY } from './useCutDoc.ts';

vi.mock('./thumbs.ts', () => ({ poster: vi.fn(async () => null) }));
vi.mock('./durations.ts', () => ({ srcLength: vi.fn(async () => 4) }));
vi.mock('./peaks.ts', () => ({
  peaksOf: vi.fn(async (src: string) => (src === 'media/street.webm' ? { none: 'no-audio' } : { peaks: new Uint8Array(800).fill(128) })),
}));

const fixture = {
  version: 1, width: 1280, height: 720, fps: 25,
  tracks: [{ id: 'v1', kind: 'video', name: 'Main' }, { id: 'a1', kind: 'audio', name: 'Voice' }],
  clips: [
    { id: 'c1', track: 'v1', src: 'media/intro.mp4', at: 0, out: 4 },
    { id: 'c2', track: 'v1', src: 'media/street.webm', at: 6, out: 4 },
    { id: 'c3', track: 'a1', src: 'media/voice.wav', at: 0, out: 8 },
  ],
};

let disk: { text: string; base: string };
let ver: number;
const write = (text: string) => void (disk = { text, base: `b${++ver}` });
const onDisk = () => JSON.parse(disk.text) as Cut;
const clipOnDisk = (id: string) => onDisk().clips.find((c) => c.id === id);
beforeEach(() => {
  setLang('en');
  ver = 0;
  write(JSON.stringify(fixture));
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-timeline-scroll') ? 1160 : 0; },
  });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} takeRecords() { return []; } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/cut/export?')) return Response.json({ ffmpeg: true, job: null });
    if (!url.startsWith('/edit')) return new Response(null, { status: 200 });
    if (init?.method !== 'POST') return Response.json(disk);
    const b = JSON.parse(init.body as string) as { text: string; base: string | null };
    if (b.base !== null && b.base !== disk.base) return Response.json({ error: 'changed' }, { status: 409 });
    write(b.text);
    return Response.json({ base: disk.base });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth; });

async function show() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const ui = (text: string) => <Provider store={store}><CutBody text={text} src="here" path="e.nbcut.json" tabId="file:e.nbcut.json" active /></Provider>;
  const r = render(ui(disk.text));
  await waitFor(() => expect(r.container.querySelector('[data-cut-tools]')).not.toBeNull());
  const pps = () => Number(r.container.querySelector('[data-timeline]')!.getAttribute('data-pps'));
  const clip = (id: string) => r.container.querySelector<HTMLElement>(`[data-clip="${id}"]`)!;
  return { ...r, pps, clip, reload: () => r.rerender(ui(disk.text)) };
}
const saved = (f: () => void) => waitFor(f, { timeout: SAVE_DELAY + 1500 });
const valid = () => expect(validateCut(onDisk()).ok).toBe(true);
const drag = (el: Element, from: number, to: number, opts: Record<string, unknown> = {}) => {
  fireEvent.pointerDown(el, { clientX: from, clientY: 0, button: 0, pointerId: 1, ...opts });
  fireEvent.pointerMove(el, { clientX: to, clientY: 0, pointerId: 1, ...opts });
  fireEvent.pointerUp(el, { clientX: to, clientY: 0, pointerId: 1, ...opts });
};

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
  fireEvent.click(container.querySelector('[data-track-head="a1"] [aria-label="Mute the track"]')!);
  await saved(() => expect(onDisk().tracks[1]).toMatchObject({ mute: true }));
  // v1 down under v2 in the picture: before it in the file
  fireEvent.click(container.querySelector('[data-track-head="v2"] [aria-label="Move the track down"]')!);
  await saved(() => expect(onDisk().tracks.map((t) => t.id)).toEqual(['v2', 'a1', 'v1']));
  fireEvent.click(container.querySelector('[data-track-head="a1"] [aria-label="Remove the track and its clips"]')!);
  await saved(() => expect(onDisk().tracks.map((t) => t.id)).toEqual(['v2', 'v1']));
  expect(onDisk().clips.map((c) => c.id)).toEqual(['c1', 'c2']);
  valid();
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

it('the agent\'s change is highlighted for a moment (issue 412): changed and added clips, a ghost where a removed one was', async () => {
  const { container, clip, reload } = await show();
  write(JSON.stringify({
    ...fixture,
    clips: [
      { ...fixture.clips[0]!, out: 3 }, // trimmed
      fixture.clips[2]!, // as it was
      { id: 'c9', track: 'a1', src: 'media/music.wav', at: 8, out: 2 }, // added
    ], // c2 removed
  }));
  act(() => reload());
  await waitFor(() => expect(clip('c9')).toHaveAttribute('data-changed'));
  expect(clip('c1')).toHaveAttribute('data-changed');
  expect(clip('c3')).not.toHaveAttribute('data-changed');
  const ghost = container.querySelector<HTMLElement>('[data-lane-body="v1"] [data-removed-clip="c2"]')!;
  expect(ghost).not.toBeNull();
  expect(ghost).toHaveAttribute('title', expect.stringContaining('media/street.webm'));
  // it fades and is gone after a moment
  await waitFor(() => expect(container.querySelector('[data-changed], [data-removed-clip]')).toBeNull(), { timeout: FLASH_MS + 1500 });
});

it('our own edit is not highlighted, nor the edit as first opened', async () => {
  const { container, clip, pps, reload } = await show();
  expect(container.querySelector('[data-changed]')).toBeNull();
  drag(clip('c2'), 100, 100 + 1.5 * pps(), { altKey: true });
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(7.5));
  act(() => reload()); // the file view reads our own save back
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(container.querySelector('[data-changed], [data-removed-clip]')).toBeNull();
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
  await new Promise((r) => setTimeout(r, SAVE_DELAY + 300));
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
  await new Promise((r) => setTimeout(r, SAVE_DELAY + 300));
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
  expect(label('Выключить звук дорожки')).toBe('М');
  expect(label('Соло: звучат только дорожки соло')).toBe('С');
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
  await new Promise((r) => setTimeout(r, SAVE_DELAY + 300));
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
