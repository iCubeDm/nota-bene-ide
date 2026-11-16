import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { CutBody } from './CutBody.tsx';

// a thumbnail is a frame grabbed once into an image (thumbs.test.ts); here, a name for what was asked
vi.mock('./thumbs.ts', () => ({ poster: vi.fn(async (url: string, at: number) => `blob:${url}@${at}`) }));
// the waveforms (peaks.ts) are their own tests' (CutBody.edit.test.tsx): here they ask nothing of the server
vi.mock('./peaks.ts', () => ({ peaksOf: vi.fn(async () => null) }));

// a main video with a photo over it, a voice and a music track
const fixture = {
  version: 1, width: 1280, height: 720, fps: 25,
  tracks: [
    { id: 'v1', kind: 'video', name: 'Main' },
    { id: 'v2', kind: 'video', name: 'Over', hidden: true },
    { id: 'a1', kind: 'audio', name: 'Voice', gain: -3, solo: true },
    { id: 'a2', kind: 'audio', name: 'Music', mute: true },
  ],
  clips: [
    { id: 'c1', track: 'v1', src: 'media/intro.mp4', at: 0, in: 2, out: 7 },
    { id: 'c2', track: 'v1', src: 'media/street.mov', at: 5, out: 4 },
    { id: 'c3', track: 'v2', src: 'media/logo.png', at: 1, dur: 3, place: { x: 0.7, y: 0.05, w: 0.25, h: 0.2 } },
    { id: 'c4', track: 'a1', src: 'media/voice.wav', at: 0.5, out: 6 },
    { id: 'c5', track: 'a2', src: 'media/music.mp3', at: 0, in: 10, out: 19 },
  ],
};

let missing: string[];
let heads: string[];
// jsdom lays nothing out: the timeline's scroller gets a width, and IntersectionObserver is played by the test
let viewW: number;
let observers: { cb: IntersectionObserverCallback; els: Element[] }[];
const seeAll = () => act(() => {
  for (const o of observers) o.cb(o.els.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry), {} as IntersectionObserver);
});
beforeEach(() => {
  setLang('en');
  viewW = 0;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-timeline-scroll') ? viewW : 0; },
  });
  observers = [];
  vi.stubGlobal('IntersectionObserver', class {
    o: { cb: IntersectionObserverCallback; els: Element[] };
    constructor(cb: IntersectionObserverCallback) { this.o = { cb, els: [] }; observers.push(this.o); }
    observe(el: Element) { this.o.els.push(el); }
    disconnect() { this.o.els = []; }
    unobserve() {}
    takeRecords() { return []; }
  });
  missing = [];
  heads = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') heads.push(url);
    const path = new URL(url, 'http://x').searchParams.get('path') ?? '';
    if (url.startsWith('/cut/export?')) return Response.json({ ffmpeg: true, job: null });
    return new Response(null, { status: missing.includes(path) ? 404 : 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth; });

function show(text: string, { path, active = true }: { path?: string; active?: boolean } = {}) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  return render(<Provider store={store}><CutBody text={text} src="here" path={path} tabId="file:e.nbcut.json" active={active} /></Provider>);
}
const lanes = (c: HTMLElement) => [...c.querySelectorAll('[data-lane]')].map((l) => l.getAttribute('data-lane'));

it('draws the tracks top-down, their state, and the clips by time with names and thumbnails', async () => {
  const { container } = show(JSON.stringify(fixture));
  // the upper video track (v2: over the picture) first, then the audio tracks in order
  expect(lanes(container)).toEqual(['v2', 'v1', 'a1', 'a2']);
  const head = (id: string) => container.querySelector(`[data-track-head="${id}"]`)!;
  expect(head('v1').textContent).toContain('Main');
  expect(head('v2').textContent).toContain('hidden');
  expect(head('a1').textContent).toContain('solo');
  expect(head('a1').textContent).toContain('−3 dB');
  expect(head('a2').textContent).toContain('mute');
  expect(screen.getByText('1280×720 · 25 fps')).toBeInTheDocument();

  const clip = (id: string) => container.querySelector<HTMLElement>(`[data-clip="${id}"]`)!;
  expect(clip('c2').textContent).toContain('street.mov');
  // placed by time: c2 starts at 5 s and lasts 4 s, at the zoom's pixels a second
  const pps = Number(container.querySelector('[data-timeline]')!.getAttribute('data-pps'));
  expect(clip('c2').style.left).toBe(`${5 * pps}px`);
  expect(clip('c2').style.width).toBe(`${4 * pps}px`);
  // thumbnails once in sight: the photo itself, a video's first used frame as an image; none for sound
  expect(container.querySelector('[data-timeline] img')).toBeNull();
  seeAll();
  expect(clip('c3').querySelector('img')?.getAttribute('src')).toBe('/file?path=media%2Flogo.png');
  await waitFor(() => expect(clip('c1').querySelector('img')?.getAttribute('src')).toBe('blob:/file?path=media%2Fintro.mp4@2'));
  expect(clip('c4').querySelector('img')).toBeNull();
  expect(container.querySelector('[data-timeline] video')).toBeNull();
  await waitFor(() => expect(heads).toHaveLength(5)); // each source checked once
  expect(screen.queryByText(/problem/)).toBeNull();
});

it('zooms with the buttons and Ctrl+wheel; a click on the ruler sets the playhead', () => {
  const { container } = show(JSON.stringify(fixture));
  const tl = container.querySelector('[data-timeline]')!;
  const pps = () => Number(tl.getAttribute('data-pps'));
  const p0 = pps();
  fireEvent.click(screen.getByRole('button', { name: /^Zoom in/ }));
  expect(pps()).toBeGreaterThan(p0);
  fireEvent.click(screen.getByRole('button', { name: /^Zoom out/ }));
  expect(pps()).toBeCloseTo(p0);
  const scroller = container.querySelector('[data-timeline-scroll]')!;
  fireEvent.wheel(scroller, { deltaY: -100, ctrlKey: true });
  expect(pps()).toBeGreaterThan(p0);
  const p1 = pps();
  fireEvent.wheel(scroller, { deltaY: -100 }); // a plain wheel scrolls, it does not zoom
  expect(pps()).toBe(p1);

  const ruler = container.querySelector('[data-ruler]')!;
  fireEvent.pointerDown(ruler, { clientX: 3 * p1, button: 0 });
  expect(container.querySelector<HTMLElement>('[data-playhead]')!.style.left).toBe(`${3 * p1}px`);
  expect(screen.getByText('0:03.0', { exact: false })).toBeInTheDocument();
});

it('lists problems readably and still draws what it can; a missing source is one of them', async () => {
  const bad = structuredClone(fixture) as typeof fixture & { clips: Record<string, unknown>[] };
  bad.clips[1]!.at = 4; // over c1, which runs 0..5
  bad.clips[3]!.track = 'v9';
  missing = ['media/music.mp3'];
  const { container } = show(JSON.stringify(bad));
  const list = await screen.findByRole('list', { name: /problem/ });
  expect(list.textContent).toContain('clips[1].at');
  expect(list.textContent).toContain('overlaps the clip before it on its track');
  expect(list.textContent).toContain('clips[3].track');
  expect(list.textContent).toContain('no track has this id');
  await waitFor(() => expect(list.textContent).toContain('the file is not in the project'));
  expect(list.textContent).toContain('clips[4].src');
  expect(screen.getByText('3 problems in the edit')).toBeInTheDocument();
  // the overlapping and the missing clip are drawn and marked; the clip on an unknown track cannot be placed
  expect(container.querySelector('[data-clip="c2"]')!.getAttribute('data-bad')).toBe('true');
  expect(container.querySelector('[data-clip="c5"]')!.getAttribute('data-bad')).toBe('true');
  expect(container.querySelector('[data-clip="c1"]')!.getAttribute('data-bad')).toBeNull();
  expect(container.querySelector('[data-clip="c4"]')).toBeNull();
});

it('loads no thumbnail while the tab is not shown', () => {
  const { container } = show(JSON.stringify(fixture), { active: false });
  seeAll();
  expect(container.querySelector('[data-timeline] img, [data-timeline] video')).toBeNull();
  // nor does the preview load its sources
  expect([...container.querySelectorAll('[data-cut-preview] video, [data-cut-preview] img')].some((e) => e.hasAttribute('src'))).toBe(false);
});

const hour = () => ({ ...structuredClone(fixture), clips: [{ id: 'c1', track: 'v1', src: 'media/talk.mp4', at: 0, out: 3600 }] });
const inner = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-timeline-scroll] > div')!;
const scroller = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-timeline-scroll]')!;
const ppsOf = (c: HTMLElement) => Number(c.querySelector('[data-timeline]')!.getAttribute('data-pps'));

it('fit shows the whole edit without a horizontal scrollbar', () => {
  viewW = 1000;
  const { container } = show(JSON.stringify(fixture));
  expect(parseFloat(inner(container).style.width)).toBeLessThanOrEqual(1000);
  fireEvent.click(screen.getByRole('button', { name: /^Zoom in/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Fit the whole edit' }));
  expect(parseFloat(inner(container).style.width)).toBeLessThanOrEqual(1000);
});

it('a very short clip is still drawn 2 px wide', () => {
  const c = structuredClone(fixture);
  c.clips[3] = { id: 'c4', track: 'a1', src: 'media/voice.wav', at: 0.5, out: 0.001 };
  const { container } = show(JSON.stringify(c));
  expect(container.querySelector<HTMLElement>('[data-clip="c4"]')!.style.width).toBe('2px');
});

it('an hour-long edit at the closest zoom: a bounded width, and only the ruler ticks in sight', () => {
  viewW = 1000;
  const { container } = show(JSON.stringify(hour()));
  for (let i = 0; i < 40; i++) fireEvent.wheel(scroller(container), { deltaY: -1000, ctrlKey: true, clientX: 500 });
  expect(parseFloat(inner(container).style.width)).toBeLessThanOrEqual(2_000_000 + 144);
  const ticks = () => [...container.querySelectorAll<HTMLElement>('[data-ruler] > [data-tick]')].map((e) => parseFloat(e.style.left));
  expect(ticks().length).toBeGreaterThan(5);
  expect(ticks().length).toBeLessThan(100);
  scroller(container).scrollLeft = 1_000_000;
  fireEvent.scroll(scroller(container));
  expect(ticks().length).toBeLessThan(100);
  expect(ticks().some((x) => x >= 1_000_000 && x <= 1_001_000)).toBe(true);
  expect(ticks().every((x) => x >= 1_000_000 - 2000 && x <= 1_001_000 + 2000)).toBe(true);
});

it('the zoom buttons keep the middle of the view in place, also after Ctrl+wheel at the limit', () => {
  viewW = 1000;
  const { container } = show(JSON.stringify(hour()));
  const el = scroller(container);
  const half = (1000 - 144) / 2;
  const middle = () => (el.scrollLeft + half) / ppsOf(container);
  for (let i = 0; i < 40; i++) fireEvent.wheel(el, { deltaY: -1000, ctrlKey: true, clientX: 500 });
  el.scrollLeft = 77_777;
  fireEvent.wheel(el, { deltaY: -1000, ctrlKey: true, clientX: 900 }); // at the limit: nothing changes
  expect(el.scrollLeft).toBe(77_777);
  const m = middle();
  fireEvent.click(screen.getByRole('button', { name: /^Zoom out/ }));
  expect(middle()).toBeCloseTo(m, 3);
  fireEvent.click(screen.getByRole('button', { name: /^Zoom in/ }));
  expect(middle()).toBeCloseTo(m, 3);
});

it('a source named with a literal %20 is looked up by that name, not decoded', async () => {
  const c = structuredClone(fixture);
  c.clips[3]!.src = 'media/50%20off.wav';
  missing = ['media/50 off.wav']; // the decoded name is not the file
  show(JSON.stringify(c));
  await waitFor(() => expect(heads).toHaveLength(5));
  expect(heads).toContain('/file?path=media%2F50%2520off.wav');
  expect(screen.queryByText(/not in the project/)).toBeNull();
});

it('a file that is not JSON says so, no crash', () => {
  show('{ "version": 1, ');
  expect(screen.getByText(/The edit is not valid JSON/)).toBeInTheDocument();
});

it('an empty edit says it has no clips', () => {
  show(JSON.stringify({ version: 1, width: 640, height: 360, fps: 30, tracks: [{ id: 'v1', kind: 'video' }], clips: [] }));
  expect(screen.getByText('No clips yet')).toBeInTheDocument();
  expect(screen.getByText('Video 1')).toBeInTheDocument();
});

it('a valid edit of the project has the Export control in the timeline toolbar', async () => {
  const { container } = show(JSON.stringify(fixture), { path: 'cuts/demo.nbcut.json' });
  const button = screen.getByRole('button', { name: 'Export' });
  expect(container.querySelector('[data-timeline] [data-cut-export]')).not.toBeNull();
  await waitFor(() => expect(button).toBeEnabled());
  expect(screen.getByRole('combobox', { name: 'Export format' })).toBeEnabled();
});

it('an edit with problems shows Export disabled, saying why', async () => {
  const bad = structuredClone(fixture) as typeof fixture & { clips: Record<string, unknown>[] };
  bad.clips[1]!.at = 4; // over c1
  show(JSON.stringify(bad), { path: 'cuts/demo.nbcut.json' });
  await screen.findByText('1 problem in the edit');
  const button = screen.getByRole('button', { name: 'Export' });
  expect(button).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Export format' })).toBeDisabled();
  expect(button.closest('[title]')!.getAttribute('title')).toBe('Fix the problems in the edit to export it');
});

it('an edit not of this project (another worktree, a revision) has no Export control', () => {
  show(JSON.stringify(fixture));
  expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
});

// the preview's controls (issue 408): jsdom plays nothing, so play/pause/load only flip a flag; the clock runs on fake time
describe('the preview', () => {
  const P = HTMLMediaElement.prototype;
  const saved = ['paused', 'readyState', 'play', 'pause', 'load'].map((k) => [k, Object.getOwnPropertyDescriptor(P, k)] as const);
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    Object.defineProperty(P, 'paused', { configurable: true, get(this: HTMLMediaElement) { return paused.get(this) ?? true; } });
    Object.defineProperty(P, 'readyState', { configurable: true, get: () => 4 }); // a frame at hand: the clock need not wait
    P.play = vi.fn(function (this: HTMLMediaElement) { paused.set(this, false); return Promise.resolve(); });
    P.pause = vi.fn(function (this: HTMLMediaElement) { paused.set(this, true); });
    P.load = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const [k, d] of saved) if (d) Object.defineProperty(P, k, d);
  });
  const key = (code: string) => fireEvent.keyDown(document, { code });
  const time = (c: HTMLElement) => c.querySelector('[data-cut-time]')!.textContent;
  const headAt = (c: HTMLElement) => parseFloat(c.querySelector<HTMLElement>('[data-playhead]')!.style.left) / ppsOf(c);

  it('a frame at the edit aspect above the timeline, with a layer per video track', () => {
    const { container } = show(JSON.stringify(fixture));
    const frame = container.querySelector<HTMLElement>('[data-cut-preview] [data-cut-frame]')!;
    expect(frame.style.aspectRatio).toBe('1280 / 720');
    expect(screen.getByRole('region', { name: 'Preview' })).toContainElement(frame);
    expect([...frame.querySelectorAll('[data-cut-layer]')].map((e) => e.getAttribute('data-cut-layer'))).toEqual(['v1', 'v2']);
    expect(frame.querySelectorAll('video')).toHaveLength(4); // two per video track, however many clips
  });

  it('Space and the button play and pause; the time and the playhead follow the clock', () => {
    const { container } = show(JSON.stringify(fixture));
    const play = screen.getByRole('button', { name: 'Play (Space, K)' });
    key('Space');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(time(container)).toMatch(/^0:0[12]\.\d \/ 0:09\.0$/);
    expect(headAt(container)).toBeGreaterThan(1.9);
    expect(screen.getByRole('button', { name: 'Pause (Space, K)' })).toBe(play);
    const v = container.querySelector<HTMLVideoElement>('[data-cut-layer="v1"] video[style*="visible"]')!;
    expect(v.paused).toBe(false);
    fireEvent.click(play);
    const at = headAt(container);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(headAt(container)).toBe(at);
    expect(v.paused).toBe(true);
    expect(screen.getByRole('button', { name: 'Play (Space, K)' })).toBeInTheDocument();
  });

  it('the player keys: J/L ten seconds, ← → the seek step, Home/End, `,` `.` a frame, ↑ ↓ the clip edges', () => {
    const { container } = show(JSON.stringify(fixture));
    key('KeyL');
    expect(time(container)).toBe('0:08.9 / 0:09.0'); // within the edit: on its last frame (8.96 s at 25 fps)
    key('KeyJ');
    expect(time(container)).toBe('0:00.0 / 0:09.0');
    key('ArrowRight');
    expect(time(container)).toBe('0:05.0 / 0:09.0');
    key('Home');
    key('Period');
    expect(headAt(container)).toBeCloseTo(1 / 25); // the edit's 25 fps
    key('Period');
    key('Comma');
    expect(headAt(container)).toBeCloseTo(1 / 25);
    // clip edges: c5 and c1 start at 0, c4 at 0.5, c3 at 1
    key('ArrowDown');
    expect(headAt(container)).toBeCloseTo(0.5);
    key('ArrowDown');
    expect(headAt(container)).toBeCloseTo(1);
    key('ArrowUp');
    expect(headAt(container)).toBeCloseTo(0.5);
    key('End');
    expect(headAt(container)).toBeCloseTo(8.96);
    // a frame step pauses playback
    key('Home');
    key('Space');
    act(() => { vi.advanceTimersByTime(500); });
    key('Period');
    expect(screen.getByRole('button', { name: 'Play (Space, K)' })).toBeInTheDocument();
    for (const [name, k] of [['Previous clip edge', '↑'], ['Next clip edge', '↓'], ['One frame back', ','], ['One frame forward', '.']]) {
      expect(screen.getByRole('button', { name: `${name} (${k})` })).toBeEnabled();
    }
  });

  it('dragging on the ruler scrubs: the playhead follows, playback holds and then goes on', () => {
    const { container } = show(JSON.stringify(fixture));
    const pps = ppsOf(container);
    const ruler = container.querySelector('[data-ruler]')!;
    key('Space');
    fireEvent.pointerDown(ruler, { clientX: 2 * pps, button: 0, pointerId: 1 });
    expect(headAt(container)).toBeCloseTo(2);
    fireEvent.pointerMove(ruler, { clientX: 4 * pps, pointerId: 1 });
    expect(headAt(container)).toBeCloseTo(4);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(headAt(container)).toBeCloseTo(4); // held while dragging
    fireEvent.pointerUp(ruler, { pointerId: 1 });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(headAt(container)).toBeGreaterThan(4.9);
    // the playhead's own line drags too
    key('Space');
    const grip = container.querySelector('[data-playhead] > div')!;
    fireEvent.pointerDown(grip, { clientX: 7 * pps, button: 0, pointerId: 2 });
    fireEvent.pointerUp(grip, { pointerId: 2 });
    expect(headAt(container)).toBeCloseTo(7);
  });

  it('keys stay with a text field, and with a hidden tab', () => {
    const { container, rerender } = show(JSON.stringify(fixture));
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    fireEvent.keyDown(input, { code: 'KeyL' });
    expect(time(container)).toBe('0:00.0 / 0:09.0');
    input.remove();
    const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
    rerender(<Provider store={store}><CutBody text={JSON.stringify(fixture)} src="here" tabId="file:e.nbcut.json" active={false} /></Provider>);
    key('KeyL');
    expect(time(container)).toBe('0:00.0 / 0:09.0');
  });

  it('an edit with problems shows why it does not play; the playhead still moves', () => {
    const bad = structuredClone(fixture) as typeof fixture & { clips: Record<string, unknown>[] };
    bad.clips[1]!.at = 4;
    const { container } = show(JSON.stringify(bad));
    expect(screen.getByText('Fix the problems in the edit to preview it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play (Space, K)' })).toBeDisabled();
    expect(container.querySelector('[data-cut-frame] video')).toBeNull();
    key('ArrowRight');
    expect(headAt(container)).toBeCloseTo(5);
  });
});

describe('the preview, scrolling and capture', () => {
  const P = HTMLMediaElement.prototype;
  const saved = ['paused', 'readyState', 'play', 'pause', 'load'].map((k) => [k, Object.getOwnPropertyDescriptor(P, k)] as const);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    Object.defineProperty(P, 'readyState', { configurable: true, get: () => 4 });
    P.play = vi.fn(() => Promise.resolve());
    P.pause = vi.fn();
    P.load = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const [k, d] of saved) if (d) Object.defineProperty(P, k, d);
  });

  it('a lost pointer capture ends the scrub: playback goes on', () => {
    const { container } = show(JSON.stringify(fixture));
    const ruler = container.querySelector('[data-ruler]')!;
    fireEvent.keyDown(document, { code: 'Space' });
    fireEvent.pointerDown(ruler, { clientX: 10, button: 0, pointerId: 1 });
    expect(screen.getByRole('button', { name: 'Play (Space, K)' })).toBeInTheDocument();
    fireEvent.lostPointerCapture(ruler, { pointerId: 1 });
    expect(screen.getByRole('button', { name: 'Pause (Space, K)' })).toBeInTheDocument();
  });

  it('the view follows the playhead until the user scrolls it, then again from the next seek', () => {
    viewW = 1000;
    const { container } = show(JSON.stringify(hour()));
    const el = scroller(container);
    for (let i = 0; i < 10; i++) fireEvent.wheel(el, { deltaY: -1000, ctrlKey: true, clientX: 500 });
    el.scrollLeft = 0;
    fireEvent.keyDown(document, { code: 'Space' });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(el.scrollLeft).toBeGreaterThan(0);
    fireEvent.wheel(el, { deltaX: -500 }); // the user looks elsewhere
    el.scrollLeft = 0;
    act(() => { vi.advanceTimersByTime(2000); });
    expect(el.scrollLeft).toBe(0);
    fireEvent.keyDown(document, { code: 'ArrowRight' });
    act(() => { vi.advanceTimersByTime(100); });
    expect(el.scrollLeft).toBeGreaterThan(0);
  });
});
