import { afterEach, expect, it, vi } from 'vitest';
import { encodeWav, RATE, startRecorder, Resampler, toPcm16, waveOf } from './recorder.ts';

const sine = (rate: number, hz: number, secs: number): Float32Array =>
  Float32Array.from({ length: Math.round(rate * secs) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));

it('a 48 kHz sine becomes 16 kHz: a third of the samples, the same pitch and level', () => {
  const out = new Resampler(48_000).push(sine(48_000, 440, 1));
  expect(out.length).toBe(RATE);
  const rms = Math.sqrt(out.reduce((a, v) => a + v * v, 0) / out.length);
  expect(rms).toBeGreaterThan(0.33); // 0.5/√2 = 0.354, a little off for the box filter's rolloff
  expect(rms).toBeLessThan(0.36);
  // the pitch: 440 zero crossings upward in one second
  let up = 0;
  for (let i = 1; i < out.length; i++) if (out[i - 1]! < 0 && out[i]! >= 0) up++;
  expect(Math.abs(up - 440)).toBeLessThanOrEqual(1);
});

it('chunk sizes do not matter: the same samples come out however the input is cut', () => {
  const x = sine(44_100, 300, 0.5);
  const whole = new Resampler(44_100).push(x);
  const r = new Resampler(44_100);
  const parts = [r.push(x.subarray(0, 1000)), r.push(x.subarray(1000, 1001)), r.push(x.subarray(1001))];
  const joined = Float32Array.from(parts.flatMap((p) => [...p]));
  expect(joined.length).toBe(whole.length);
  expect(whole.length).toBe(Math.floor((x.length * RATE) / 44_100));
  for (let i = 0; i < whole.length; i++) expect(joined[i]).toBeCloseTo(whole[i]!, 5);
});

it('toPcm16 maps ±1 to the 16-bit range and clips beyond it', () => {
  expect([...toPcm16(Float32Array.of(0, 1, -1, 2, -2, 0.5))]).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
});

it('encodeWav writes a 16 kHz mono 16-bit PCM header and the samples, little-endian', async () => {
  const pcm = Int16Array.of(0, 1, -1, 32767, -32768);
  const wav = encodeWav(pcm);
  expect(wav.type).toBe('audio/wav');
  const b = new DataView(await wav.arrayBuffer());
  expect(b.byteLength).toBe(44 + 10);
  const tag = (at: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => b.getUint8(at + i)));
  expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
  expect(b.getUint32(4, true)).toBe(36 + 10);
  expect(b.getUint16(20, true)).toBe(1); // PCM
  expect(b.getUint16(22, true)).toBe(1); // mono
  expect(b.getUint32(24, true)).toBe(16_000);
  expect(b.getUint32(28, true)).toBe(32_000);
  expect(b.getUint16(34, true)).toBe(16);
  expect(b.getUint32(40, true)).toBe(10);
  expect([0, 1, 2, 3, 4].map((i) => b.getInt16(44 + i * 2, true))).toEqual([0, 1, -1, 32767, -32768]);
});

it('waveOf: 48 bars, the loudest is 31, silence is all zeros', () => {
  const ramp = Int16Array.from({ length: 4800 }, (_, i) => Math.round((i / 4800) * 20000));
  const w = waveOf(ramp);
  expect(w).toHaveLength(48);
  expect(Math.max(...w)).toBe(31);
  for (let i = 1; i < 48; i++) expect(w[i]!).toBeGreaterThanOrEqual(w[i - 1]!);
  expect(waveOf(new Int16Array(100)).every((v) => v === 0)).toBe(true);
  expect(waveOf(new Int16Array(0))).toHaveLength(48);
  expect(waveOf(Int16Array.of(5, 9))).toHaveLength(48);
});

afterEach(() => vi.unstubAllGlobals());

it('a failing AudioContext setup stops the microphone tracks it just opened', async () => {
  const track = { stop: vi.fn() };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  vi.stubGlobal('AudioContext', class { constructor() { throw new Error('no audio'); } });
  await expect(startRecorder({ onLevel() {}, onCap() {} })).rejects.toThrow('no audio');
  expect(track.stop).toHaveBeenCalled();
});

it('the recorder waits for a suspended context to resume before it reports itself open', async () => {
  const track = { stop: vi.fn() };
  let resumed = false;
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  vi.stubGlobal('AudioContext', class {
    sampleRate = 48_000; destination = {}; state = 'suspended';
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
    resume() { return new Promise<void>((r) => setTimeout(() => { resumed = true; r(); }, 5)); }
    close() { return Promise.resolve(); }
  });
  const rec = await startRecorder({ onLevel() {}, onCap() {} });
  expect(resumed).toBe(true);
  rec.cancel();
});
