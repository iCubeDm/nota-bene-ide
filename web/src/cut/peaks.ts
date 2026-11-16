// A source's waveform for the timeline (issue 431): its peaks, CUT_PEAKS_RATE a second, each the loudest sample there as
// 0..255. The server reads them with ffmpeg (`GET /cut/peaks`): an hour of sound is 360 KB of peaks, and the page never
// holds the file. Where it cannot (an older server, no ffmpeg, a source of another branch) a file of up to BROWSER_MAX
// is decoded in the page instead, at a low rate; a bigger one has no waveform. Kept per source for the page's life.
import { CUT_PEAKS_RATE } from '@nota-bene/shared/cut';
import { projectFileUrl } from '@/files/kinds.ts';
import { apiFetch } from '@/net/auth.ts';

/** The largest file decoded in the page: its bytes and its samples are held there meanwhile. */
export const BROWSER_MAX = 64 << 20;
/** the page decodes at this rate: plenty for a peak per 1/100 s, and 6 times less memory than 48 kHz */
const DECODE_RATE = 8000;

type Decoded = { sampleRate: number; numberOfChannels: number; getChannelData: (i: number) => Float32Array };
type Deps = {
  /** `GET /cut/peaks?path=` */
  fetchPeaks: (src: string) => Promise<Response>;
  fetchFile: (url: string) => Promise<Response>;
  decode: (bytes: ArrayBuffer) => Promise<Decoded>;
};

/** The peaks of decoded channels at `rate` samples a second: the loudest of any channel in each 1/CUT_PEAKS_RATE s. */
export function peaksFromChannels(channels: Float32Array[], rate: number): Uint8Array {
  const per = rate / CUT_PEAKS_RATE;
  const len = channels[0]?.length ?? 0;
  const out = new Uint8Array(Math.ceil(len / per));
  for (let k = 0; k < out.length; k++) {
    let max = 0;
    const to = Math.min(len, Math.round((k + 1) * per));
    for (const ch of channels) for (let i = Math.round(k * per); i < to; i++) max = Math.max(max, Math.abs(ch[i]!));
    out[k] = Math.min(255, Math.round(max * 255));
  }
  return out;
}

/** A loader of peaks by source (and the view's file source), the `keep` most recent kept; a failure is not remembered. */
export function peaksLoader(d: Deps, keep = 64): (src: string, fileSrc: string) => Promise<Uint8Array | null> {
  const cache = new Map<string, Promise<Uint8Array | null>>();
  const inPage = async (src: string, fileSrc: string): Promise<Uint8Array | null> => {
    const r = await d.fetchFile(projectFileUrl(src, fileSrc));
    const size = Number(r.headers.get('content-length'));
    if (!r.ok || !(size > 0) || size > BROWSER_MAX) {
      void r.body?.cancel().catch(() => {});
      return null;
    }
    const a = await d.decode(await r.arrayBuffer());
    return peaksFromChannels(Array.from({ length: a.numberOfChannels }, (_, i) => a.getChannelData(i)), a.sampleRate);
  };
  const load = async (src: string, fileSrc: string): Promise<Uint8Array | null> => {
    if (!fileSrc || fileSrc === 'here') {
      const r = await d.fetchPeaks(src).catch(() => null);
      if (r?.ok) return new Uint8Array(await r.arrayBuffer());
      if (r?.status === 422) return null; // no sound in it
    }
    return inPage(src, fileSrc).catch(() => null);
  };
  return (src, fileSrc) => {
    const key = `${fileSrc}\n${src}`;
    const had = cache.get(key);
    if (had) {
      cache.delete(key); // the newest again
      cache.set(key, had);
      return had;
    }
    const p = load(src, fileSrc);
    cache.set(key, p);
    void p.then((v) => { if (v === null && cache.get(key) === p) cache.delete(key); });
    for (const k of cache.keys()) {
      if (cache.size <= keep) break;
      cache.delete(k);
    }
    return p;
  };
}

/** The app's waveforms: a source's peaks, or null when it has no sound or cannot be read. */
export const peaksOf = peaksLoader({
  fetchPeaks: (src) => apiFetch(`/cut/peaks?path=${encodeURIComponent(src)}`),
  fetchFile: (url) => fetch(url),
  decode: async (bytes) => new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(bytes),
});
