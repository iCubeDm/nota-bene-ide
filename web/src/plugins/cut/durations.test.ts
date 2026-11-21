import { afterEach, expect, it, vi } from 'vitest';
import { META_TIMEOUT, srcLength, srcMeta, srcSize } from './durations.ts';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// the <video> the next read makes, to answer its metadata by hand (jsdom loads no media)
const make = document.createElement.bind(document);
function nextVideo(): () => HTMLVideoElement {
  let el: HTMLVideoElement | undefined;
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const e = make(tag);
    if (tag === 'video') el = e as HTMLVideoElement;
    return e;
  });
  return () => el!;
}
const answer = (el: HTMLVideoElement, duration: number, w: number, h: number) => {
  Object.defineProperty(el, 'duration', { value: duration });
  Object.defineProperty(el, 'videoWidth', { value: w });
  Object.defineProperty(el, 'videoHeight', { value: h });
  el.dispatchEvent(new Event('loadedmetadata'));
};

it('reads a source\'s length and picture size from its metadata, once per url', async () => {
  const el = nextVideo();
  const p = srcMeta('/file?path=a.mp4');
  answer(el(), 12.5, 1280, 720);
  expect(await p).toEqual({ len: 12.5, width: 1280, height: 720 });
  expect(await srcLength('/file?path=a.mp4')).toBe(12.5);
  expect(await srcSize('/file?path=a.mp4')).toEqual({ width: 1280, height: 720 });
});

it('a sound has a length and no size; an unreadable length is null', async () => {
  let el = nextVideo();
  const p = srcMeta('/file?path=b.wav');
  answer(el(), 3, 0, 0);
  expect(await p).toEqual({ len: 3, width: 0, height: 0 });
  expect(await srcSize('/file?path=b.wav')).toBeNull();
  el = nextVideo();
  const q = srcLength('/file?path=c.mp4');
  answer(el(), Infinity, 640, 360);
  expect(await q).toBeNull();
});

it('metadata that never comes is given up after META_TIMEOUT (null), and asked again next time', async () => {
  vi.useFakeTimers();
  nextVideo();
  let got: unknown = 'waiting';
  void srcLength('/file?path=stuck.mp4').then((v) => { got = v; });
  await vi.advanceTimersByTimeAsync(META_TIMEOUT - 100);
  expect(got).toBe('waiting');
  await vi.advanceTimersByTimeAsync(200);
  expect(got).toBeNull();
  const el = nextVideo();
  const again = srcLength('/file?path=stuck.mp4');
  answer(el(), 4, 10, 10);
  expect(await again).toBe(4);
});
