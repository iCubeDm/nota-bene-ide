// A source's waveform for the timeline (issue 431): ffmpeg decodes its sound to 8 kHz mono, and the loudest sample of
// each 1/CUT_PEAKS_RATE s is kept as a byte. Read once per file version and kept: an hour of sound is 360 KB of peaks,
// where decoding it in the browser would hold the whole file and its samples in the page.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { AUDIO, CUT_PEAKS_RATE, VIDEO } from '@nota-bene/shared/cut';
import { resolveInRoot } from '../files.ts';
import { HIDDEN } from '../platform.ts';
import { ffmpegEnv } from './ffmpeg.ts';

const SAMPLE_RATE = 8000;
const PER = SAMPLE_RATE / CUT_PEAKS_RATE;
/** files read at once; the rest wait their turn */
const AT_ONCE = 2;
/** a decode that takes longer is stopped (a stalled or endless input) */
const TIMEOUT_MS = 5 * 60_000;
/** what the cache keeps, bytes of peaks (about 9 hours of sound) */
const KEEP_BYTES = 32 << 20;

export class PeaksError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Peaks of 16-bit little-endian mono samples pushed in chunks of any size: the loudest of each `per` as 0..255. */
export function peakSink(per: number): { push: (b: Buffer) => void; end: () => Buffer } {
  let out = Buffer.alloc(4096);
  let n = 0;
  let max = 0;
  let count = 0;
  let odd: number | null = null; // a byte of a sample split across chunks
  const add = (v: number) => {
    const a = Math.abs(v);
    if (a > max) max = a;
    if (++count === per) flush();
  };
  const flush = () => {
    if (n === out.length) {
      const grown = Buffer.alloc(out.length * 2);
      out.copy(grown);
      out = grown;
    }
    out[n++] = Math.min(255, Math.round((max / 32768) * 255));
    max = 0;
    count = 0;
  };
  return {
    push: (b) => {
      let i = 0;
      if (odd !== null && b.length > 0) {
        add((((b[0]! << 8) | odd) << 16) >> 16);
        odd = null;
        i = 1;
      }
      for (; i + 1 < b.length; i += 2) add(b.readInt16LE(i));
      if (i < b.length) odd = b[i]!;
    },
    end: () => {
      if (count > 0) flush();
      return out.subarray(0, n);
    },
  };
}

export type PeaksOptions = {
  /** read at each ask: the root changes when the session switches to another project */
  root: () => string;
  ffmpeg: () => string | null;
  /** told on each ffmpeg started (tests count them) */
  spawned?: () => void;
};

/** The waveforms of the project's sources: one decode per file version, a few at a time, the newest kept. */
export class CutPeaks {
  private readonly cache = new Map<string, Promise<Buffer>>();
  private readonly sizes = new Map<string, number>();
  private readonly live = new Set<ChildProcess>();
  private running = 0;
  private readonly queue: (() => void)[] = [];
  private disposed = false;
  private readonly o: PeaksOptions;
  constructor(o: PeaksOptions) {
    this.o = o;
  }

  /** The peaks of `rel` (project-relative). Refusals are PeaksError: 403 outside-project, 400 not-media, 404, 501 no-ffmpeg, 422 no-audio. */
  async get(rel: string): Promise<Buffer> {
    if (this.disposed) throw new PeaksError(503, 'closing');
    const abs = resolveInRoot(this.o.root(), rel);
    if (!abs) throw new PeaksError(403, 'outside-project');
    if (!AUDIO.test(abs) && !VIDEO.test(abs)) throw new PeaksError(400, 'not-media');
    const st = await fs.promises.stat(abs).catch(() => null);
    if (!st?.isFile()) throw new PeaksError(404, 'not-found');
    const ffmpeg = this.o.ffmpeg();
    if (!ffmpeg) throw new PeaksError(501, 'no-ffmpeg');
    const key = `${abs}\n${st.size}\n${st.mtimeMs}`;
    const had = this.cache.get(key);
    if (had) {
      this.cache.delete(key); // the newest again
      this.cache.set(key, had);
      return had;
    }
    const p = this.turn(() => this.decode(ffmpeg, abs));
    this.cache.set(key, p);
    p.then((b) => {
      this.sizes.set(key, b.length);
      this.trim();
    }, () => { if (this.cache.get(key) === p) this.cache.delete(key); });
    return p;
  }

  /** Stops every running decode. The server calls it on close: it never throws. */
  dispose(): void {
    this.disposed = true;
    for (const c of this.live) c.kill('SIGKILL');
  }

  private trim(): void {
    let total = [...this.sizes.values()].reduce((a, b) => a + b, 0);
    for (const k of this.cache.keys()) {
      if (total <= KEEP_BYTES) break;
      const size = this.sizes.get(k);
      if (size === undefined) continue; // still decoding
      this.cache.delete(k);
      this.sizes.delete(k);
      total -= size;
    }
  }

  private async turn<T>(f: () => Promise<T>): Promise<T> {
    if (this.running >= AT_ONCE) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await f();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  private decode(ffmpeg: string, file: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new PeaksError(503, 'closing'));
      const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'];
      let child: ChildProcess;
      try {
        child = spawn(ffmpeg, args, { env: ffmpegEnv(), stdio: ['ignore', 'pipe', 'ignore'], shell: false, ...HIDDEN });
      } catch (e) {
        return reject(e);
      }
      this.o.spawned?.();
      this.live.add(child);
      const sink = peakSink(PER);
      const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
      child.stdout!.on('data', (d: Buffer) => sink.push(d));
      const done = (code: number | null, e?: Error) => {
        clearTimeout(timer);
        if (!this.live.delete(child)) return;
        if (e) return reject(e);
        // no sound stream to map: a video without sound, a file that is not media after all
        if (code !== 0) return reject(new PeaksError(422, 'no-audio'));
        resolve(sink.end());
      };
      child.on('error', (e) => done(null, e));
      child.on('close', (code) => done(code));
    });
  }
}
