import { expect, it } from 'vitest';
import { FEATURES, has, PROTOCOL } from './protocol.ts';

it('no feature is ahead of PROTOCOL', () => {
  expect(PROTOCOL).toBeGreaterThanOrEqual(Math.max(...Object.values(FEATURES)));
});

it('has: at, below and above the protocol that added it, and with none', () => {
  expect(has(FEATURES.voice, 'voice')).toBe(true);
  expect(has(FEATURES.voice - 1, 'voice')).toBe(false);
  expect(has(FEATURES.voice + 1, 'voice')).toBe(true);
  expect(has(undefined, 'activity')).toBe(false);
  expect(has(null, 'activity')).toBe(false);
});
