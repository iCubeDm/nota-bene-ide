import { cleanup, fireEvent, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { setupCut, show } from './testCut.tsx';

vi.mock('./thumbs.ts', () => ({ poster: vi.fn(async () => null) }));
vi.mock('./peaks.ts', () => ({ peaksOf: vi.fn(async () => null) }));
vi.mock('./durations.ts', () => ({ srcLength: vi.fn(async () => 4) }));

// the drag edge between the preview and the timeline (issue 739)
setupCut();
// jsdom lays nothing out: the preview's row and the timeline share 1000 px, whatever the split
beforeEach(() => {
  localStorage.clear();
  HTMLElement.prototype.setPointerCapture = () => {};
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute('data-timeline') ? 400 : this.querySelector(':scope > [data-cut-preview]') ? 600 : 0; },
  });
  vi.stubGlobal('ResizeObserver', class {
    cb: () => void;
    constructor(cb: () => void) { this.cb = cb; }
    observe() { this.cb(); }
    disconnect() {}
  });
  return () => { delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight; };
});

const edge = () => screen.getByRole('separator', { name: 'Preview height' });
const height = () => Number(edge().getAttribute('aria-valuenow'));
const grows = () => [edge().parentElement!.style.flexGrow, document.querySelector<HTMLElement>('[data-timeline]')!.style.flexGrow];
const drag = (dy: number) => {
  fireEvent.pointerDown(edge(), { button: 0, clientX: 0, clientY: 300, pointerId: 1 });
  fireEvent.pointerMove(edge(), { clientX: 0, clientY: 300 + dy, pointerId: 1 });
  fireEvent.pointerUp(edge(), { clientX: 0, clientY: 300 + dy, pointerId: 1 });
};

it('the preview takes 3:2 of the height by default; dragging the edge down gives it more, kept for the next edit', async () => {
  await show();
  expect(edge()).toHaveAttribute('aria-orientation', 'horizontal');
  expect(height()).toBe(600);
  expect(grows()).toEqual(['0.6', '0.4']);
  drag(100);
  expect(height()).toBe(700);
  expect(grows()).toEqual(['0.7', '0.3']);
  expect(localStorage.getItem('cut:preview:share')).toBe('0.7');
  cleanup();
  await show();
  expect(height()).toBe(700);
});

it('↑/↓ step it, not the playhead; Home and double-click go back to 3:2', async () => {
  const { container } = await show();
  container.setAttribute('data-file-view', ''); // as in a file tab, where the edit's keys are
  edge().focus();
  const key = (k: string) => fireEvent.keyDown(edge(), { key: k, code: k });
  key('ArrowUp');
  expect(height()).toBe(584);
  key('Home');
  expect(height()).toBe(600);
  expect(localStorage.getItem('cut:preview:share')).toBeNull();
  key('ArrowDown');
  expect(height()).toBe(616);
  fireEvent.doubleClick(edge());
  expect(height()).toBe(600);
});

it('each side keeps its minimum: on a drag, and for a stored share that no longer fits', async () => {
  await show();
  drag(-1000);
  expect(height()).toBe(96);
  drag(2000);
  expect(height()).toBe(864); // the timeline keeps its header, ruler, add-track row and one video lane
  cleanup();
  localStorage.setItem('cut:preview:share', '0.95');
  await show();
  expect(height()).toBe(864);
  expect(grows()).toEqual(['0.864', '0.136']);
});
