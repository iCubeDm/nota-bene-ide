import { useEffect, useRef, useState } from 'react';
import type { AgentEffort as EffortLevel } from '@nota-bene/shared';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu.tsx';
import { useT } from '@/i18n/index.ts';

/**
 * The effort as one stepped slider: stop 0 is Auto (the model's default, no level chosen), then one stop per level.
 * It is a menu item (so the menu's arrow navigation reaches it) that plays the slider role; ←/→/Home/End stay inside it.
 * A level is sent on a key press or when the pointer is released, never while dragging.
 */
export function EffortSlider({ levels, value, echo, onPick }: {
  levels: readonly EffortLevel[];
  value: EffortLevel | undefined;
  /** changes identity with every model echo, even an unchanged one (a refused change): the pending stop is dropped */
  echo?: unknown;
  /** `undefined`: Auto */
  onPick: (e: EffortLevel | undefined) => void;
}) {
  const t = useT();
  const stops: (EffortLevel | undefined)[] = [undefined, ...levels];
  const nameOf = (i: number) => {
    const e = stops[i];
    return e ? t(`effort_${e}`) : t('effort_auto');
  };
  const found = value ? stops.indexOf(value) : 0;
  const cur = Math.max(found, 0);
  const last = stops.length - 1;
  // the choice made but not echoed yet, so quick key presses add up; a drag's stop; the stop under the pointer
  const [pending, setPending] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => setPending(null), [cur, echo]);

  const shown = drag ?? pending ?? cur;
  const label = hover ?? shown;
  const pct = (i: number) => (last === 0 ? 0 : (i / last) * 100);
  const commit = (i: number) => {
    if (i === (pending ?? cur)) return;
    setPending(i);
    onPick(stops[i]);
  };
  const stopAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width === 0) return shown;
    return Math.min(last, Math.max(0, Math.round(((clientX - r.left) / r.width) * last)));
  };
  const stopOf = (el: EventTarget | null) => {
    const n = (el as HTMLElement | null)?.closest?.('[data-stop]')?.getAttribute('data-stop');
    return n == null ? null : Number(n);
  };

  return (
    <DropdownMenuItem
      role="slider"
      aria-label={t('effortLabel')}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={shown}
      aria-valuetext={nameOf(shown)}
      onSelect={(e) => e.preventDefault()}
      onBlur={() => { setPending(null); setHover(null); }}
      onKeyDown={(e) => {
        const base = pending ?? cur;
        const to = e.key === 'ArrowRight' ? Math.min(last, base + 1) : e.key === 'ArrowLeft' ? Math.max(0, base - 1)
          : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
        if (to === null) return; // Up/Down leave for the neighbouring menu rows
        e.preventDefault();
        e.stopPropagation(); // not the menu's own handling (typeahead, first/last row)
        commit(to);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 || !track.current?.contains(e.target as Node)) return; // the label and the name slot are not the track
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDrag(stopOf(e.target) ?? stopAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (drag !== null) setDrag(stopAt(e.clientX));
        else setHover(stopOf(e.target));
      }}
      onPointerLeave={() => setHover(null)}
      onPointerUp={() => {
        if (drag === null) return;
        const i = drag;
        setDrag(null);
        commit(i);
      }}
      onPointerCancel={() => setDrag(null)}
      className="flex w-full touch-none items-center gap-2 px-0 py-0.5"
    >
      <span className="text-[0.6875rem] text-muted-foreground">{t('effortLabel')}</span>
      <div ref={track} className="relative ml-2 mr-1.5 h-5 min-w-0 flex-1">
        {/* the bar reaches an anchor and a half past both end stops, so the end anchors sit inside its rounded ends */}
        <div aria-hidden className="absolute -inset-x-1.5 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted-foreground/25" />
        {/* the fill: from the bar's left end to the centre of the current stop (the content width is the stop's percentage) */}
        <div aria-hidden data-fill style={{ width: `${pct(shown)}%` }}
          className={`absolute -left-1.5 top-1/2 box-content h-1.5 -translate-y-1/2 rounded-full bg-primary pl-1.5 motion-reduce:transition-none ${drag === null ? 'transition-[width] duration-[120ms]' : ''}`} />
        {stops.map((_, i) => (
          // the stop's hit area is wider than its dot
          <span key={i} data-stop={i} onPointerEnter={() => setHover(i)} style={{ left: `${pct(i)}%` }}
            className="group absolute top-0 flex h-5 w-4 -translate-x-1/2 cursor-pointer items-center justify-center">
            <span aria-hidden
              className={`size-1.5 rounded-full transition-transform motion-reduce:transition-none group-hover:scale-125 ${i <= shown ? 'bg-primary-foreground' : 'bg-muted-foreground/60'}`} />
          </span>
        ))}
        {/* the thumb is the current anchor: larger, ringed in the menu's own colour so it reads as the handle */}
        <span aria-hidden data-thumb style={{ left: `${pct(shown)}%` }}
          className={`pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-popover motion-reduce:transition-none ${drag === null ? 'transition-[left] duration-[120ms]' : ''}`} />
      </div>
      {/* the name slot is as wide as the longest name, so the row does not jump with the name and the track runs up to it:
          every name sits in the one grid cell, the others invisible and set bold so the cell fits the widest */}
      <span aria-hidden className="grid shrink-0 text-right text-[0.6875rem]">
        {stops.map((_, i) => (
          <span key={i}
            className={`col-start-1 row-start-1 whitespace-nowrap ${i !== label ? 'invisible font-medium' : label === shown && hover === null ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
            {nameOf(i)}
          </span>
        ))}
      </span>
    </DropdownMenuItem>
  );
}
