import { afterEach, expect, it, vi } from 'vitest';
import { transcribeVoice } from './upload.ts';

afterEach(() => vi.unstubAllGlobals());

it('transcribeVoice asks for detection and returns the language used', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => (urls.push(u), Response.json({ text: ' bonjour ', lang: 'fr' }))));
  expect(await transcribeVoice('v1', { lang: 'en', detect: true })).toEqual({ text: 'bonjour', lang: 'fr' });
  expect(urls[0]).toBe('/voice/v1/text?lang=en&detect=1');
});

it('transcribeVoice without detect sends only lang', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => (urls.push(u), Response.json({ text: 'hi' }))));
  expect(await transcribeVoice('v1', { lang: 'de' })).toEqual({ text: 'hi' });
  expect(urls[0]).toBe('/voice/v1/text?lang=de');
});
