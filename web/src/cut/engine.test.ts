import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Cut } from '@nota-bene/shared/cut';
import { CutPlayer } from './engine.ts';

// jsdom plays no media: an element keeps its own time, paused flag, rate and readiness, and play/pause flip them
type Fake = { t: number; paused: boolean; ready: number; seeking: boolean };
const fakes = new WeakMap<HTMLMediaElement, Fake>();
const fake = (el: HTMLMediaElement) => {
  let f = fakes.get(el);
  if (!f) fakes.set(el, (f = { t: 0, paused: true, ready: 4, seeking: false }));
  return f;
};
const P = HTMLMediaElement.prototype;
const saved = Object.fromEntries(['currentTime', 'paused', 'readyState', 'seeking', 'play', 'pause', 'load'].map((k) => [k, Object.getOwnPropertyDescriptor(P, k)]));

// the Web Audio graph as a record: each gain node's value and the ramps scheduled on it
type Gain = { gain: { value: number; ramps: [string, number, number][] } & Record<string, unknown>; connect: (n: unknown) => void; disconnect: () => void; to?: unknown };
let gains: Gain[];
let sources: { el: HTMLMediaElement; to?: Gain }[];
let ctxTime: number;
class FakeContext {
  destination = { name: 'out' };
  get currentTime() { return ctxTime; }
  createGain(): Gain {
    const ramps: [string, number, number][] = [];
    const g: Gain = {
      gain: {
        value: 1, ramps,
        cancelScheduledValues: () => void ramps.splice(0),
        setValueAtTime: (v: number, at: number) => void ramps.push(['set', v, at]),
        linearRampToValueAtTime: (v: number, at: number) => void ramps.push(['ramp', v, at]),
      },
      connect: (n) => void (g.to = n), disconnect: () => {},
    };
    gains.push(g);
    return g;
  }
  createMediaElementSource(el: HTMLMediaElement) {
    const s: { el: HTMLMediaElement; to?: Gain } = { el };
    sources.push(s);
    return { connect: (n: Gain) => void (s.to = n) };
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

let now: number;
let frames: (() => void)[];
const step = (ms: number) => { now += ms; const f = frames.splice(0); for (const x of f) x(); };

beforeEach(() => {
  Object.defineProperty(P, 'currentTime', { configurable: true, get(this: HTMLMediaElement) { return fake(this).t; }, set(this: HTMLMediaElement, v: number) { fake(this).t = v; } });
  Object.defineProperty(P, 'paused', { configurable: true, get(this: HTMLMediaElement) { return fake(this).paused; } });
  Object.defineProperty(P, 'readyState', { configurable: true, get(this: HTMLMediaElement) { return fake(this).ready; } });
  Object.defineProperty(P, 'seeking', { configurable: true, get(this: HTMLMediaElement) { return fake(this).seeking; } });
  P.play = vi.fn(function (this: HTMLMediaElement) { fake(this).paused = false; return Promise.resolve(); });
  P.pause = vi.fn(function (this: HTMLMediaElement) { fake(this).paused = true; });
  P.load = vi.fn();
  gains = [];
  sources = [];
  ctxTime = 100;
  vi.stubGlobal('AudioContext', FakeContext);
  now = 0;
  frames = [];
});
afterEach(() => {
  for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(P, k, d);
  vi.unstubAllGlobals();
});

// a main video in two clips of one file, a photo over it, a hidden camera, a voice with fades and a muted music
const cut = (): Cut => ({
  version: 1, width: 1280, height: 720, fps: 25,
  tracks: [
    { id: 'v1', kind: 'video' },
    { id: 'v2', kind: 'video' },
    { id: 'v3', kind: 'video', hidden: true },
    { id: 'a1', kind: 'audio', gain: -6 },
    { id: 'a2', kind: 'audio', mute: true },
  ],
  clips: [
    { id: 'c1', track: 'v1', src: 'media/a.mp4', at: 0, in: 2, out: 7 },
    { id: 'c2', track: 'v1', src: 'media/a.mp4', at: 5, in: 10, out: 14 },
    { id: 'p1', track: 'v2', src: 'media/logo.png', at: 1, dur: 3, place: { x: 0.7, y: 0.05, w: 0.25, h: 0.2, opacity: 0.5 } },
    { id: 'c3', track: 'v3', src: 'media/b.mov', at: 0, out: 9 },
    { id: 's1', track: 'a1', src: 'media/voice.wav', at: 0.5, out: 5.5, gain: 6, fadeIn: 1, fadeOut: 2 },
    { id: 's2', track: 'a1', src: 'media/voice2.wav', at: 8, out: 1 },
    { id: 'm1', track: 'a2', src: 'media/music.mp3', at: 0, in: 10, out: 19 },
  ],
});

function setup(c: Cut = cut()) {
  const box = document.createElement('div');
  const p = new CutPlayer({ url: (s) => `/file?path=${s}`, now: () => now, frame: (f) => frames.push(f), cancel: () => {} });
  p.setCut(c);
  p.attach(box);
  p.setLive(true);
  const layer = (id: string) => box.querySelector<HTMLDivElement>(`[data-cut-layer="${id}"]`)!;
  const shown = (id: string) => [...layer(id).querySelectorAll('video')].filter((v) => v.style.visibility === 'visible');
  return { p, box, layer, shown };
}

it('shows the clip in view at its source time and preloads the next one: two elements per track, not one per clip', () => {
  const { p, box, layer, shown } = setup();
  expect(box.querySelectorAll('video')).toHaveLength(6); // three video tracks
  p.seek(1.5);
  const [v] = shown('v1');
  expect(v!.getAttribute('src')).toBe('/file?path=media/a.mp4');
  expect(v!.currentTime).toBe(3.5);
  const spare = [...layer('v1').querySelectorAll('video')].find((x) => x !== v)!;
  expect(spare.currentTime).toBe(10); // c2 waits at its in-point
  expect(spare.style.visibility).toBe('hidden');
  expect(v!.paused).toBe(true);
});

it('a cut swaps to the preloaded element in the same step; the old one takes the clip after', () => {
  const { p, layer, shown } = setup();
  p.seek(4.9);
  const before = shown('v1')[0]!;
  const spare = [...layer('v1').querySelectorAll('video')].find((x) => x !== before)!;
  p.seek(5);
  expect(shown('v1')).toEqual([spare]);
  expect(spare.currentTime).toBe(10);
  expect(before.style.visibility).toBe('hidden');
});

it('stacks the tracks at their places: a photo with its opacity, a hidden track not drawn, nothing at all is black', () => {
  const { p, box, layer } = setup();
  const order = [...box.children].map((e) => (e as HTMLElement).dataset.cutLayer);
  expect(order).toEqual(['v1', 'v2', 'v3']); // later tracks over earlier ones
  p.seek(2);
  const l2 = layer('v2');
  expect(l2.style.display).toBe('');
  expect([l2.style.left, l2.style.top, l2.style.width, l2.style.height, l2.style.opacity]).toEqual(['70%', '5%', '25%', '20%', '0.5']);
  expect(l2.querySelector('img')!.getAttribute('src')).toBe('/file?path=media/logo.png');
  expect(l2.querySelector('img')!.style.display).toBe('');
  expect(layer('v1').style.width).toBe('100%'); // no place: the whole frame
  expect(layer('v3').style.display).toBe('none');
  p.seek(9.5);
  expect([...box.children].every((e) => (e as HTMLElement).style.display === 'none')).toBe(true);
});

it('plays on one clock: elements follow it, small drift nudges the rate, a big one seeks; it stops at the end', () => {
  const { p, shown } = setup();
  p.play();
  expect(p.state().playing).toBe(true);
  step(1000);
  expect(p.time()).toBeCloseTo(1);
  const v = shown('v1')[0]!;
  expect(v.paused).toBe(false);
  // the element lags 0.1 s: it runs faster to catch up
  v.currentTime = 2.9;
  step(16);
  expect(v.playbackRate).toBeGreaterThan(1);
  v.currentTime = 6; // a second and more ahead
  step(16);
  expect(v.currentTime).toBeCloseTo(2 + p.time(), 6); // a seek lands on the clock's source time (c1 starts at in 2)
  expect(v.playbackRate).toBe(1);
  step(20_000);
  expect(p.state()).toMatchObject({ playing: false, t: 9 });
  expect(v.paused).toBe(true);
});

it('sound: element → clip gain with linear fade ramps → track gain (dB, mute) → master', () => {
  const { p, box } = setup();
  p.seek(0.5);
  p.play(); // the first step is at once, not a frame later
  // a1: −6 dB; a2: muted; v1 (and the hidden v3, whose sound still plays): 0 dB
  const trackGain = (el: HTMLMediaElement) => sources.find((s) => s.el === el)!.to!.to as Gain;
  const audios = sources.filter((s) => s.el instanceof HTMLAudioElement);
  expect(sources).toHaveLength(10); // every element of every track, once
  const voice = audios.find((s) => s.el.getAttribute('src') === '/file?path=media/voice.wav')!;
  expect(trackGain(voice.el).gain.value).toBeCloseTo(0.501, 3);
  const music = audios.find((s) => s.el.getAttribute('src') === '/file?path=media/music.mp3')!;
  expect(trackGain(music.el).gain.value).toBe(0);
  expect(trackGain(box.querySelector('video')!).gain.value).toBe(1);
  // the voice (+6 dB) fades in over 1 s from its start and out over its last 2 s, on the audio clock
  const ramps = voice.to!.gain.ramps.map(([k, v, at]) => [k, +v.toFixed(3), +(at - 100).toFixed(3)]);
  const l = +(10 ** (6 / 20)).toFixed(3);
  expect(ramps).toEqual([['set', 0, 0], ['ramp', l, 1], ['ramp', l, 3.5], ['ramp', 0, 5.5]]);
});

it('scrubbing holds playback with the sound off, then resumes', () => {
  const { p } = setup();
  p.play();
  step(16);
  const master = gains[0]!;
  p.scrub(true);
  expect(p.state().playing).toBe(false);
  expect(master.gain.value).toBe(0);
  p.seek(3);
  p.scrub(false);
  expect(master.gain.value).toBe(1);
  expect(p.state().playing).toBe(true);
  expect(p.time()).toBeCloseTo(3);
});

it('a hidden tab loads nothing and does not play', () => {
  const box = document.createElement('div');
  const p = new CutPlayer({ url: (s) => s, now: () => now, frame: (f) => frames.push(f), cancel: () => {} });
  p.setCut(cut());
  p.attach(box);
  p.seek(2);
  p.play();
  expect(p.state().playing).toBe(false);
  expect([...box.querySelectorAll('video, img')].some((e) => e.hasAttribute('src'))).toBe(false);
  p.setLive(true);
  expect(box.querySelector('video')!.getAttribute('src')).toBe('media/a.mp4');
});

it('an invalid edit: no elements, the clock still seeks over the drawn length', () => {
  const box = document.createElement('div');
  const p = new CutPlayer({ url: (s) => s, now: () => now, frame: (f) => frames.push(f), cancel: () => {} });
  p.setCut(null, 12);
  p.attach(box);
  p.setLive(true);
  p.seek(20);
  expect(p.state()).toMatchObject({ t: 12, playing: false, duration: 12, ready: false });
  p.play();
  expect(p.state().playing).toBe(false);
  expect(box.children).toHaveLength(0);
});
