/** Pure parts of the player bar's timeline: time text and the comment markers' layout. */

const pad = (n: number) => String(n).padStart(2, '0');

/** m:ss.mmm, or h:mm:ss.mmm from an hour on. Anything not a finite non-negative number reads as 0:00.000. */
export function formatTime(s: number): string {
  // to the nearest ms: a float like 1.001 s is 1000.999… ms
  const ms = Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 0;
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = `${pad(t % 60)}.${String(ms % 1000).padStart(3, '0')}`;
  return h > 0 ? `${h}:${pad(m)}:${sec}` : `${m}:${sec}`;
}

export type MarkerIn = { id: string; time: number; text: string; dim: boolean };
/** One tick: the comments within `mergePx` of each other. `time` is the earliest one's (a click seeks there). */
export type Marker = { time: number; pct: number; count: number; dim: boolean; ids: string[]; text: string };

export const MARKER_TEXT_CHARS = 40;
export const MERGE_PX = 4;

/**
 * Ticks for comments at `time` s on a timeline of `duration` s drawn `widthPx` wide. Neighbours closer than `mergePx`
 * (measured from a tick's first comment) share one tick; a tick is dimmed only when all of its comments are. Without a
 * known duration there is nothing to place; with no width yet only comments at the very same time merge.
 */
export function layoutMarkers(items: MarkerIn[], duration: number, widthPx: number, mergePx = MERGE_PX): Marker[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const limit = widthPx > 0 ? (duration * mergePx) / widthPx : 0;
  const sorted = items.filter((c) => Number.isFinite(c.time) && c.time >= 0).sort((a, b) => a.time - b.time);
  const out: Marker[] = [];
  let first = -Infinity;
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.time - first <= limit) {
      last.count++;
      last.ids.push(c.id);
      last.dim &&= c.dim;
      continue;
    }
    first = c.time;
    out.push({ time: c.time, pct: Math.min(100, (c.time / duration) * 100), count: 1, dim: c.dim, ids: [c.id], text: c.text.trim().slice(0, MARKER_TEXT_CHARS) });
  }
  return out;
}
