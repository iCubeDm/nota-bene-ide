import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { autosize, overflowFor, useAutosize, wantedHeight } from './autosize.ts';

describe('autosize', () => {
  it('adds the border to the content height (scrollHeight excludes it)', () => {
    expect(wantedHeight(40, 2)).toBe(42);
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

describe('useAutosize', () => {
  it('refits when the width changes (not when only the height did) and on a window resize, and cleans up', () => {
    let cb: () => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { constructor(c: () => void) { cb = c; } observe() {} disconnect = disconnect; });
    let width = 300;
    const w = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => width);
    const sh = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(40);
    function F() { const r = useRef<HTMLTextAreaElement>(null); useAutosize(r, 'ab'); return <textarea ref={r} data-testid="t" />; }
    const { getByTestId, unmount } = render(<F />);
    const el = getByTestId('t') as HTMLTextAreaElement;
    expect(el.style.height).toBe('40px');
    sh.mockReturnValue(60);
    cb(); // same width: our own height write, ignored
    expect(el.style.height).toBe('40px');
    width = 200;
    cb();
    expect(el.style.height).toBe('60px');
    sh.mockReturnValue(80);
    window.dispatchEvent(new Event('resize'));
    expect(el.style.height).toBe('80px');
    unmount();
    expect(disconnect).toHaveBeenCalled();
    sh.mockReturnValue(10);
    window.dispatchEvent(new Event('resize'));
    expect(el.style.height).toBe('80px');
    w.mockRestore(); sh.mockRestore(); vi.unstubAllGlobals();
  });
});
