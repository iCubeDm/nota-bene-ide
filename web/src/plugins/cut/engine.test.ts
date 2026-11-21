import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Cut, CutClip } from '@nota-bene/shared/cut';
import { CutPlayer } from './engine.ts';

// jsdom plays no media: an element keeps its own time, paused flag, rate and readiness, and play/pause flip them
type Fake = { t: number; paused: boolean; ready: number; seeking: boolean; seeks: number; duration: number; ended: boolean };
const fakes = new WeakMap<HTMLMediaElement, Fake>();
const fake = (el: HTMLMediaElement) => {
  let f = fakes.get(el);
  if (!f) fakes.set(el, (f = { t: 0, paused: true, ready: 4, seeking: false, seeks: 0, duration: NaN, ended: false }));
  return f;
};
const P = HTMLMediaElement.prototype;
const saved = Object.fromEntries(['currentTime', 'paused', 'readyState', 'seeking', 'duration', 'ended', 'play', 'pause', 'load', 'src'].map((k) => [k, Object.getOwnPropertyDescriptor(P, k)]));

// the Web Audio graph as a record: each gain node's value and the ramps scheduled on it
type Gain = { gain: { value: number; ramps: [string, number, number][] } & Record<string, unknown>; connect: (n: unknown) => void; disconnect: () => void; to?: unknown; tos?: unknown[] };
let gains: Gain[];
let sources: { el: HTMLMediaElement; to?: Gain }[];
let ctxTime: number;
let made: number;
let splitters: { n: number; outs: unknown[] }[];
let analysers: { fftSize: number }[];
let analysed: number[][];
class FakeContext {
  constructor() { made++; }
  destination = { name: 'out' };
  get currentTime() { return ctxTime; }
  createGain(): Gain {
    const ramps: [string, number, number][] = [];
    const g: Gain = {
      gain: {
        value: 1, ramps,
        cancelScheduledValues: () => void ramps.splice(0),
        setValueAtTime: (v: number, at: number) => void ramps.push(['set', v, at]),
        // a smooth change, taken as done at once
        setTargetAtTime: (v: number, at: number) => { ramps.push(['target', v, at]); g.gain.value = v; },
        linearRampToValueAtTime: (v: number, at: number) => void ramps.push(['ramp', v, at]),
      },
      connect: (n) => { g.to = n; (g.tos ??= []).push(n); }, disconnect: () => {},
    };
    gains.push(g);
    return g;
  }
  // the meter's tap (issue 410): a splitter into one analyser a channel, each giving back `analysed`'s samples
  createChannelSplitter(n: number) {
    const sp = { n, outs: [] as unknown[], connect: (a: unknown, i = 0) => void (sp.outs[i] = a), disconnect: () => {} };
    splitters.push(sp);
    return sp;
  }
  createAnalyser() {
    const i = analysers.length;
    const a = { fftSize: 0, connect: () => {}, disconnect: () => {}, getFloatTimeDomainData: (b: Float32Array) => { b.fill(0); b.set(analysed[i] ?? []); } };
    analysers.push(a);
    return a;
  }
  createMediaElementSource(el: HTMLMediaElement) {
    const s: { el: HTMLMediaElement; to?: Gain } = { el };
    sources.push(s);
    return { connect: (n: Gain) => void (s.to = n) };
  }
  state = 'running';
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

let now: number;
let fresh: number;
const loaded = (el: HTMLMediaElement) => { fake(el).ready = 4; };
let frames: (() => void)[];
const step = (ms: number) => { now += ms; const f = frames.splice(0); for (const x of f) x(); };

beforeEach(() => {
  Object.defineProperty(P, 'currentTime', { configurable: true, get(this: HTMLMediaElement) { return fake(this).t; }, set(this: HTMLMediaElement, v: number) { fake(this).t = v; fake(this).seeks++; } });
  Object.defineProperty(P, 'duration', { configurable: true, get(this: HTMLMediaElement) { return fake(this).duration; } });
  Object.defineProperty(P, 'ended', { configurable: true, get(this: HTMLMediaElement) { return fake(this).ended; } });
  Object.defineProperty(P, 'paused', { configurable: true, get(this: HTMLMediaElement) { return fake(this).paused; } });
  Object.defineProperty(P, 'readyState', { configurable: true, get(this: HTMLMediaElement) { return fake(this).ready; } });
  Object.defineProperty(P, 'seeking', { configurable: true, get(this: HTMLMediaElement) { return fake(this).seeking; } });
  P.play = vi.fn(function (this: HTMLMediaElement) { fake(this).paused = false; return Promise.resolve(); });
  P.pause = vi.fn(function (this: HTMLMediaElement) { fake(this).paused = true; });
  P.load = vi.fn();
  // a new file: no data until `loaded` (readyState 0) when `fresh` is 0, at once by default
  fresh = 4;
  const src = saved.src!;
  Object.defineProperty(P, 'src', { configurable: true, get(this: HTMLMediaElement) { return src.get!.call(this); }, set(this: HTMLMediaElement, v: string) { src.set!.call(this, v); fake(this).ready = fresh; } });
  gains = [];
  sources = [];
  splitters = [];
  analysers = [];
  analysed = [];
  made = 0;
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

function setup(c: Cut = cut(), reversed?: (c: CutClip, sound: boolean) => string | null, failed?: (url: string) => boolean) {
  const box = document.createElement('div');
  const p = new CutPlayer({ url: (s) => `/file?path=${s}`, reversed, failed, now: () => now, frame: (f) => frames.push(f), cancel: () => {} });
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

it('a reversed clip (issue 492) plays its reversed copy forwards once it is made; until then it shows and sounds nothing', () => {
  const c = cut();
  c.clips[1]!.reverse = true; // c2: 5..9, the source's 10..14 backwards
  let copy: string | null = null;
  const asked: [string, boolean][] = [];
  const lost: string[] = [];
  const { p, layer, shown } = setup(c, (x, sound) => (asked.push([x.id, sound]), x.id === 'c2' ? copy : null), (u) => (lost.push(u), true));
  p.seek(4.9);
  // not preloaded while it is being made
  expect([...layer('v1').querySelectorAll('video')].map((v) => v.getAttribute('src'))).not.toContain('/file?path=.nota-bene/reverse/x.mp4');
  p.seek(6.5);
  expect(shown('v1')).toEqual([]);
  copy = '/file?path=.nota-bene/reverse/x.mp4';
  p.setCut(c);
  const [v] = shown('v1');
  expect(v!.getAttribute('src')).toBe(copy);
  expect(v!.currentTime).toBe(1.5);
  expect(asked.every(([, sound]) => !sound)).toBe(true); // a video track: picture and sound
  // the copy removed under the page: told, so it is asked for again; made again under the same URL, it is loaded again
  const sets: string[] = [];
  const own = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!;
  Object.defineProperty(v!, 'src', { configurable: true, get: () => own.get!.call(v), set: (x: string) => { sets.push(x); own.set!.call(v, x); } });
  v!.dispatchEvent(new Event('error'));
  expect(lost).toEqual([copy]);
  p.setCut(c);
  expect(sets).toEqual([copy]);
  // a source of its own that fails is no copy: not loaded again and again
  const plain = setup(cut(), undefined, () => false);
  plain.p.seek(1);
  const [w] = plain.shown('v1');
  const again: string[] = [];
  Object.defineProperty(w!, 'src', { configurable: true, get: () => own.get!.call(w), set: (x: string) => { again.push(x); own.set!.call(w, x); } });
  w!.dispatchEvent(new Event('error'));
  plain.p.seek(1.2);
  expect(again).toEqual([]);
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
});

it('a video clip\'s fades fade its layer (issue 431): from black on the lowest track, over the tracks below on an upper one', () => {
  const c = cut();
  c.clips[0]!.fadeIn = 1; // c1 on v1, 0..5
  c.clips[2]!.fadeOut = 1; // p1 on v2, 1..4, opacity 0.5
  const { p, layer } = setup(c);
  p.seek(0);
  expect(layer('v1').style.opacity).toBe('0');
  p.seek(0.5);
  expect(Number(layer('v1').style.opacity)).toBeCloseTo(0.5);
  p.seek(2);
  expect(layer('v1').style.opacity).toBe('1');
  expect(layer('v2').style.opacity).toBe('0.5');
  p.seek(3.5);
  expect(Number(layer('v2').style.opacity)).toBeCloseTo(0.25);
});

it('nothing on any track is a black frame', () => {
  const late = cut();
  for (const c of late.clips) c.at += 2;
  const { p, box } = setup(late);
  p.seek(1);
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
  expect(p.state()).toMatchObject({ playing: false, t: 8.96 }); // on the last frame, not past the end (black)
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
  // the muted music's elements load nothing (issue 429), their track gain is 0
  const music = audios.filter((s) => !s.el.hasAttribute('src'));
  expect(music).toHaveLength(2);
  expect(trackGain(music[0]!.el).gain.value).toBe(0);
  expect(trackGain(box.querySelector('video')!).gain.value).toBe(1);
  // the voice (+6 dB) fades in over 1 s from its start and out over its last 2 s, on the audio clock
  const ramps = voice.to!.gain.ramps.map(([k, v, at]) => [k, +v.toFixed(3), +(at - 100).toFixed(3)]);
  const l = +(10 ** (6 / 20)).toFixed(3);
  // from where the gain was, 10 ms to the fade's level (no click), the fades, and silence from the clip's end on
  expect(ramps).toEqual([['set', 1, 0], ['ramp', 0, 0.01], ['ramp', l, 1], ['ramp', l, 3.5], ['ramp', 0, 5.5], ['set', 0, 5.5]]);
  // track levels change smoothly too
  expect(trackGain(voice.el).gain.ramps[0]![0]).toBe('target');
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
  expect(p.state()).toMatchObject({ playing: false, duration: 12, ready: false });
  expect(p.time()).toBeCloseTo(12 - 1 / 30); // the last frame
  p.play();
  expect(p.state().playing).toBe(false);
  expect(box.children).toHaveLength(0);
});

it('a paused frame catches up once a seek finishes: a fast scrub does not leave a stale picture', () => {
  const { p, shown } = setup();
  p.seek(1);
  const v = shown('v1')[0]!;
  fake(v).seeking = true; // still on its way to 3
  p.seek(2);
  expect(v.currentTime).toBe(3);
  fake(v).seeking = false;
  v.dispatchEvent(new Event('seeked'));
  expect(v.currentTime).toBe(4);
});

it('an edit of the file while playing keeps the elements: no reload, no seek, no swap', () => {
  const { p, shown } = setup();
  p.seek(2);
  p.play();
  step(500);
  const v = shown('v1')[0]!;
  v.currentTime = 2 + p.time(); // on time
  const seeks = fake(v).seeks;
  const edited = cut();
  edited.clips[4]!.fadeOut = 1; // the voice's fade, nothing about the picture
  p.setCut(edited);
  step(16);
  expect(shown('v1')).toEqual([v]);
  expect(v.getAttribute('src')).toBe('/file?path=media/a.mp4');
  expect(fake(v).seeks).toBe(seeks);
  // a clip whose source part moved is looked up again
  const moved = cut();
  moved.clips[0]!.in = 1;
  p.setCut(moved);
  expect(v.currentTime).toBeCloseTo(1 + p.time(), 6);
});

it('a clip whose out runs past the end of its file holds the last frame, never restarting it from 0', () => {
  const { p, shown } = setup();
  p.seek(1);
  const v = shown('v1')[0]!;
  fake(v).duration = 4; // the file is 4 s; c1 asks for 2..7
  p.play();
  step(2500); // the clock wants 5.5
  fake(v).paused = true;
  fake(v).ended = true;
  fake(v).t = 4;
  const plays = (P.play as ReturnType<typeof vi.fn>).mock.calls.length;
  step(16);
  step(16);
  expect(v.paused).toBe(true);
  expect(v.currentTime).toBe(4);
  expect((P.play as ReturnType<typeof vi.fn>).mock.calls.length).toBe(plays);
});

it('the clock holds while the clip in view is seeking, and runs on when it is ready', () => {
  const { p, shown } = setup();
  p.seek(1);
  p.play();
  step(16);
  const v = shown('v1')[0]!;
  fake(v).seeking = true;
  step(16);
  const held = p.time();
  step(1000);
  expect(p.time()).toBe(held);
  expect(p.state().playing).toBe(true);
  fake(v).seeking = false;
  step(16);
  step(500);
  expect(p.time()).toBeCloseTo(held + 0.5, 2);
});

it('a hidden browser tab pauses playback (no frames run there, the elements would play past their clips)', () => {
  const { p } = setup();
  p.play();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
  delete (document as { hidden?: boolean }).hidden;
  expect(p.state().playing).toBe(false);
});

it('an edit that turns invalid while playing pauses; a hidden tab suspends the sound', () => {
  const { p } = setup();
  p.play();
  p.setCut(null, 9);
  expect(p.state().playing).toBe(false);
  p.setCut(cut());
  p.play();
  const ctx = sources.length ? (p as unknown as { ctx: FakeContext }).ctx : null;
  p.setLive(false);
  expect(ctx?.state).toBe('suspended');
});

it('the first play hands the gain to Web Audio at full element volume: a fade-in at the playhead does not leave it silent (issue 429)', () => {
  // before the first play there is no audio graph: a paused step sets the element's own volume to the fade's 0 at t = 0
  const c: Cut = { version: 1, width: 1280, height: 720, fps: 25, tracks: [{ id: 'a1', kind: 'audio' }], clips: [{ id: 'm1', track: 'a1', src: 'media/music.mp3', at: 0, out: 9, gain: -14, fadeIn: 0.6 }] };
  const { p } = setup(c);
  const el = () => sources.find((s) => s.el.getAttribute('src') === '/file?path=media/music.mp3')!.el;
  p.play();
  expect(el().paused).toBe(false);
  expect(el().volume).toBe(1); // the clip gain node carries the fade and the −14 dB, once
  step(16);
  expect(el().volume).toBe(1);
});

it('a track that adds nothing loads nothing: a hidden and muted video track, a muted audio track (issue 429)', () => {
  const c = cut();
  c.tracks[2] = { id: 'v3', kind: 'video', hidden: true, mute: true };
  const { p, layer } = setup(c);
  const srcs = (id: string) => [...layer(id).querySelectorAll('video')].map((v) => v.getAttribute('src'));
  p.seek(1.5);
  p.play();
  step(16);
  expect(srcs('v3')).toEqual([null, null]);
  expect(sources.filter((s) => s.el instanceof HTMLAudioElement && s.el.getAttribute('src') === '/file?path=media/music.mp3')).toHaveLength(0);
  expect(srcs('v1')).toContain('/file?path=media/a.mp4');
});

// the music a2 of cut() unmuted or soloed away, and its elements' state
const music = () => sources.filter((s) => s.el instanceof HTMLAudioElement && s.el.getAttribute('src') === '/file?path=media/music.mp3').map((s) => s.el);
const playingEls = () => sources.map((s) => s.el).filter((el) => el.hasAttribute('src') && !el.paused);

it('unmuted while playing, a track loads its clip on the run: the clock and the other tracks do not wait for it (issue 429)', () => {
  const { p } = setup();
  p.seek(1.5);
  p.play();
  step(16);
  const before = playingEls();
  expect(before.length).toBeGreaterThan(0);
  fresh = 0; // the music's file has no data yet
  const on = cut();
  on.tracks[4] = { id: 'a2', kind: 'audio' };
  p.setCut(on);
  const t = p.time();
  step(100);
  expect(p.time()).toBeCloseTo(t + 0.1, 3); // no hold
  for (const el of before) expect(el.paused).toBe(false);
  expect(music()).toHaveLength(1);
  expect(music()[0]!.readyState).toBe(0);
  loaded(music()[0]!);
  step(16);
  expect(music()[0]!.paused).toBe(false);
  // a play after a pause waits for every track again (the music is ready: no hold)
  p.pause();
  p.play();
  step(100);
  expect(p.state().playing).toBe(true);
});

it('a solo cleared while playing: the tracks it silenced since a pause join without holding the clock (issue 429)', () => {
  const c = cut();
  c.tracks[3] = { id: 'a1', kind: 'audio', solo: true };
  c.tracks[4] = { id: 'a2', kind: 'audio' }; // silenced by a1's solo
  const { p } = setup(c);
  p.seek(1.5);
  expect(music()).toHaveLength(0); // paused: a silent track lets go
  p.play();
  step(16);
  const before = playingEls();
  fresh = 0;
  const off = structuredClone(c);
  off.tracks[3] = { id: 'a1', kind: 'audio' };
  p.setCut(off);
  const t = p.time();
  step(100);
  expect(p.time()).toBeCloseTo(t + 0.1, 3);
  for (const el of before) expect(el.paused).toBe(false);
  expect(music()).toHaveLength(1);
});

it('muted while playing, a track goes quiet through its gain and keeps playing; it lets go of its file at the next pause (issue 429)', () => {
  const on = cut();
  on.tracks[4] = { id: 'a2', kind: 'audio' };
  const { p } = setup(on);
  p.seek(1.5);
  p.play();
  step(16);
  const [el] = music();
  expect(el!.paused).toBe(false);
  p.setCut(cut()); // a2 muted again
  step(16);
  expect(el!.paused).toBe(false);
  const trackGain = sources.find((s) => s.el === el)!.to!.to as Gain;
  expect(trackGain.gain.ramps.at(-1)).toEqual(['target', 0, ctxTime]); // a 10 ms ease to silence, not a cut
  p.pause();
  expect(music()).toHaveLength(0);
  expect(el!.hasAttribute('src')).toBe(false);
});

it('in a gap the element already holding the next clip keeps it: the other does not load the same file (issue 429)', () => {
  const c: Cut = { version: 1, width: 1280, height: 720, fps: 25, tracks: [{ id: 'a1', kind: 'audio' }], clips: [
    { id: 'x', track: 'a1', src: 'media/x.mp3', at: 0, out: 2 },
    { id: 'y', track: 'a1', src: 'media/y.mp3', at: 5, out: 2 },
  ] };
  const { p } = setup(c);
  p.seek(1);
  p.seek(3);
  p.play();
  const els = sources.map((s) => s.el.getAttribute('src'));
  expect(els.filter((x) => x === '/file?path=media/y.mp3')).toHaveLength(1);
});

it('the master meter (issue 410): no audio graph before the first play, then each channel\'s sample peak after the master', () => {
  const { p } = setup();
  p.seek(1);
  expect(p.meterPeaks()).toBeNull();
  expect(made).toBe(0); // the meter makes no AudioContext of its own
  p.play();
  expect(made).toBe(1);
  expect(splitters).toHaveLength(1);
  expect(splitters[0]!.outs).toEqual(analysers);
  // the tap hangs off the master: its input up-mixes a mono mix to both sides
  const tap = gains.find((g) => g.to === splitters[0]) as Gain & { channelCount?: number; channelInterpretation?: string };
  expect(gains[0]!.tos).toEqual([{ name: 'out' }, tap]);
  expect(tap.channelCount).toBe(2);
  expect((tap as { channelCountMode?: string }).channelCountMode).toBe('explicit');
  expect(tap.channelInterpretation).toBe('speakers');
  // 16384 samples: a third of a second at 48 kHz, longer than two frames at 30 Hz even at 96 kHz
  expect(analysers.map((a) => a.fftSize)).toEqual([16384, 16384]);
  analysed = [[0.1, -0.5, 0.2], [1.25]];
  expect(p.meterPeaks()).toEqual([0.5, 1.25]);
  // a suspended context (a hidden tab) holds its last samples: the meter reads nothing from it
  p.setLive(false);
  expect(p.meterPeaks()).toBeNull();
});
