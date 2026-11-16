import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import type { CutPlayer, PlayerState } from './engine.ts';
import { Meter } from './Meter.tsx';

// a player that plays when told and hands out the peaks the test sets; frames run when the test says
let frames: Map<number, FrameRequestCallback>;
let nextId: number;
let clock: number;
const run = (ms: number) => act(() => {
  clock += ms;
  const f = [...frames.values()];
  frames.clear();
  for (const x of f) x(clock);
});

function stub(peaks: [number, number] | null) {
  let snap: PlayerState = { t: 0, playing: false, duration: 10, ready: true, seeks: 0 };
  const subs = new Set<() => void>();
  const p = {
    peaks,
    subscribe: (f: () => void) => { subs.add(f); return () => void subs.delete(f); },
    state: () => snap,
    meterPeaks: () => p.peaks,
    set(playing: boolean) { snap = { ...snap, playing }; act(() => { for (const f of subs) f(); }); },
  };
  return p;
}

beforeEach(() => {
  setLang('en');
  frames = new Map();
  nextId = 0;
  clock = 0;
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.set(++nextId, f); return nextId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => void frames.delete(id));
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const covers = () => [...document.querySelectorAll<HTMLElement>('[data-meter-cover]')].map((e) => e.style.width);
const clipLight = () => document.querySelector<HTMLButtonElement>('[data-cut-meter] button')!;

it('reads the player on animation frames only while playing; paused it rests at the floor', () => {
  const p = stub([0.5, 0.125]);
  render(<Meter player={p as unknown as CutPlayer} />);
  expect(frames.size).toBe(0);
  p.set(true);
  run(16);
  // −6 dB and −18 dB on a −60..0 scale: the covers hide the rest
  expect(covers().map((w) => parseFloat(w))).toEqual([expect.closeTo(10.03, 1), expect.closeTo(30.1, 1)]);
  expect(document.querySelector('[data-meter-readout]')!.textContent).toBe('−6.0');
  expect(frames.size).toBe(1);
  p.set(false);
  expect(frames.size).toBe(0);
  expect(covers()).toEqual(['100%', '100%']);
  expect(document.querySelector('[data-meter-readout]')!.textContent).toBe('−∞');
});

it('a mix at full scale lights the clip until it is clicked, through a pause', () => {
  const p = stub([0.3, 1.02]);
  render(<Meter player={p as unknown as CutPlayer} />);
  expect(clipLight().title).toMatch(/turns red when the mix reaches 0 dBFS/);
  p.set(true);
  run(16);
  expect(clipLight().title).toMatch(/^Clipping.*Click to reset/);
  p.peaks = [0.1, 0.1];
  run(16);
  p.set(false);
  expect(clipLight().hasAttribute('data-meter-clip')).toBe(true);
  fireEvent.click(clipLight());
  expect(clipLight().hasAttribute('data-meter-clip')).toBe(false);
});

it('without an audio graph (no Web Audio) it stays at the floor', () => {
  const p = stub(null);
  render(<Meter player={p as unknown as CutPlayer} />);
  p.set(true);
  run(16);
  run(16);
  expect(covers()).toEqual(['100%', '100%']);
  expect(screen.getByRole('img', { name: /master level/i })).toBeTruthy();
});
