// The CutBody tests' shared setup: an edit file behind a stubbed /edit, the view on it, and a fake clock (issue 472),
// so a save's SAVE_DELAY and a highlight's FLASH_MS pass in fake time. Module mocks (thumbs, durations, peaks) stay
// in each test file: vi.mock is hoisted per file.
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { validateCut, type Cut } from '@nota-bene/shared/cut';
import { setLang } from '@/sdk';
import { renderWith, stubRoutes } from '@/core/testing';
import { CutBody } from './CutBody.tsx';
import { SAVE_DELAY } from './useCutDoc.ts';

export const fixture = {
  version: 1, width: 1280, height: 720, fps: 25,
  tracks: [{ id: 'v1', kind: 'video', name: 'Main' }, { id: 'a1', kind: 'audio', name: 'Voice' }],
  clips: [
    { id: 'c1', track: 'v1', src: 'media/intro.mp4', at: 0, out: 4 },
    { id: 'c2', track: 'v1', src: 'media/street.webm', at: 6, out: 4 },
    { id: 'c3', track: 'a1', src: 'media/voice.wav', at: 0, out: 8 },
  ],
};

export let disk: { text: string; base: string };
let ver: number;
let routes: ReturnType<typeof stubRoutes>;
/** The requests the view made, as path and query. */
export const requested = () => routes.calls.map((r) => { const u = new URL(r.url); return u.pathname + u.search; });
export const write = (text: string) => void (disk = { text, base: `b${++ver}` });
export const onDisk = () => JSON.parse(disk.text) as Cut;
export const clipOnDisk = (id: string) => onDisk().clips.find((c) => c.id === id);

/** Each test starts on `start` written to the stubbed /edit, under a fake setTimeout that waitFor advances. */
export function setupCut(start: object = fixture) {
  beforeEach(() => {
    // only the timeouts: React's scheduler and the fetch stubs keep running; RTL's waitFor steps the clock while it
    // sees a `jest` with fake timers
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
    setLang('en');
    ver = 0;
    write(JSON.stringify(start));
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-timeline-scroll') ? 1160 : 0; },
    });
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} takeRecords() { return []; } });
    routes = stubRoutes({
      '/cut/export': { ffmpeg: true, job: null },
      // setLang('en') above saves the choice; a refusal would leave it unsynced into the next test
      '/system/prefs': {},
      // every media file is there (useMissing asks with HEAD)
      '/file': () => new Response(null, { status: 200 }),
      '/cut/reverse': () => Response.json({ making: true }, { status: 202 }),
      '/edit': async (req) => {
        if (req.method !== 'POST') return Response.json(disk);
        const b = (await req.json()) as { text: string; base: string | null };
        if (b.base !== null && b.base !== disk.base) return Response.json({ error: 'changed' }, { status: 409 });
        write(b.text);
        return Response.json({ base: disk.base });
      },
    });
  });
  afterEach(() => {
    cleanup();
    routes.restore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  });
}

/** Time passes for the view: its timeouts that fall due run, inside act. */
export const elapse = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

export async function show(active = true) {
  let on = active;
  const ui = (text: string) => <CutBody text={text} src="here" path="e.nbcut.json" tabId="file:e.nbcut.json" active={on} />;
  const r = renderWith(ui(disk.text));
  await waitFor(() => expect(r.container.querySelector('[data-cut-tools]')).not.toBeNull());
  const pps = () => Number(r.container.querySelector('[data-timeline]')!.getAttribute('data-pps'));
  const clip = (id: string) => r.container.querySelector<HTMLElement>(`[data-clip="${id}"]`)!;
  const gets = () => routes.calls.filter((c) => new URL(c.url).pathname === '/edit' && c.method !== 'POST').length;
  // the file view reads the file again; resolved once the editor's read of its version is answered and handled
  const reread = async () => {
    const n = gets();
    act(() => r.rerender(ui(disk.text)));
    await waitFor(() => expect(gets()).toBeGreaterThan(n));
    await elapse(0);
  };
  const setActive = (a: boolean) => { on = a; act(() => r.rerender(ui(disk.text))); };
  return { ...r, pps, clip, reload: () => r.rerender(ui(disk.text)), reread, setActive };
}
export const saved = (f: () => void) => waitFor(f, { timeout: SAVE_DELAY + 1500 });
export const valid = () => expect(validateCut(onDisk()).ok).toBe(true);
export const drag = (el: Element, from: number, to: number, opts: Record<string, unknown> = {}) => {
  fireEvent.pointerDown(el, { clientX: from, clientY: 0, button: 0, pointerId: 1, ...opts });
  fireEvent.pointerMove(el, { clientX: to, clientY: 0, pointerId: 1, ...opts });
  fireEvent.pointerUp(el, { clientX: to, clientY: 0, pointerId: 1, ...opts });
};
