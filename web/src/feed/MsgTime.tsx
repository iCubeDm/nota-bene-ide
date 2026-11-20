import { getLang, useT } from '@/sdk';
import { useSyncExternalStore } from 'react';
import { clockTime, currentDay, dayLabel, fullTime, subscribeDay } from './time.ts';

/** Re-renders the caller at local midnight (time.ts): what reads as today changes then. */
const useDay = () => useSyncExternalStore(subscribeDay, currentDay);

/** A message's time (with its date when it is not today), the whole date and time in its tooltip; nothing for ts 0. */
export function MsgTime({ ts, className, anchorSkip }: { ts: number; className?: string; /** inside a quotable text: not part of it */ anchorSkip?: boolean }) {
  useT(); // follows the UI language
  useDay();
  if (ts <= 0) return null;
  const lang = getLang();
  return <time data-anchor-skip={anchorSkip || undefined} dateTime={new Date(ts).toISOString()} title={fullTime(ts, lang)} className={className}>{clockTime(ts, lang)}</time>;
}

/** The line between two days in the feed: Today, Yesterday or the date. */
export function DaySeparator({ ts }: { ts: number }) {
  useT();
  useDay();
  const lang = getLang();
  return (
    <div
      data-day
      data-anchor-skip
      title={fullTime(ts, lang)}
      className="my-3 flex select-none items-center gap-2 text-[0.6875rem] text-muted-foreground before:h-px before:flex-1 before:bg-border-soft after:h-px after:flex-1 after:bg-border-soft"
    >
      {dayLabel(ts, lang)}
    </div>
  );
}
