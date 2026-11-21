// A source's waveform for the timeline (issue 431): its peaks, CUT_PEAKS_RATE a second, each the loudest sample there as
// 0..255. The server reads them with ffmpeg (`GET /cut/peaks`): an hour of sound is 360 KB of peaks, and the page never
// holds the file. Where it cannot (an older server, no ffmpeg, a source of another branch) the page decodes the file
// itself, but only a short and small one, one at a time: a decoded sound is held whole in the page, possibly at its own
// rate, so a long one could take the tab down. A longer one has no waveform. Kept per file version (its ETag): a file
// written again, or one read while it was still being written, is read again.
import { CUT_PEAKS_RATE } from '@nota-bene/shared/cut';
import { connections, routes, projectFileUrl } from '@/sdk';
import { srcLength } from './durations.ts';

/** The largest file the page decodes, and the longest sound (seconds): about 250 MB of samples at 48 kHz stereo. */
export const PAGE_MAX_BYTES = 16 << 20;
export const PAGE_MAX_SEC = 10 * 60;
/** asked of the decoder; a browser may decode at the file's own rate first */
const DECODE_RATE = 8000;

/** A source's waveform, or why it has none: no sound in it, too long to decode in the page, a timed-out or failed decode. */
export type Wave = { peaks: Uint8Array } | { none: 'no-audio' | 'too-long' | 'timeout' | 'unreadable' };

type Decoded = { sampleRate: number; numberOfChannels: number; getChannelData: (i: number) => Float32Array };
type Deps = {
  /** the file's version (its ETag), null when unknown: then nothing is kept */
  version: (url: string) => Promise<string | null>;
  /** `GET /cut/peaks?path=` */
  fetchPeaks: (src: string) => Promise<Response>;
  fetchFile: (url: string) => Promise<Response>;
  /** the sound's length in seconds from its metadata, null when the browser cannot read it */
  duration: (url: string) => Promise<number | null>;
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

class Unreachable extends Error {}

/**
 * A loader of waveforms by source (and the view's file source), the `keep` most recent kept by file version. null: the
 * file could not be reached, nothing is kept and the next ask tries again.
 */
export function peaksLoader(d: Deps, keep = 64): (src: string, fileSrc: string) => Promise<Wave | null> {
  const cache = new Map<string, Promise<Wave | null>>();
  let turn: Promise<unknown> = Promise.resolve(); // the page decodes one file at a time
  const inPage = async (url: string): Promise<Wave> => {
    const sec = await d.duration(url);
    if (sec === null) return { none: 'unreadable' };
    if (sec > PAGE_MAX_SEC) return { none: 'too-long' };
    const r = await d.fetchFile(url).catch(() => { throw new Unreachable(); });
    const size = Number(r.headers.get('content-length'));
    if (!r.ok || !(size > 0) || size > PAGE_MAX_BYTES) {
      void r.body?.cancel().catch(() => {});
      if (!r.ok) throw new Unreachable();
      return { none: 'too-long' };
    }
    const mine = turn.then(async (): Promise<Wave> => {
      // the decoded buffer is mixed down at once and let go with this scope
      try {
        const a = await d.decode(await r.arrayBuffer());
        return { peaks: peaksFromChannels(Array.from({ length: a.numberOfChannels }, (_, i) => a.getChannelData(i)), a.sampleRate) };
      } catch {
        return { none: 'unreadable' };
      }
    });
    turn = mine.catch(() => {});
    return mine;
  };
  const load = async (src: string, fileSrc: string, url: string): Promise<Wave | null> => {
    try {
      if (!fileSrc || fileSrc === 'here') {
        const r = await d.fetchPeaks(src).catch(() => null);
        if (r?.ok) return { peaks: new Uint8Array(await r.arrayBuffer()) };
        if (r?.status === 422) return { none: 'no-audio' };
        if (r?.status === 504) return { none: 'timeout' };
      }
      return await inPage(url);
    } catch {
      return null;
    }
  };
  return async (src, fileSrc) => {
    const url = projectFileUrl(src, fileSrc);
    const v = await d.version(url).catch(() => null);
    if (v === null) return load(src, fileSrc, url);
    const key = `${fileSrc}\n${src}\n${v}`;
    const had = cache.get(key);
    if (had) {
      cache.delete(key); // the newest again
      cache.set(key, had);
      return had;
    }
    // an older version of the same file is of no more use
    for (const k of cache.keys()) if (k.startsWith(`${fileSrc}\n${src}\n`)) cache.delete(k);
    const p = load(src, fileSrc, url);
    cache.set(key, p);
    void p.then((w) => { if (w === null && cache.get(key) === p) cache.delete(key); });
    for (const k of cache.keys()) {
      if (cache.size <= keep) break;
      cache.delete(k);
    }
    return p;
  };
}

/** The app's waveforms. */
export const peaksOf = peaksLoader({
  version: async (url) => {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok ? r.headers.get('etag') : null;
  },
  fetchPeaks: (src) => connections.current().fetch(routes.cutPeaks(src)),
  fetchFile: (url) => fetch(url),
  duration: srcLength,
  decode: async (bytes) => new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(bytes),
});
