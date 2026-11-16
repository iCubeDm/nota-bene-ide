import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateCut, type Cut } from '@nota-bene/shared/cut';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { CutBody } from './CutBody.tsx';
import { PATH_MIME } from './drag.ts';
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
const press = (el: Element, x: number, opts: Record<string, unknown> = {}) => {
  fireEvent.pointerDown(el, { clientX: x, clientY: 0, button: 0, pointerId: 1, ...opts });
  fireEvent.pointerUp(el, { clientX: x, clientY: 0, pointerId: 1, ...opts });
};
const key = (code: string, opts: Record<string, unknown> = {}) => fireEvent.keyDown(document.body, { code, key: code.replace(/^Key/, '').toLowerCase(), ...opts });
// lanes stacked as drawn: v1 at 0..56 px, a1 at 56..96
const stack = (container: HTMLElement) => {
  let top = 0;
  for (const el of container.querySelectorAll<HTMLElement>('[data-lane-body]')) {
    const t = top, h = el.closest('[data-lane]')!.classList.contains('h-14') ? 56 : 40;
    el.getBoundingClientRect = () => ({ left: 0, top: t, width: 1000, height: h, right: 1000, bottom: t + h, x: 0, y: t, toJSON() {} });
    top += h;
  }
};
const selected = (container: HTMLElement) => [...container.querySelectorAll('[data-clip][data-selected]')].map((e) => e.getAttribute('data-clip'));

// the timeline's tools and selections (issue 432)
it('Select (V) and Blade (C): the toolbar shows the active one, the tooltips name the keys, Esc returns to Select', async () => {
  await show();
  const sel = screen.getByRole('button', { name: /^Select.*\(V\)$/ });
  const blade = screen.getByRole('button', { name: /^Blade.*\(C\)$/ });
  expect(sel).toHaveAttribute('aria-pressed', 'true');
  expect(blade).toHaveAttribute('aria-pressed', 'false');
  key('KeyC');
  expect(blade).toHaveAttribute('aria-pressed', 'true');
  expect(sel).toHaveAttribute('aria-pressed', 'false');
  key('KeyV');
  expect(sel).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(blade);
  expect(blade).toHaveAttribute('aria-pressed', 'true');
  key('Escape');
  expect(sel).toHaveAttribute('aria-pressed', 'true');
});

it('the blade cuts the clip under a click at that point, snapped as edges are; Shift cuts every track there', async () => {
  const { clip, pps, container } = await show();
  const p = pps();
  key('KeyC');
  // hovering a clip shows where the cut would be
  fireEvent.pointerMove(clip('c3'), { clientX: 2.5 * p, clientY: 0, pointerId: 1 });
  const line = container.querySelector<HTMLElement>('[data-lane-body="a1"] [data-blade-line]')!;
  expect(line.style.left).toBe(`${2.5 * p}px`);
  press(clip('c3'), 2.5 * p);
  await saved(() => expect(onDisk().clips.filter((c) => c.src === 'media/voice.wav')).toHaveLength(2));
  expect(clipOnDisk('c3')).toMatchObject({ at: 0, out: 2.5 });
  valid();
  // near c1's end (4) the cut of the right part snaps to it
  const right = onDisk().clips.find((c) => c.src === 'media/voice.wav' && c.at === 2.5)!.id;
  press(clip(right), 4.05 * p);
  await saved(() => expect(onDisk().clips.filter((c) => c.src === 'media/voice.wav')).toHaveLength(3));
  expect(onDisk().clips.filter((c) => c.src === 'media/voice.wav').map((c) => c.at).sort()).toEqual([0, 2.5, 4]);
  // Shift: c2 (6..10) and the voice from 4 to 8, both at 7
  press(clip('c2'), 7 * p, { shiftKey: true });
  await saved(() => expect(onDisk().clips).toHaveLength(7));
  expect(onDisk().clips.filter((c) => c.at === 7).map((c) => c.track).sort()).toEqual(['a1', 'v1']);
  valid();
  // undo takes one cut back at a time
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(onDisk().clips).toHaveLength(5));
});

it('Shift- and Cmd/Ctrl-click add or remove a clip; a rectangle on empty space selects what it touches, Shift adds', async () => {
  const { clip, pps, container } = await show();
  const p = pps();
  press(clip('c1'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  expect(selected(container)).toEqual(['c1', 'c3']);
  press(clip('c2'), 10, { metaKey: true });
  expect(selected(container)).toEqual(['c1', 'c2', 'c3']);
  press(clip('c1'), 10, { ctrlKey: true });
  expect(selected(container)).toEqual(['c2', 'c3']);
  // the panel counts them
  expect(container.querySelector('[data-cut-inspector]')!.textContent).toMatch(/2 clips/);
  stack(container);
  // empty space on v1 (4..6 s) to the audio lane: c3 and the gap only, c1 and c2 untouched
  const body = container.querySelector('[data-lane-body="v1"]')!;
  fireEvent.pointerDown(body, { clientX: 4.5 * p, clientY: 10, button: 0, pointerId: 2 });
  fireEvent.pointerMove(body, { clientX: 5.5 * p, clientY: 80, pointerId: 2 });
  expect(container.querySelector('[data-marquee]')).not.toBeNull();
  fireEvent.pointerUp(body, { clientX: 5.5 * p, clientY: 80, pointerId: 2 });
  expect(container.querySelector('[data-marquee]')).toBeNull();
  expect(selected(container)).toEqual(['c3']);
  // Shift adds: from 5 s on v1 over c2
  fireEvent.pointerDown(body, { clientX: 5 * p, clientY: 10, button: 0, pointerId: 2, shiftKey: true });
  fireEvent.pointerMove(body, { clientX: 7 * p, clientY: 20, pointerId: 2, shiftKey: true });
  fireEvent.pointerUp(body, { clientX: 7 * p, clientY: 20, pointerId: 2, shiftKey: true });
  expect(selected(container)).toEqual(['c2', 'c3']);
  // a click on empty space lets them go
  press(body, 5 * p);
  expect(selected(container)).toEqual([]);
});

it('a selection moves together, keeping its times and tracks, as one step; a move that would overlap is refused', async () => {
  const { clip, pps, container } = await show();
  const p = pps();
  press(clip('c2'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  drag(clip('c2'), 100, 100 + p, { altKey: true });
  expect(selected(container)).toEqual(['c2', 'c3']);
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(7));
  expect(clipOnDisk('c3')).toMatchObject({ track: 'a1', at: 1 });
  valid();
  // c1 and c3 3.5 s later: c1 would sit over c2 (now 7..11); they show back where they were and nothing changes
  press(clip('c1'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  fireEvent.pointerDown(clip('c1'), { clientX: 100, clientY: 0, button: 0, pointerId: 1, altKey: true });
  fireEvent.pointerMove(clip('c1'), { clientX: 100 + 3.5 * p, clientY: 0, pointerId: 1, altKey: true });
  expect(clip('c1').style.left).toBe('0px');
  expect(clip('c3').style.left).toBe(`${p}px`);
  fireEvent.pointerUp(clip('c1'), { clientX: 100 + 3.5 * p, clientY: 0, pointerId: 1, altKey: true });
  await new Promise((r) => setTimeout(r, SAVE_DELAY + 300));
  expect(clipOnDisk('c1')!.at).toBe(0);
  expect(clipOnDisk('c3')!.at).toBe(1);
  // one undo takes the whole move back
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(6));
  expect(clipOnDisk('c3')!.at).toBe(0);
  // a click on one of them, no drag, selects it alone
  press(clip('c3'), 10);
  expect(selected(container)).toEqual(['c3']);
});

it('Delete, the nudges and Duplicate act on the whole selection', async () => {
  const { clip, container } = await show();
  press(clip('c2'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  key('ArrowRight');
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(6.04));
  expect(clipOnDisk('c3')!.at).toBe(0.04);
  fireEvent.click(screen.getByRole('button', { name: /^Duplicate/ }));
  await saved(() => expect(onDisk().clips).toHaveLength(5));
  // the span 0.04..10.04 again from 10.04, their spacing kept; the copies are selected
  const copies = onDisk().clips.filter((c) => !['c1', 'c2', 'c3'].includes(c.id)).map((c) => [c.src, c.at]);
  expect(copies.sort()).toEqual([['media/street.webm', 16.04], ['media/voice.wav', 10.04]]);
  expect(selected(container)).toHaveLength(2);
  expect(selected(container)).not.toContain('c2');
  valid();
  key('Delete');
  await saved(() => expect(onDisk().clips.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']));
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(onDisk().clips).toHaveLength(5));
});

it('the clip panel with several clips: the count, a shared field set on all, a mixed one shown as mixed', async () => {
  write(JSON.stringify({ ...fixture, clips: fixture.clips.map((c) => (c.id === 'c3' ? { ...c, gain: -6 } : c)) }));
  const { clip, container } = await show();
  press(clip('c1'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  const panel = container.querySelector<HTMLElement>('[data-cut-inspector]')!;
  expect(panel.textContent).toMatch(/2 clips/);
  const gain = screen.getByRole('spinbutton', { name: 'Gain, dB' });
  expect(gain).toHaveValue(null);
  expect(gain).toHaveAttribute('placeholder', 'mixed');
  expect(screen.getByRole('spinbutton', { name: 'Fade in, s' })).toHaveValue(0);
  fireEvent.change(gain, { target: { value: '-3' } });
  fireEvent.blur(gain);
  await saved(() => expect([clipOnDisk('c1')!.gain, clipOnDisk('c3')!.gain]).toEqual([-3, -3]));
  const fade = screen.getByRole('spinbutton', { name: 'Fade out, s' });
  fireEvent.change(fade, { target: { value: '5' } }); // c1 is 4 s long
  fireEvent.blur(fade);
  expect(fade).toHaveAttribute('aria-invalid', 'true');
  expect(clipOnDisk('c3')).not.toHaveProperty('fadeOut');
  const mute = screen.getByRole('checkbox', { name: 'Mute its sound' });
  fireEvent.click(mute);
  await saved(() => expect([clipOnDisk('c1')!.mute, clipOnDisk('c3')!.mute]).toEqual([true, true]));
  valid();
});

it('a Shift- or Cmd-click on the gain line (the middle of a clip) adds or removes the clip; a Shift drag there is still fine gain', async () => {
  const { clip, container } = await show();
  press(clip('c1'), 10);
  const line = (id: string) => container.querySelector(`[data-clip="${id}"] [data-gain]`)!;
  press(line('c3'), 10, { shiftKey: true });
  expect(selected(container)).toEqual(['c1', 'c3']);
  press(line('c1'), 10, { metaKey: true });
  expect(selected(container)).toEqual(['c3']);
  press(line('c1'), 10, { shiftKey: true });
  expect(selected(container)).toEqual(['c1', 'c3']);
  // a plain click on the line of one of them: that clip alone, as on its body
  press(line('c3'), 10);
  expect(selected(container)).toEqual(['c3']);
});

it('the gain line acts on the clip under the pointer, the selection stays', async () => {
  const { clip, container } = await show();
  press(clip('c1'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  clip('c3').getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 40, right: 400, bottom: 40, x: 0, y: 0, toJSON() {} });
  const line = container.querySelector('[data-clip="c3"] [data-gain]')!;
  fireEvent.pointerDown(line, { clientX: 0, clientY: 100, button: 0, pointerId: 1 });
  fireEvent.pointerMove(line, { clientX: 0, clientY: 90, pointerId: 1 });
  fireEvent.pointerUp(line, { clientX: 0, clientY: 90, pointerId: 1 });
  await saved(() => expect(clipOnDisk('c3')!.gain).toBeGreaterThan(0));
  expect(clipOnDisk('c1')).not.toHaveProperty('gain');
  expect(selected(container)).toEqual(['c1', 'c3']);
});

it('the add-track buttons sit in the track column: "+ Video" after the video tracks, "+ Audio" after the audio ones', async () => {
  const { container } = await show();
  expect(container.querySelector('[data-cut-tools] [aria-label="Add a video track"]')).toBeNull();
  const rows = [...container.querySelectorAll('[data-lane], [data-track-add]')].map((e) => e.getAttribute('data-lane') ?? `+${e.getAttribute('data-track-add')}`);
  expect(rows).toEqual(['v1', '+video', 'a1', '+audio']);
  const video = screen.getByRole('button', { name: 'Add a video track' });
  expect(video.textContent).toBe('+ Video');
  expect(video.closest('[data-track-add]')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add an audio track' }));
  await saved(() => expect(onDisk().tracks.map((t) => t.id)).toEqual(['v1', 'a1', 'a2']));
  fireEvent.click(video);
  await saved(() => expect(onDisk().tracks.map((t) => t.id)).toEqual(['v1', 'a1', 'a2', 'v2']));
  await waitFor(() => expect([...container.querySelectorAll('[data-lane], [data-track-add]')].map((e) => e.getAttribute('data-lane') ?? `+${e.getAttribute('data-track-add')}`))
    .toEqual(['v2', 'v1', '+video', 'a1', 'a2', '+audio']));
});
