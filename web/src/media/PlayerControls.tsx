import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/sdk';
import { VolumeHighIcon, VolumeLowIcon, VolumeOffIcon } from './playerIcons.tsx';
import type { MediaSnapshot } from './useMediaState.ts';

/** A round icon button of the bar. Keys are the player keys' (usePlayerKeys), so a pressed Space never also clicks it. */
export function BarButton({ label, onClick, children, pressed, className = '' }: {
  label: string; onClick: () => void; children: ReactNode; pressed?: boolean; className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`grid size-8 flex-none cursor-pointer place-items-center rounded-full text-on-scrim/90 outline-none hover:bg-on-scrim/15 hover:text-on-scrim focus-visible:ring-2 focus-visible:ring-primary ${className}`}
    >
      {children}
    </button>
  );
}

/** The mute button and, while hovered or focused, a horizontal volume slider (violet fill). */
export function VolumeControl({ media, state, onMute }: { media: HTMLMediaElement; state: MediaSnapshot; onMute: () => void }) {
  const t = useT();
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const level = state.muted ? 0 : state.volume;
  const set = (e: PointerEvent) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !(r.width > 0)) return;
    const v = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100) / 100;
    if (v > 0 && media.muted) media.muted = false;
    media.volume = v;
  };
  const Icon = level === 0 ? VolumeOffIcon : level < 0.5 ? VolumeLowIcon : VolumeHighIcon;
  return (
    <div className="group/vol flex min-w-0 items-center">
      <BarButton label={t(state.muted || state.volume === 0 ? 'pb_unmute' : 'pb_mute')} onClick={onMute}><Icon /></BarButton>
      {/* shrinks to the room the row has left (an audio bar in a narrow place); in an audio bar with under 15rem of
          content there is no room: mute only (PlayerBar) */}
      <div className="w-0 min-w-0 overflow-hidden transition-[width] group-focus-within/vol:w-[68px] group-hover/vol:w-[68px] @max-[15rem]:hidden">
        <div
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label={t('pb_volume')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          data-volume
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            set(e);
          }}
          onPointerMove={(e) => dragging.current && set(e)}
          onPointerUp={() => void (dragging.current = false)}
          onPointerCancel={() => void (dragging.current = false)}
          className="relative mx-1 flex h-6 cursor-pointer touch-none items-center outline-none"
        >
          <div className="relative h-1 w-full rounded-full bg-on-scrim/25">
            <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${level * 100}%` }} />
            <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" style={{ left: `${level * 100}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** The gap (px) between a chip and its menu. */
const MENU_GAP = 8;

/**
 * A bar chip with a menu of choices (radio items, the current one checked and focused on open); speed and the seek step
 * use it. `onOpen` tells the bar to stay visible while the menu is open. Esc and an outside press close it. The menu is a fixed layer in the page (in the fullscreen element while one is shown), above the chip or,
 * without room there, below it, and follows the chip when the page scrolls: a box that clips its content (a wide table's scroll box, issue 453) does not cut it.
 */
export function ChoiceMenu({ label, options, value, text, item = text, onPick, onOpen, className = '' }: {
  /** `text`: the chip; `item`: a menu row (the chip's text unless given). `className`: the chip's wrapper (PlayerBar). */
  className?: string; label: string; options: readonly number[]; value: number; text: (v: number) => string; item?: (v: number) => string; onPick: (v: number) => void; onOpen: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = (v: boolean) => { setOpen(v); onOpen(v); };
  // placed from the chip's box and the menu's own height: before the paint, and again whenever the chip moves (a scroll)
  const place = () => {
    const m = menu.current, b = btn.current?.getBoundingClientRect();
    if (!m || !b) return;
    const vh = window.innerHeight, h = m.offsetHeight;
    const up = b.top - MENU_GAP - h >= 0 || b.top >= vh - b.bottom;
    m.style.right = `${Math.max(0, window.innerWidth - b.right)}px`;
    m.style.bottom = up ? `${vh - b.top + MENU_GAP}px` : '';
    m.style.top = up ? '' : `${b.bottom + MENU_GAP}px`;
  };
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    const inside = (n: EventTarget | null) => n instanceof Node && (!!root.current?.contains(n) || !!menu.current?.contains(n));
    const away = (e: Event) => { if (!inside(e.target)) toggle(false); };
    // the chip moved: the fixed menu follows it
    const moved = () => place();
    const esc = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      toggle(false);
      btn.current?.focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    document.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
      document.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => onOpen(false), [onOpen]);
  return (
    <div ref={root} className={className}>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => toggle(!open)}
        className="h-8 min-w-9 cursor-pointer rounded-full px-2 text-[0.8125rem] font-medium whitespace-nowrap text-on-scrim/90 tabular-nums outline-none hover:bg-on-scrim/15 hover:text-on-scrim focus-visible:ring-2 focus-visible:ring-primary"
      >
        {text(value)}
      </button>
      {open && createPortal(
        <div ref={menu} role="menu" aria-label={label} data-player-menu className="fixed z-50 min-w-20 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              role="menuitemradio"
              aria-checked={o === value}
              onClick={() => { onPick(o); toggle(false); btn.current?.focus(); }}
              className={`flex w-full cursor-pointer items-center rounded-md px-2 py-1 text-xs outline-none hover:bg-muted focus-visible:bg-muted ${o === value ? 'font-semibold text-link' : ''}`}
            >
              {item(o)}
            </button>
          ))}
        </div>,
        document.fullscreenElement ?? document.body,
      )}
    </div>
  );
}
