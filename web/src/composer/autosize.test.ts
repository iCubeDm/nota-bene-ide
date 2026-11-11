import { describe, expect, it } from 'vitest';
import { autosize, overflowFor, wantedHeight } from './autosize.ts';

describe('autosize', () => {
  it('adds the border to the content height (scrollHeight excludes it) and rounds a fraction up', () => {
    expect(wantedHeight(40, 2)).toBe(42);
    expect(wantedHeight(39.2, 2)).toBe(42);
  });
  it('shows no scrollbar until the max height cuts the field', () => {
    expect(overflowFor(42, 42)).toBe('hidden');
    expect(overflowFor(500, 300)).toBe('auto');
  });
  it('sets the style on the element: a short draft hides overflow, a capped one scrolls', () => {
    const el = document.createElement('textarea');
    const size = (scroll: number, offset: number, client: number) => {
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scroll });
      Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => Math.min(offset, el.style.height === 'auto' ? 42 : parseFloat(el.style.height) || 42, 300) });
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => client });
    };
    size(40, 42, 40);
    autosize(el);
    expect(el.style.height).toBe('42px');
    expect(el.style.overflowY).toBe('hidden');
    size(500, 42, 40);
    autosize(el);
    expect(el.style.height).toBe('502px'); // the CSS max-height cuts it to 300 in a browser; the mock caps offsetHeight
    expect(el.style.overflowY).toBe('auto');
  });
});
