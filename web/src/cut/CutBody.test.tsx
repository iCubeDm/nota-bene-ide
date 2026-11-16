import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { CutBody } from './CutBody.tsx';

// a thumbnail is a frame grabbed once into an image (thumbs.test.ts); here, a name for what was asked
vi.mock('./thumbs.ts', () => ({ poster: vi.fn(async (url: string, at: number) => `blob:${url}@${at}`) }));

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
    return new Response(null, { status: missing.includes(path) ? 404 : 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth; });

function show(text: string, active = true) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  return render(<Provider store={store}><CutBody text={text} src="here" tabId="file:e.nbcut.json" active={active} /></Provider>);
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
  expect(container.querySelector('img')).toBeNull();
  seeAll();
  expect(clip('c3').querySelector('img')?.getAttribute('src')).toBe('/file?path=media%2Flogo.png');
  await waitFor(() => expect(clip('c1').querySelector('img')?.getAttribute('src')).toBe('blob:/file?path=media%2Fintro.mp4@2'));
  expect(clip('c4').querySelector('img')).toBeNull();
  expect(container.querySelector('video')).toBeNull();
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
  const { container } = show(JSON.stringify(fixture), false);
  seeAll();
  expect(container.querySelector('img, video')).toBeNull();
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
