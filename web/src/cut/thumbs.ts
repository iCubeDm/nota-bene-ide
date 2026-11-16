// A video clip's thumbnail (issue 407): one frame of its source, grabbed once per file and time into a small image that every
// clip showing it shares. The timeline holds no media elements: a grab borrows one <video>, two at a time at most, and
// lets it go.

/** One frame of a video at `at` seconds as an image, or null when the browser cannot read it. */
type Grab = (url: string, at: number) => Promise<Blob | null>;

const HEIGHT = 96; // px of a grabbed frame: the lanes are 56 px, this is sharp on a 2× screen
const PATIENCE = 15_000; // ms before a grab that hangs (a stalled file) gives up its turn
const AT_ONCE = 2;

/**
 * A cache of thumbnails as object URLs by (url, time): the `keep` most recently asked for. A failed grab is not
 * remembered, so the next ask (after the agent fixed the file) tries again.
 */
export function posterCache(grab: Grab, keep = 200): (url: string, at: number) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  let running = 0;
  const queue: (() => void)[] = [];
  const turn = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (running >= AT_ONCE) await new Promise<void>((r) => queue.push(r));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      queue.shift()?.();
    }
  };
  return (url, at) => {
    const key = `${at}\n${url}`;
    const had = cache.get(key);
    if (had) {
      cache.delete(key); // the newest again
      cache.set(key, had);
      return had;
    }
    const p = turn(() => grab(url, at)).then((b) => (b ? URL.createObjectURL(b) : null), () => null);
    cache.set(key, p);
    void p.then((u) => { if (u === null && cache.get(key) === p) cache.delete(key); });
    for (const [k, old] of cache) {
      if (cache.size <= keep) break;
      cache.delete(k);
      void old.then((u) => u && URL.revokeObjectURL(u));
    }
    return p;
  };
}

/** Draws the frame at `at` of the video at `url` onto a canvas, HEIGHT px high. */
const grabFrame: Grab = (url, at) => new Promise((resolve) => {
  const v = document.createElement('video');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (b: Blob | null) => {
    clearTimeout(timer);
    v.onloadedmetadata = v.onseeked = v.onerror = null;
    v.removeAttribute('src');
    v.load(); // frees the decoder and the connection
    resolve(b);
  };
  timer = setTimeout(() => done(null), PATIENCE);
  v.muted = true;
  v.preload = 'auto';
  v.onerror = () => done(null);
  v.onloadedmetadata = () => {
    // `in` past the file's end: its last frame
    v.currentTime = Math.min(at || 0.001, Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.05) : Infinity);
  };
  v.onseeked = () => {
    if (!v.videoWidth || !v.videoHeight) return done(null);
    const h = Math.min(HEIGHT, v.videoHeight);
    const c = document.createElement('canvas');
    c.width = Math.round((v.videoWidth * h) / v.videoHeight);
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return done(null);
    try {
      g.drawImage(v, 0, 0, c.width, c.height);
      c.toBlob(done, 'image/jpeg', 0.8);
    } catch {
      done(null);
    }
  };
  v.src = url;
});

/** The app's thumbnails: a video clip's frame by its file's URL and the time in it. */
export const poster = posterCache(grabFrame);
