import { tIn, type Lang, type FeedItem } from '@/sdk';

// Message times in the feed. A ts of 0 is a time nobody recorded (an old replay): it is never shown, never dated.

const dayOf = (ts: number): number => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const sameYear = (a: number, b: number) => new Date(a).getFullYear() === new Date(b).getFullYear();

/** `14:32` today; with the date on another day (`Nov 15, 14:32`), and the year in another year. */
export function clockTime(ts: number, lang: Lang, now = Date.now()): string {
  const today = dayOf(ts) === dayOf(now);
  return new Intl.DateTimeFormat(lang, {
    hour: '2-digit', minute: '2-digit',
    ...(today ? {} : { month: 'short', day: 'numeric', ...(sameYear(ts, now) ? {} : { year: 'numeric' }) }),
  }).format(ts);
}

/** The whole date and time, for a tooltip. */
export const fullTime = (ts: number, lang: Lang): string =>
  new Intl.DateTimeFormat(lang, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ts);

/** A day separator's text: Today, Yesterday, else the weekday and date (the year only when it is not this one). */
export function dayLabel(ts: number, lang: Lang, now = Date.now()): string {
  const day = dayOf(ts), n = new Date(now);
  if (day === dayOf(now)) return tIn(lang, 'today');
  if (day === new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).getTime()) return tIn(lang, 'yesterday');
  const date = new Intl.DateTimeFormat(lang, { weekday: 'long', month: 'long', day: 'numeric', ...(sameYear(ts, now) ? {} : { year: 'numeric' }) }).format(ts);
  return date.charAt(0).toLocaleUpperCase(lang) + date.slice(1); // a line of its own: «воскресенье» reads as «Воскресенье»
}

/** An item's time, 0 for the kinds that have none (tool lines, permissions, notices). */
const itemTime = (it: FeedItem): number => ('ts' in it && typeof it.ts === 'number' ? it.ts : 0);

/**
 * Where the feed starts a new day: index → that item's time. The first dated item starts one, then each whose day
 * differs from the last dated item's. Undated items (and the ids in `skip`, not drawn) neither start nor end a day.
 */
export function dayStarts(items: readonly FeedItem[], skip: ReadonlySet<string> = new Set()): Map<number, number> {
  const out = new Map<number, number>();
  let last = NaN;
  items.forEach((it, i) => {
    const ts = itemTime(it);
    if (ts <= 0 || ('id' in it && skip.has(it.id))) return;
    const day = dayOf(ts);
    if (day !== last) out.set(i, ts);
    last = day;
  });
  return out;
}

// The day the feed reads as today. One timer for every subscriber, set to the next local midnight: a feed left open
// overnight then says Yesterday and dates its times. A wake from sleep past midnight fires it late, still right.
let today = dayOf(Date.now());
const daySubs = new Set<() => void>();
let midnight: ReturnType<typeof setTimeout> | undefined;
function armMidnight(): void {
  const n = new Date();
  const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).getTime();
  midnight = setTimeout(() => {
    today = dayOf(Date.now());
    for (const fn of daySubs) fn();
    armMidnight();
  }, next - n.getTime() + 50); // just past it, so the new day is surely here
}

/** For useSyncExternalStore: called again at each local midnight while anything listens. */
export function subscribeDay(fn: () => void): () => void {
  if (daySubs.size === 0) {
    today = dayOf(Date.now()); // nobody listened for a while: the day may have changed meanwhile
    armMidnight();
  }
  daySubs.add(fn);
  return () => {
    daySubs.delete(fn);
    if (daySubs.size === 0) clearTimeout(midnight);
  };
}

/** The current local day (its midnight, epoch ms), as of the last midnight tick. */
export const currentDay = (): number => today;
