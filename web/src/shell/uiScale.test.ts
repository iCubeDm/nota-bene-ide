import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/net/auth.ts', () => ({ apiFetch: vi.fn(() => Promise.resolve({ ok: true })) }));
import { apiFetch } from '@/net/auth.ts';
import { uiScale } from './uiScale.ts';

beforeEach(() => {
  localStorage.clear();
  uiScale.reload();
  vi.mocked(apiFetch).mockClear();
});
afterEach(() => {
  localStorage.clear();
  uiScale.reload();
});

const root = () => document.documentElement.style.fontSize;

it('defaults to 100 %, leaving the root font size alone', () => {
  expect(uiScale.get()).toBe(1);
  expect(root()).toBe('');
});

it('a choice scales the root font size, is remembered here and sent to the server for every window', async () => {
  uiScale.choose(1.25);
  expect(root()).toBe('125%');
  expect(localStorage.getItem('nb.uiScale')).toBe('1.25');
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0]![1]!.body))).toEqual({ uiScale: 1.25 });
  uiScale.reload();
  expect(uiScale.get()).toBe(1.25);
  expect(root()).toBe('125%');
});

it("an unknown stored value reads as 100 %; the server's hello wins, unless our own choice is not confirmed yet", async () => {
  localStorage.setItem('nb.uiScale', '7');
  uiScale.reload();
  expect(uiScale.get()).toBe(1);
  uiScale.adopt(1.1);
  expect(uiScale.get()).toBe(1.1);
  uiScale.adopt('bogus');
  expect(uiScale.get()).toBe(1.1);
  vi.mocked(apiFetch).mockReturnValueOnce(new Promise(() => {})); // the POST never answers
  uiScale.choose(1.5);
  uiScale.adopt(1.1); // an older hello
  expect(uiScale.get()).toBe(1.5);
  expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2); // sent again instead
});
