import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/net/auth.ts', () => ({ apiFetch: vi.fn(() => Promise.resolve({ ok: true })) }));
import { apiFetch } from '@/net/auth.ts';
import { theme } from './theme.ts';

beforeEach(() => {
  localStorage.clear();
  theme.reload();
  vi.mocked(apiFetch).mockClear();
});
afterEach(() => {
  localStorage.clear();
  theme.reload();
});

const attr = () => document.documentElement.dataset.theme;

it('defaults to darcula and says so on <html>', () => {
  expect(theme.get()).toBe('darcula');
  expect(attr()).toBe('darcula');
});

it('choose saves locally and posts for every window', () => {
  theme.choose('plannotator');
  expect(theme.get()).toBe('plannotator');
  expect(localStorage.getItem('nb.theme')).toBe('plannotator');
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0]![1]!.body))).toEqual({ theme: 'plannotator' });
  expect(attr()).toBe('plannotator');
  expect(theme.kind()).toBe('dark');
});

it('applies the cached theme at import, before any subscriber runs', () => {
  localStorage.setItem('nb.theme', 'plannotator');
  const seen = vi.fn();
  const off = theme.subscribe(seen);
  theme.reload();
  expect(attr()).toBe('plannotator');
  expect(seen).not.toHaveBeenCalled();
  off();
});

it('unknown ids fall back to darcula; a bogus hello leaves the current one', () => {
  localStorage.setItem('nb.theme', 'neon');
  theme.reload();
  expect(theme.get()).toBe('darcula');
  theme.adopt('plannotator');
  expect(theme.get()).toBe('plannotator');
  theme.adopt('bogus');
  expect(theme.get()).toBe('plannotator');
});

it('an older hello does not undo an unconfirmed choice', () => {
  vi.mocked(apiFetch).mockReturnValueOnce(new Promise(() => {})); // the POST never answers
  theme.choose('plannotator');
  theme.adopt('darcula');
  expect(theme.get()).toBe('plannotator');
  expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
});
