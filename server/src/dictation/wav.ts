// RIFF/WAVE PCM to samples. Only what the mobile recorder sends: mono, 16 kHz, 16-bit; anything else is refused, not resampled.
export class WavError extends Error {}

export function pcmFromWav(buf: Buffer): Float32Array {
  const samples = samplesOf(buf);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! / 32768;
  return out;
}

/** The data chunk's samples, as they are (a view when aligned, else a copy): a long recording is not turned into floats whole. */
export function samplesOf(buf: Buffer): Int16Array {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new WavError('not a WAV file');
  let fmt = false;
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw new WavError('bad fmt chunk');
      if (buf.readUInt16LE(body) !== 1) throw new WavError('not PCM');
      if (buf.readUInt16LE(body + 2) !== 1) throw new WavError('not mono');
      if (buf.readUInt32LE(body + 4) !== 16000) throw new WavError('not 16 kHz');
      if (buf.readUInt16LE(body + 14) !== 16) throw new WavError('not 16-bit');
      fmt = true;
    } else if (id === 'data') {
      if (!fmt) throw new WavError('data before fmt');
      const end = Math.min(body + size, buf.length);
      const n = (end - body) >> 1;
      const at = buf.byteOffset + body;
      // little-endian, as every machine Nota Bene runs on
      return at % 2 === 0 ? new Int16Array(buf.buffer, at, n) : new Int16Array(buf.buffer.slice(at, at + n * 2));
    }
    off = body + size + (size & 1);
  }
  throw new WavError('no data chunk');
}
