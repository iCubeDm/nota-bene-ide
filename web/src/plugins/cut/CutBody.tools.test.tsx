import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SAVE_DELAY } from './useCutDoc.ts';
import { clipOnDisk, drag, elapse, fixture, onDisk, saved, setupCut, show, valid, write } from './testCut.tsx';

vi.mock('./thumbs.ts', () => ({ poster: vi.fn(async () => null) }));
vi.mock('./durations.ts', () => ({ srcLength: vi.fn(async () => 4) }));
vi.mock('./peaks.ts', () => ({
  peaksOf: vi.fn(async (src: string) => (src === 'media/street.webm' ? { none: 'no-audio' } : { peaks: new Uint8Array(800).fill(128) })),
}));

setupCut();

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
  // icons (issue 463): the short name and the key are the tooltip and the accessible name
  const sel = screen.getByRole('button', { name: 'Select (V)' });
  const blade = screen.getByRole('button', { name: 'Blade (C)' });
  for (const b of [sel, blade]) {
    expect(b.querySelector('svg')).not.toBeNull();
    expect(b.textContent).toBe('');
    expect(b.title).toBe(b.getAttribute('aria-label'));
  }
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
  await elapse(SAVE_DELAY + 300);
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

it('the add-track buttons sit in the track column: "+ Video" above the video tracks, "+ Audio" after the audio ones (issue 490)', async () => {
  const { container } = await show();
  expect(container.querySelector('[data-cut-tools] [aria-label="Add a video track"]')).toBeNull();
  const rows = [...container.querySelectorAll('[data-lane], [data-track-add]')].map((e) => e.getAttribute('data-lane') ?? `+${e.getAttribute('data-track-add')}`);
  expect(rows).toEqual(['+video', 'v1', 'a1', '+audio']);
  const video = screen.getByRole('button', { name: 'Add a video track' });
  expect(video.textContent).toBe('+ Video');
  expect(video.closest('[data-track-add]')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add an audio track' }));
  await saved(() => expect(onDisk().tracks.map((t) => t.id)).toEqual(['v1', 'a1', 'a2']));
  fireEvent.click(video);
  await saved(() => expect(onDisk().tracks.map((t) => t.id)).toEqual(['v1', 'a1', 'a2', 'v2']));
  await waitFor(() => expect([...container.querySelectorAll('[data-lane], [data-track-add]')].map((e) => e.getAttribute('data-lane') ?? `+${e.getAttribute('data-track-add')}`))
    .toEqual(['+video', 'v2', 'v1', 'a1', 'a2', '+audio']));
});

// review follow-ups (issue 432)
it('a rectangle keeps its start in the timeline when the view scrolls under it', async () => {
  const { pps, container } = await show();
  const p = pps();
  stack(container);
  const ruler = container.querySelector<HTMLElement>('[data-ruler]')!;
  const at = (left: number) => { ruler.getBoundingClientRect = () => ({ left, top: 0, width: 1000, height: 24, right: left + 1000, bottom: 24, x: left, y: 0, toJSON() {} }); };
  at(0);
  const body = container.querySelector('[data-lane-body="v1"]')!;
  fireEvent.pointerDown(body, { clientX: 4.5 * p, clientY: 10, button: 0, pointerId: 2 });
  fireEvent.pointerMove(body, { clientX: 5.5 * p, clientY: 80, pointerId: 2 });
  expect(selected(container)).toEqual(['c3']);
  // the view scrolls 2 s to the right with the pointer still: it is over 7.5 s now, the start stays at 4.5 s
  at(-2 * p);
  fireEvent.scroll(container.querySelector('[data-timeline-scroll]')!);
  expect(selected(container)).toEqual(['c2', 'c3']);
  fireEvent.pointerUp(body, { clientX: 5.5 * p, clientY: 80, pointerId: 2 });
  expect(container.querySelector('[data-marquee]')).toBeNull();
});

it('a Shift-click or Cmd-press on a trim edge or a fade handle adds or removes the clip, and trims nothing', async () => {
  const { clip, container } = await show();
  press(clip('c1'), 10);
  const part = (id: string, sel: string) => container.querySelector(`[data-clip="${id}"] ${sel}`)!;
  press(part('c3', '[data-trim="end"]'), 100, { shiftKey: true });
  expect(selected(container)).toEqual(['c1', 'c3']);
  press(part('c3', '[data-fade="in"]'), 10, { metaKey: true });
  expect(selected(container)).toEqual(['c1']);
  press(part('c2', '[data-trim="start"]'), 10, { ctrlKey: true });
  expect(selected(container)).toEqual(['c1', 'c2']);
  await elapse(SAVE_DELAY + 300);
  expect(onDisk()).toEqual(fixture); // nothing trimmed
});

it('ids gone from the edit leave the selection: after an undo and after an outside reload', async () => {
  const { clip, container, reload } = await show();
  press(clip('c2'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  fireEvent.click(screen.getByRole('button', { name: /^Duplicate/ }));
  await saved(() => expect(onDisk().clips).toHaveLength(5));
  const copies = selected(container);
  expect(copies).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(onDisk().clips).toHaveLength(3));
  // redo brings the same ids back: they are no longer selected
  fireEvent.click(screen.getByRole('button', { name: /^Redo/ }));
  await saved(() => expect(onDisk().clips).toHaveLength(5));
  expect(selected(container)).toEqual([]);
  // an outside version without c2, then with it again
  await elapse(SAVE_DELAY + 300);
  press(clip('c1'), 10);
  press(clip('c2'), 10, { shiftKey: true });
  write(JSON.stringify({ ...fixture, clips: fixture.clips.filter((c) => c.id !== 'c2') }));
  act(() => reload());
  await waitFor(() => expect(container.querySelector('[data-clip="c2"]')).toBeNull());
  write(JSON.stringify(fixture));
  act(() => reload());
  await waitFor(() => expect(container.querySelector('[data-clip="c2"]')).not.toBeNull());
  expect(selected(container)).toEqual(['c1']);
});

it('V, C and Delete typed into a field of the clip panel stay in the field', async () => {
  const { clip, container } = await show();
  press(clip('c1'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  const gain = screen.getByRole('spinbutton', { name: 'Gain, dB' });
  gain.focus();
  for (const code of ['KeyC', 'KeyV', 'Delete', 'Backspace']) fireEvent.keyDown(gain, { code, key: code });
  expect(screen.getByRole('button', { name: /^Select/ })).toHaveAttribute('aria-pressed', 'true');
  expect(selected(container)).toEqual(['c1', 'c3']);
  await elapse(SAVE_DELAY + 300);
  expect(onDisk().clips).toHaveLength(3);
});

it('mute on several clips: indeterminate while they differ, then on for all', async () => {
  write(JSON.stringify({ ...fixture, clips: fixture.clips.map((c) => (c.id === 'c1' ? { ...c, mute: true } : c)) }));
  const { clip } = await show();
  press(clip('c1'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  const mute = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Mute its sound' });
  expect(mute.indeterminate).toBe(true);
  expect(mute.checked).toBe(false);
  fireEvent.click(mute);
  await saved(() => expect([clipOnDisk('c1')!.mute, clipOnDisk('c3')!.mute]).toEqual([true, true]));
  await waitFor(() => expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Mute its sound' }).indeterminate).toBe(false));
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Mute its sound' }).checked).toBe(true);
});

it('reverse on several clips (issue 492): indeterminate while they differ, then on for all, one undo step', async () => {
  write(JSON.stringify({ ...fixture, clips: fixture.clips.map((c) => (c.id === 'c1' ? { ...c, reverse: true } : c)) }));
  const { clip } = await show();
  press(clip('c1'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  const box = () => screen.getByRole<HTMLInputElement>('checkbox', { name: 'Reverse' });
  expect(box().indeterminate).toBe(true);
  fireEvent.click(box());
  await saved(() => expect([clipOnDisk('c1')!.reverse, clipOnDisk('c3')!.reverse]).toEqual([true, true]));
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect([clipOnDisk('c1')!.reverse, clipOnDisk('c3')!.reverse]).toEqual([true, undefined]));
});

// Shift on a clip: it moves with everything after it on its track, its end edge ripples (issue 437)
it('a Shift drag on a clip moves it and the later clips of its track as one step, the selection kept; left, it stops at the clip before', async () => {
  const { clip, pps, container } = await show();
  const p = pps();
  press(clip('c3'), 10);
  drag(clip('c1'), 100, 100 + p, { shiftKey: true, altKey: true });
  expect(selected(container)).toEqual(['c3']);
  await saved(() => expect(clipOnDisk('c1')!.at).toBe(1));
  expect(clipOnDisk('c2')!.at).toBe(7);
  expect(clipOnDisk('c3')).toMatchObject({ track: 'a1', at: 0 });
  valid();
  // c2 3 s left: it stops at the end of c1 (now 1..5); c1 stays
  drag(clip('c2'), 100, 100 - 3 * p, { shiftKey: true, altKey: true });
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(5));
  expect(clipOnDisk('c1')!.at).toBe(1);
  // one undo per drag
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(7));
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(clipOnDisk('c1')!.at).toBe(0));
  expect(clipOnDisk('c2')!.at).toBe(6);
});

it('a Shift drag stays on its track, and the pressed clip snaps unless Alt is held', async () => {
  const { clip, pps, container } = await show();
  stack(container);
  const p = pps();
  // to the audio lane and 2 s on, 3 px short of c3's end (8 s): it snaps there, on v1
  fireEvent.pointerDown(clip('c2'), { clientX: 100, clientY: 10, button: 0, pointerId: 1, shiftKey: true });
  fireEvent.pointerMove(clip('c2'), { clientX: 100 + 2 * p - 3, clientY: 80, pointerId: 1, shiftKey: true });
  fireEvent.pointerUp(clip('c2'), { clientX: 100 + 2 * p - 3, clientY: 80, pointerId: 1, shiftKey: true });
  await saved(() => expect(clipOnDisk('c2')).toMatchObject({ track: 'v1', at: 8 }));
  drag(clip('c2'), 100, 100 + 3, { shiftKey: true, altKey: true });
  await saved(() => expect(clipOnDisk('c2')!.at).toBeCloseTo(8 + 3 / p, 3));
});

it('a Shift-click on a clip, no drag, adds or removes it on release', async () => {
  const { clip, container } = await show();
  press(clip('c1'), 10);
  fireEvent.pointerDown(clip('c2'), { clientX: 10, clientY: 0, button: 0, pointerId: 1, shiftKey: true });
  expect(selected(container)).toEqual(['c1']);
  fireEvent.pointerUp(clip('c2'), { clientX: 10, clientY: 0, pointerId: 1, shiftKey: true });
  expect(selected(container)).toEqual(['c1', 'c2']);
  press(clip('c1'), 10, { shiftKey: true });
  expect(selected(container)).toEqual(['c2']);
  await elapse(SAVE_DELAY + 300);
  expect(onDisk()).toEqual(fixture); // nothing moved
});

it('a Shift drag on the end edge ripples the later clips of the track; on the start edge it is a plain trim', async () => {
  const { pps, container } = await show();
  const p = pps();
  const part = (id: string, sel: string) => container.querySelector(`[data-clip="${id}"] ${sel}`)!;
  drag(part('c1', '[data-trim="end"]'), 100, 100 - p, { shiftKey: true, altKey: true });
  await saved(() => expect(clipOnDisk('c1')!.out).toBe(3));
  expect(clipOnDisk('c2')!.at).toBe(5); // the 2 s gap kept
  expect(clipOnDisk('c3')!.at).toBe(0);
  expect(selected(container)).toEqual([]);
  valid();
  drag(part('c1', '[data-trim="start"]'), 100, 100 + p, { shiftKey: true, altKey: true });
  await saved(() => expect(clipOnDisk('c1')).toMatchObject({ at: 1, in: 1, out: 3 }));
  expect(clipOnDisk('c2')!.at).toBe(5);
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(onDisk()).toEqual(fixture));
});

it('a Shift drag sideways from the gain line moves the clip with what follows it, the selection kept', async () => {
  const { clip, pps, container } = await show();
  const p = pps();
  press(clip('c3'), 10);
  drag(container.querySelector('[data-clip="c1"] [data-gain]')!, 100, 100 + p, { shiftKey: true, altKey: true });
  expect(selected(container)).toEqual(['c3']);
  await saved(() => expect(clipOnDisk('c1')!.at).toBe(1));
  expect(clipOnDisk('c2')!.at).toBe(7);
  expect(clipOnDisk('c3')!.at).toBe(0);
});

it('a Shift drag up or down on a clip is a drag: it moves nothing and leaves the selection as it was', async () => {
  const { clip, container } = await show();
  press(clip('c3'), 10);
  fireEvent.pointerDown(clip('c1'), { clientX: 100, clientY: 0, button: 0, pointerId: 1, shiftKey: true });
  fireEvent.pointerMove(clip('c1'), { clientX: 100, clientY: 20, pointerId: 1, shiftKey: true });
  fireEvent.pointerUp(clip('c1'), { clientX: 100, clientY: 20, pointerId: 1, shiftKey: true });
  expect(selected(container)).toEqual(['c3']);
  await elapse(SAVE_DELAY + 300);
  expect(onDisk()).toEqual(fixture);
});

it('a Shift drag does not snap to the old edges of the clips that move with it', async () => {
  const { clip, pps } = await show();
  const p = pps();
  // c1's end 3 px short of c2's start (6 s): c2 moves too, so nothing is there to snap to
  drag(clip('c1'), 100, 100 + 2 * p - 3, { shiftKey: true });
  await saved(() => expect(clipOnDisk('c1')!.at).toBeCloseTo(2 - 3 / p, 3));
  expect(clipOnDisk('c2')!.at).toBeCloseTo(8 - 3 / p, 3);
});

it('a Shift drag on a clip of a selection moves it and the clips after it alone; the selection stays', async () => {
  const { clip, pps, container } = await show();
  const p = pps();
  press(clip('c1'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  expect(selected(container)).toEqual(['c1', 'c3']);
  drag(clip('c1'), 100, 100 + p, { shiftKey: true, altKey: true });
  await saved(() => expect(clipOnDisk('c1')!.at).toBe(1));
  expect(clipOnDisk('c2')!.at).toBe(7);
  expect(clipOnDisk('c3')!.at).toBe(0);
  expect(selected(container)).toEqual(['c1', 'c3']);
});

it('a Cmd- or Ctrl-press on the body or an edge still adds or removes the clip on the press', async () => {
  const { clip, container } = await show();
  press(clip('c1'), 10);
  fireEvent.pointerDown(clip('c2'), { clientX: 10, clientY: 0, button: 0, pointerId: 1, metaKey: true });
  expect(selected(container)).toEqual(['c1', 'c2']);
  fireEvent.pointerUp(clip('c2'), { clientX: 10, clientY: 0, pointerId: 1, metaKey: true });
  fireEvent.pointerDown(container.querySelector('[data-clip="c1"] [data-trim="end"]')!, { clientX: 10, clientY: 0, button: 0, pointerId: 1, ctrlKey: true });
  expect(selected(container)).toEqual(['c2']);
  fireEvent.pointerUp(container.querySelector('[data-clip="c1"] [data-trim="end"]')!, { clientX: 10, clientY: 0, pointerId: 1, ctrlKey: true });
  expect(selected(container)).toEqual(['c2']);
});

// leftovers from the review of issue 432 (issue 442)
it('a rectangle can start in the track column and on the add-track rows; the header controls still act, no rectangle', async () => {
  const { pps, container } = await show();
  const p = pps();
  stack(container);
  // the lanes start after the 144 px track column
  const ruler = container.querySelector<HTMLElement>('[data-ruler]')!;
  ruler.getBoundingClientRect = () => ({ left: 144, top: 0, width: 1000, height: 24, right: 1144, bottom: 24, x: 144, y: 0, toJSON() {} });
  // from the audio track's header into its lane: the voice clip only
  const head = container.querySelector('[data-track-head="a1"]')!;
  fireEvent.pointerDown(head, { clientX: 60, clientY: 70, button: 0, pointerId: 2 });
  fireEvent.pointerMove(head, { clientX: 144 + p, clientY: 80, pointerId: 2 });
  expect(container.querySelector('[data-marquee]')).not.toBeNull();
  fireEvent.pointerUp(head, { clientX: 144 + p, clientY: 80, pointerId: 2 });
  expect(selected(container)).toEqual(['c3']);
  // from the "+ Video" row (above the video lanes, issue 490) down over the clips of both tracks
  const add = container.querySelector('[data-track-add="video"]')!;
  fireEvent.pointerDown(add, { clientX: 300, clientY: 0, button: 0, pointerId: 2 });
  fireEvent.pointerMove(add, { clientX: 144 + 7 * p, clientY: 90, pointerId: 2 });
  fireEvent.pointerUp(add, { clientX: 144 + 7 * p, clientY: 90, pointerId: 2 });
  expect(selected(container)).toEqual(['c1', 'c2', 'c3']);
  // the row for a new track by a drop, too (Shift adds nothing new here: all are in)
  const dropRow = container.querySelector('[data-cut-drop]')!;
  fireEvent.pointerDown(dropRow, { clientX: 300, clientY: 140, button: 0, pointerId: 2, shiftKey: true });
  fireEvent.pointerMove(dropRow, { clientX: 320, clientY: 60, pointerId: 2, shiftKey: true });
  expect(container.querySelector('[data-marquee]')).not.toBeNull();
  fireEvent.pointerUp(dropRow, { clientX: 320, clientY: 60, pointerId: 2, shiftKey: true });
  expect(selected(container)).toEqual(['c1', 'c2', 'c3']);
  // a press on a header's control, its name or an add-track button starts no rectangle, and the selection stays
  const controls = [
    screen.getAllByRole('button', { name: 'Mute' })[0]!, screen.getAllByRole('button', { name: 'Move the track up' })[0]!,
    container.querySelector('[data-track-name]')!, screen.getByRole('button', { name: 'Add a video track' }),
  ];
  for (const el of controls) {
    fireEvent.pointerDown(el, { clientX: 60, clientY: 10, button: 0, pointerId: 2 });
    fireEvent.pointerMove(el, { clientX: 144 + 3 * p, clientY: 80, pointerId: 2 });
    expect(container.querySelector('[data-marquee]')).toBeNull();
    fireEvent.pointerUp(el, { clientX: 144 + 3 * p, clientY: 80, pointerId: 2 });
  }
  expect(selected(container)).toEqual(['c1', 'c2', 'c3']);
  // and they still act: mute, rename
  fireEvent.click(screen.getAllByRole('button', { name: 'Mute' })[0]!);
  await saved(() => expect(onDisk().tracks.find((x) => x.id === 'v1')!.mute).toBe(true));
  fireEvent.doubleClick(container.querySelector('[data-track-name]')!);
  expect(screen.getByRole('textbox', { name: 'Track name' })).toBeInTheDocument();
});

it('a refused group nudge or drag says why in the edit bar; the next change clears it', async () => {
  // c1 ends where c2 starts: c1 cannot go later
  write(JSON.stringify({ ...fixture, clips: fixture.clips.map((c) => (c.id === 'c2' ? { ...c, at: 4 } : c)) }));
  const { clip, pps, container } = await show();
  const p = pps();
  const note = () => container.querySelector('[data-cut-tools] [role="status"]')?.textContent ?? '';
  press(clip('c1'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  key('ArrowRight');
  expect(note()).toMatch(/would overlap/);
  await elapse(SAVE_DELAY + 300);
  expect(clipOnDisk('c1')!.at).toBe(0);
  // a move that goes through takes the note away
  press(clip('c2'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  key('ArrowRight');
  expect(note()).toBe('');
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(4.04));
  // a group drag onto c2: refused, the note says so
  press(clip('c1'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  drag(clip('c1'), 100, 100 + 2 * p, { altKey: true });
  expect(note()).toMatch(/would overlap/);
  expect(clipOnDisk('c1')!.at).toBe(0);
  // dragged onto a track of the other kind: there is none of their kind there
  stack(container);
  fireEvent.pointerDown(clip('c1'), { clientX: 100, clientY: 10, button: 0, pointerId: 1, altKey: true });
  fireEvent.pointerMove(clip('c1'), { clientX: 100, clientY: 80, pointerId: 1, altKey: true });
  fireEvent.pointerUp(clip('c1'), { clientX: 100, clientY: 80, pointerId: 1, altKey: true });
  expect(note()).toMatch(/no track of their kind/);
});

it('several video clips: position, size and opacity for all of them, mixed where they differ, one undo step; audio ignored', async () => {
  const half = { x: 0.5, y: 0, w: 0.5, h: 0.5, opacity: 0.5 };
  const clips = [...fixture.clips.map((c) => (c.id === 'c2' ? { ...c, place: half } : c)), { id: 'c4', track: 'a1', src: 'media/voice.wav', at: 9, out: 2 }];
  write(JSON.stringify({ ...fixture, clips }));
  const { clip } = await show();
  press(clip('c1'), 10);
  press(clip('c2'), 10, { shiftKey: true });
  press(clip('c3'), 10, { shiftKey: true });
  const field = (name: string) => screen.getByRole('spinbutton', { name });
  expect(field('X, %')).toHaveValue(null);
  expect(field('X, %')).toHaveAttribute('placeholder', 'mixed');
  expect(field('Y, %')).toHaveValue(0);
  expect(field('Width, %')).toHaveAttribute('placeholder', 'mixed');
  expect(field('Opacity, %')).toHaveAttribute('placeholder', 'mixed');
  fireEvent.change(field('X, %'), { target: { value: '10' } });
  fireEvent.blur(field('X, %'));
  await saved(() => expect([clipOnDisk('c1')!.place?.x, clipOnDisk('c2')!.place?.x]).toEqual([0.1, 0.1]));
  // each keeps the rest of its own frame; the audio clip has none
  expect(clipOnDisk('c2')!.place).toEqual({ ...half, x: 0.1 });
  expect(clipOnDisk('c1')!.place).toMatchObject({ x: 0.1, y: 0, w: 1, h: 1 });
  expect(clipOnDisk('c3')).not.toHaveProperty('place');
  valid();
  // a value the format refuses for any of them is applied to none
  fireEvent.change(field('Width, %'), { target: { value: '0' } });
  fireEvent.blur(field('Width, %'));
  expect(field('Width, %')).toHaveAttribute('aria-invalid', 'true');
  // one undo takes the X back on both
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await saved(() => expect(clipOnDisk('c2')!.place).toEqual(half));
  expect(clipOnDisk('c1')).not.toHaveProperty('place');
  // no video clip in the selection: no frame fields
  press(clip('c3'), 10);
  press(clip('c4'), 10, { shiftKey: true });
  expect(screen.getByRole('spinbutton', { name: 'Gain, dB' })).toBeInTheDocument();
  expect(screen.queryByRole('spinbutton', { name: 'X, %' })).toBeNull();
  expect(screen.queryByRole('spinbutton', { name: 'Opacity, %' })).toBeNull();
});

// the review of issue 442
it('a rectangle from the track column on a scrolled timeline starts at the lanes in view, not under the headers', async () => {
  // a clip at 0..1 s, scrolled out of view under the headers
  const clips = [...fixture.clips.filter((c) => c.id !== 'c3'), { id: 'c3', track: 'a1', src: 'media/voice.wav', at: 0, out: 1 }, { id: 'c4', track: 'a1', src: 'media/voice.wav', at: 3, out: 2 }];
  write(JSON.stringify({ ...fixture, clips }));
  const { pps, container } = await show();
  const p = pps();
  stack(container);
  // scrolled 2 s: the lanes in view start at 2 s, at x 144
  const scroller = container.querySelector<HTMLElement>('[data-timeline-scroll]')!;
  Object.defineProperty(scroller, 'scrollLeft', { configurable: true, value: 2 * p });
  const ruler = container.querySelector<HTMLElement>('[data-ruler]')!;
  const left = 144 - 2 * p;
  ruler.getBoundingClientRect = () => ({ left, top: 0, width: 1000, height: 24, right: left + 1000, bottom: 24, x: left, y: 0, toJSON() {} });
  const head = container.querySelector('[data-track-head="a1"]')!;
  fireEvent.pointerDown(head, { clientX: 20, clientY: 70, button: 0, pointerId: 2 });
  fireEvent.pointerMove(head, { clientX: 144 + 1.5 * p, clientY: 80, pointerId: 2 });
  // the box starts where the lanes do in view (2 s from 0, plus the column)
  expect(container.querySelector<HTMLElement>('[data-marquee]')!.style.left).toBe(`${144 + 2 * p}px`);
  fireEvent.pointerUp(head, { clientX: 144 + 1.5 * p, clientY: 80, pointerId: 2 });
  expect(selected(container)).toEqual(['c4']);
});

it('the refusal note goes when the same drag reaches a place that is allowed, and on undo and redo', async () => {
  write(JSON.stringify({ ...fixture, clips: fixture.clips.map((c) => (c.id === 'c2' ? { ...c, at: 4 } : c.id === 'c3' ? { ...c, at: 2 } : c)) }));
  const { clip, pps, container } = await show();
  const p = pps();
  const note = () => container.querySelector('[data-cut-tools] [role="status"]')?.textContent ?? '';
  press(clip('c2'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  // left onto c1 (refused), then further right (allowed): the note goes while still dragging
  fireEvent.pointerDown(clip('c2'), { clientX: 200, clientY: 0, button: 0, pointerId: 1, altKey: true });
  fireEvent.pointerMove(clip('c2'), { clientX: 200 - p, clientY: 0, pointerId: 1, altKey: true });
  expect(note()).toMatch(/would overlap/);
  fireEvent.pointerMove(clip('c2'), { clientX: 200 + p, clientY: 0, pointerId: 1, altKey: true });
  expect(note()).toBe('');
  fireEvent.pointerUp(clip('c2'), { clientX: 200 + p, clientY: 0, pointerId: 1, altKey: true });
  await saved(() => expect(clipOnDisk('c2')!.at).toBe(5));
  // refused again, then undo: the note goes
  press(clip('c1'), 10);
  press(clip('c3'), 10, { shiftKey: true });
  key('ArrowRight', { shiftKey: true });
  key('ArrowRight', { shiftKey: true });
  key('ArrowRight', { shiftKey: true });
  expect(note()).toMatch(/would overlap/);
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  expect(note()).toBe('');
  await saved(() => expect(clipOnDisk('c1')!.at).toBe(0.4));
  // a drag of 2 s onto c2 is refused and commits nothing: redo is still there, and takes the note away too
  drag(clip('c1'), 100, 100 + 2 * p, { altKey: true });
  expect(note()).toMatch(/would overlap/);
  fireEvent.click(screen.getByRole('button', { name: /^Redo/ }));
  expect(note()).toBe('');
});

it('frame values the same in percent are not mixed', async () => {
  const clips = fixture.clips.map((c) => (c.id === 'c1' ? { ...c, place: { x: 0.333, y: 0, w: 0.5, h: 0.5 } } : c.id === 'c2' ? { ...c, place: { x: 0.33299999999999996, y: 0, w: 0.5, h: 0.5 } } : c));
  write(JSON.stringify({ ...fixture, clips }));
  const { clip } = await show();
  press(clip('c1'), 10);
  press(clip('c2'), 10, { shiftKey: true });
  expect(screen.getByRole('spinbutton', { name: 'X, %' })).toHaveValue(33.3);
});
