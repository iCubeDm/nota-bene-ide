import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { CutBody } from './CutBody.tsx';

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
beforeEach(() => {
  setLang('en');
  missing = [];
  heads = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') heads.push(url);
    const path = new URL(url, 'http://x').searchParams.get('path') ?? '';
    return new Response(null, { status: missing.includes(path) ? 404 : 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show(text: string) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  return render(<Provider store={store}><CutBody text={text} src="here" tabId="file:e.nbcut.json" active /></Provider>);
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
  // thumbnails: the photo itself, a video's first used frame; none for sound
  expect(clip('c3').querySelector('img')?.getAttribute('src')).toBe('/file?path=media%2Flogo.png');
  expect(clip('c1').querySelector('video')?.getAttribute('src')).toBe('/file?path=media%2Fintro.mp4#t=2');
  expect(clip('c4').querySelector('img, video')).toBeNull();
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

it('a file that is not JSON says so, no crash', () => {
  show('{ "version": 1, ');
  expect(screen.getByText(/The edit is not valid JSON/)).toBeInTheDocument();
});

it('an empty edit says it has no clips', () => {
  show(JSON.stringify({ version: 1, width: 640, height: 360, fps: 30, tracks: [{ id: 'v1', kind: 'video' }], clips: [] }));
  expect(screen.getByText('No clips yet')).toBeInTheDocument();
  expect(screen.getByText('Video 1')).toBeInTheDocument();
});
