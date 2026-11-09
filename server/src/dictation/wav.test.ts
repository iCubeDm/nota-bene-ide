import { describe, expect, it } from 'vitest';
import { pcmFromWav, WavError } from './wav.ts';
import { makeWav } from './wavFixture.ts';

describe('pcmFromWav', () => {
  it('parses a mono 16 kHz 16-bit sine', () => {
    const pcm = pcmFromWav(makeWav());
    expect(pcm).toBeInstanceOf(Float32Array);
    expect(pcm.length).toBe(8000);
    expect(Math.max(...pcm)).toBeGreaterThan(0.4);
    expect(Math.max(...pcm)).toBeLessThanOrEqual(1);
  });
  it('rejects what is not a 16 kHz mono 16-bit PCM WAV', () => {
    expect(() => pcmFromWav(Buffer.from('not a wav file at all, really not'))).toThrow(WavError);
    expect(() => pcmFromWav(makeWav({ rate: 44100 }))).toThrow(WavError);
    expect(() => pcmFromWav(makeWav({ channels: 2 }))).toThrow(WavError);
    expect(() => pcmFromWav(makeWav({ format: 3 }))).toThrow(WavError);
  });
});
