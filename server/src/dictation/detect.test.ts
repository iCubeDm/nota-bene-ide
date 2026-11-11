import { describe, expect, it } from 'vitest';
import { pickLang, resolveLang } from './detect.ts';
import { DETECT_MIN_MS, WHISPER_RATE } from './whisper.ts';
import type { Pipe } from './install.ts';

const secs = (s: number) => new Float32Array(Math.round(s * WHISPER_RATE));
const withDetect = (probs: Record<string, number>, seen: number[] = []): Pipe =>
  Object.assign(async () => ({ text: '' }), { detect: async (a: Float32Array) => { seen.push(a.length); return probs; } });

describe('pickLang', () => {
  it('takes the most probable language from 0.5 up', () => {
    expect(pickLang({ en: 0.1, fr: 0.5, de: 0.4 }, 'ru')).toBe('fr');
    expect(pickLang({ en: 0.9, fr: 0.1 }, 'ru')).toBe('en');
  });
  it('falls back to the hint below 0.5', () => {
    expect(pickLang({ en: 0.49, fr: 0.3, de: 0.21 }, 'ru')).toBe('ru');
    expect(pickLang({}, 'ru')).toBe('ru');
  });
});

describe('resolveLang', () => {
  it('detects, and the pick can differ from the hint', async () => {
    expect(await resolveLang(withDetect({ fr: 0.8, en: 0.2 }), secs(3), 'en')).toBe('fr');
  });
  it('skips detection for clips under a second', async () => {
    const seen: number[] = [];
    const short = new Float32Array(Math.round(WHISPER_RATE * DETECT_MIN_MS / 1000) - 1);
    expect(await resolveLang(withDetect({ fr: 0.99 }, seen), short, 'en')).toBe('en');
    expect(seen).toEqual([]);
    expect(await resolveLang(withDetect({ fr: 0.99 }, seen), new Float32Array(short.length + 1), 'en')).toBe('fr');
  });
  it('listens to the first 30 s of a long clip only', async () => {
    const seen: number[] = [];
    await resolveLang(withDetect({ fr: 0.99 }, seen), secs(100), 'en');
    expect(seen).toEqual([30 * WHISPER_RATE]);
  });
  it('keeps the hint when the pipeline cannot detect or detection fails', async () => {
    expect(await resolveLang(Object.assign(async () => ({ text: '' }), {}), secs(3), 'ru')).toBe('ru');
    const failing = Object.assign(async () => ({ text: '' }), { detect: async () => { throw new Error('boom'); } });
    expect(await resolveLang(failing, secs(3), 'ru')).toBe('ru');
  });
});
