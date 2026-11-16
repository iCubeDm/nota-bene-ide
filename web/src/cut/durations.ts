// How long a source is (issue 409): a new clip takes the whole file, a trim stops at its end. One <video> reads the
// metadata of a video or a sound file and is let go; the answer is kept per URL, a failure is not (the file may be fixed).
// Its picture's size comes with it (issue 426: a new edit takes the first video's frame).

/** What a source's metadata says: its length (null: not a finite one) and its picture's size (0 for a sound). */
export type SrcMeta = { len: number | null; width: number; height: number };

/** ms a source's metadata may take before it is given up as unreadable: a stuck load must not hold its callers forever. */
export const META_TIMEOUT = 10_000;

const cache = new Map<string, Promise<SrcMeta | null>>();

/** The source's metadata, or null when the browser cannot read it within META_TIMEOUT. */
export function srcMeta(url: string): Promise<SrcMeta | null> {
  const had = cache.get(url);
  if (had) return had;
  const p = new Promise<SrcMeta | null>((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const el = document.createElement('video');
    let over = false;
    const done = (v: SrcMeta | null) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute('src');
      el.load();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), META_TIMEOUT);
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => done({
      len: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null,
      width: el.videoWidth || 0,
      height: el.videoHeight || 0,
    });
    el.onerror = () => done(null);
    el.src = url;
  });
  cache.set(url, p);
  void p.then((v) => { if (v === null || v.len === null) cache.delete(url); });
  return p;
}

/** The source's length in seconds, or null when the browser cannot read it. */
export const srcLength = (url: string): Promise<number | null> => srcMeta(url).then((m) => m?.len ?? null);

/** The source's picture size, or null for a sound or a file the browser cannot read. */
export const srcSize = (url: string): Promise<{ width: number; height: number } | null> =>
  srcMeta(url).then((m) => (m && m.width > 0 && m.height > 0 ? { width: m.width, height: m.height } : null));
