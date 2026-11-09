import { VOICE_BARS } from '@nota-bene/shared';

/** What the host takes (POST /voice): 16 kHz, mono, 16-bit PCM in a WAV. */
export const RATE = 16_000;
/** The recording stops here, as the phone's does; the host takes up to 10 min 2 s. */
export const MAX_MS = 600_000;

/**
 * Streaming downsampler by averaging: each output sample is the mean of the input it spans (box filter, which also
 * damps what would alias). Chunks may be any size; the tail shorter than one output sample waits for the next chunk.
 */
export class Resampler {
  private readonly ratio: number;
  private n = 0; // input samples seen
  private binEnd: number; // where the output sample being built ends, in input samples
  private acc = 0;

  constructor(from: number, to: number = RATE) {
    this.ratio = from / to;
    this.binEnd = this.ratio;
  }

  push(input: Float32Array): Float32Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      const s = input[i]!;
      let a = this.n;
      const b = this.n + 1;
      while (b >= this.binEnd) {
        this.acc += s * (this.binEnd - a);
        out.push(this.acc / this.ratio);
        a = this.binEnd;
        this.binEnd += this.ratio;
        this.acc = 0;
      }
      this.acc += s * (b - a);
      this.n = b;
    }
    return Float32Array.from(out);
  }
}

/** Float samples (−1…1) as 16-bit PCM, clipped. */
export function toPcm16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, x[i]!)) * (x[i]! < 0 ? 0x8000 : 0x7fff));
  return out;
}

/** A canonical 44-byte-header WAV of mono 16-bit PCM. */
export function encodeWav(pcm: Int16Array, rate: number = RATE): Blob {
  const head = new DataView(new ArrayBuffer(44));
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) head.setUint8(at + i, s.charCodeAt(i)); };
  const bytes = pcm.length * 2;
  tag(0, 'RIFF'); head.setUint32(4, 36 + bytes, true); tag(8, 'WAVE');
  tag(12, 'fmt '); head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
  head.setUint32(24, rate, true); head.setUint32(28, rate * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
  tag(36, 'data'); head.setUint32(40, bytes, true);
  // PCM is little-endian on the wire; every browser's platform is too, but say it with the bytes
  const body = new Uint8Array(bytes);
  const dv = new DataView(body.buffer);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, pcm[i]!, true);
  return new Blob([head, body], { type: 'audio/wav' });
}

/** VOICE_BARS peaks, loudest = 31 (all zeros for silence): the shape of the preview before the host's own wave exists. */
export function waveOf(pcm: Int16Array): number[] {
  const peaks = new Array<number>(VOICE_BARS).fill(0);
  if (!pcm.length) return peaks;
  for (let b = 0; b < VOICE_BARS; b++) {
    const from = Math.floor((b * pcm.length) / VOICE_BARS), to = Math.max(from + 1, Math.floor(((b + 1) * pcm.length) / VOICE_BARS));
    let p = 0;
    for (let i = from; i < to && i < pcm.length; i++) p = Math.max(p, Math.abs(pcm[i]!));
    peaks[b] = p;
  }
  const max = Math.max(...peaks);
  return max ? peaks.map((p) => Math.round((p / max) * 31)) : peaks;
}

export type Recording = { wav: Blob; ms: number; wave: number[] };
export type Recorder = {
  /** ends the recording and returns it; `ms` 0 when nothing was captured */
  stop(): Promise<Recording>;
  /** drops it and releases the microphone */
  cancel(): void;
};
export type RecorderOptions = {
  /** the loudest sample of each captured buffer, 0…1: the live wave */
  onLevel(level: number): void;
  /** MAX_MS reached: capture has stopped by itself; the owner ends it as a release does (`stop`) */
  onCap(): void;
};

/**
 * Opens the microphone and captures it into 16 kHz mono 16-bit PCM. A ScriptProcessorNode does the capture: it is
 * deprecated but works in every browser, needs no blob-URL worklet module and the page sets no Content-Security-Policy
 * that an AudioWorklet from a blob would have to pass. Rejects when the microphone is denied or missing.
 */
export async function startRecorder(o: RecorderOptions): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain(); // the node only runs when connected to the output; the gain keeps the microphone out of the speakers
  mute.gain.value = 0;
  const resampler = new Resampler(ctx.sampleRate);
  const chunks: Int16Array[] = [];
  let samples = 0;
  let live = true;
  const maxSamples = (MAX_MS / 1000) * RATE;
  node.onaudioprocess = (e) => {
    if (!live) return;
    const x = e.inputBuffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
    o.onLevel(Math.min(1, peak));
    const pcm = toPcm16(resampler.push(x));
    const room = maxSamples - samples;
    const take = pcm.length > room ? pcm.subarray(0, room) : pcm;
    if (take.length) { chunks.push(take.slice()); samples += take.length; }
    if (samples >= maxSamples) {
      live = false;
      o.onCap();
    }
  };
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  const close = () => {
    live = false;
    node.onaudioprocess = null;
    source.disconnect();
    node.disconnect();
    for (const tr of stream.getTracks()) tr.stop();
    void ctx.close().catch(() => {});
  };
  return {
    async stop() {
      close();
      const pcm = new Int16Array(samples);
      let at = 0;
      for (const c of chunks) { pcm.set(c, at); at += c.length; }
      return { wav: encodeWav(pcm), ms: Math.round((samples / RATE) * 1000), wave: waveOf(pcm) };
    },
    cancel: close,
  };
}

/** The recorder behind a seam: tests put a fake in `mic.start`. */
export const mic = { start: startRecorder };
