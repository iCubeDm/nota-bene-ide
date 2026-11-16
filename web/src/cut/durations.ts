// How long a source is (issue 409): a new clip takes the whole file, a trim stops at its end. One <video> reads the
// metadata of a video or a sound file and is let go; the answer is kept per URL, a failure is not (the file may be fixed).

const cache = new Map<string, Promise<number | null>>();

/** The source's length in seconds, or null when the browser cannot read it. */
export function srcLength(url: string): Promise<number | null> {
  const had = cache.get(url);
  if (had) return had;
  const p = new Promise<number | null>((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const el = document.createElement('video');
    const done = (v: number | null) => {
      el.removeAttribute('src');
      el.load();
      resolve(v);
    };
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
  cache.set(url, p);
  void p.then((v) => { if (v === null) cache.delete(url); });
  return p;
}
