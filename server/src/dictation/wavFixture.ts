// A RIFF/WAVE file for tests, built in memory (no binary fixture is committed).
/** A RIFF/WAVE file built in memory: a 440 Hz sine of `seconds`. */
export function makeWav(o: { seconds?: number; rate?: number; channels?: number; bits?: number; format?: number } = {}): Buffer {
  const { seconds = 0.5, rate = 16000, channels = 1, bits = 16, format = 1 } = o;
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * (bits / 8));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 16000), (i * channels + c) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(format, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * bits / 8, 28); h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
