// A clip's sound on the timeline (issue 431): the waveform of its used part, its gain line and its fades with their
// handles at the clip's top corners. The drags themselves are the timeline's (useClipDrag in Timeline.tsx).
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { CUT_PEAKS_RATE } from '@nota-bene/shared/cut';
import { useT } from '@/i18n/index.ts';
import type { Block } from './layout.ts';
import { gainY } from './ops.ts';
import { dbGain } from './playback.ts';
import { peaksOf, type Wave as Waveform } from './peaks.ts';

/** Decibels as the timeline writes them: `+3 dB`, `−4.5 dB`, `0 dB`. */
export const dB = (g: number): string => `${g > 0 ? '+' : g < 0 ? '−' : ''}${Math.abs(g)} dB`;

/** A source's waveform once loaded (peaks.ts), or why it has none; null meanwhile or unknown. `src` null: none asked. */
export function usePeaks(src: string | null, fileSrc: string): Waveform | null {
  const [got, setGot] = useState<{ key: string; peaks: Waveform | null } | null>(null);
  const key = `${fileSrc}\n${src}`;
  useEffect(() => {
    if (src === null) return;
    let live = true;
    void peaksOf(src, fileSrc).then((peaks) => { if (live) setGot({ key, peaks }); });
    return () => { live = false; };
  }, [src, fileSrc, key]);
  return got?.key === key ? got.peaks : null;
}

/** The clip's fade envelope `x` seconds into it: up over the fade-in, down over the fade-out (playback.ts's fadeAt). */
const envelope = (b: Block, x: number): number =>
  Math.max(0, Math.min(1, b.fadeIn ? x / b.fadeIn : 1, b.fadeOut ? (b.len - x) / b.fadeOut : 1));

/**
 * The waveform of the clip's used part (`from` on in its source) between `x0` and `x1` px of the clip, at `pps`: each
 * column the loudest peak under it, scaled by the clip's gain and fades as it is heard, mirrored about the middle. A video
 * clip draws it in a band along its bottom, under the thumbnail's middle.
 */
export function Wave({ b, peaks, pps, x0, x1, band }: { b: Block; peaks: Uint8Array; pps: number; x0: number; x1: number; band: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.max(0, x1 - x0);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const h = c.clientHeight || (band ? 18 : 30);
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = getComputedStyle(c).color; // the canvas's text colour (its class)
    const level = dbGain(b.gain ?? 0);
    const H = c.height;
    for (let px = 0; px < c.width; px++) {
      const x = x0 + px / dpr; // CSS px into the clip
      const s = b.from + x / pps;
      const i0 = Math.floor(s * CUT_PEAKS_RATE);
      const i1 = Math.max(i0 + 1, Math.ceil((s + 1 / (dpr * pps)) * CUT_PEAKS_RATE));
      let max = 0;
      for (let i = Math.max(0, i0); i < Math.min(peaks.length, i1); i++) if (peaks[i]! > max) max = peaks[i]!;
      if (max === 0) continue;
      const amp = Math.min(1, (max / 255) * level * envelope(b, x / pps));
      const bar = Math.max(1, amp * H);
      g.fillRect(px, (H - bar) / 2, 1, bar);
    }
  }, [peaks, pps, x0, w, band, b.from, b.gain, b.fadeIn, b.fadeOut, b.len]);
  if (w <= 0) return null;
  return (
    <canvas
      ref={ref} data-wave aria-hidden
      className={`pointer-events-none absolute text-foreground/45 ${band ? 'bottom-0 h-[40%]' : 'inset-y-0 h-full'} ${b.mute ? 'opacity-40' : ''}`}
      style={{ left: x0, width: w }}
    />
  );
}

/** The fades as slopes over the clip: the faded corner shaded, a line from silence (black) up to full. */
export function FadeSlopes({ b, pps, w }: { b: Block; pps: number; w: number }) {
  const fi = Math.min(w, (b.fadeIn ?? 0) * pps);
  const fo = Math.min(w, (b.fadeOut ?? 0) * pps);
  if (!fi && !fo) return null;
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1, vectorEffect: 'non-scaling-stroke' } as const;
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full text-foreground/70" viewBox={`0 0 ${w} 100`} preserveAspectRatio="none">
      {fi > 0 && (
        <g data-fade-slope="in">
          <path d={`M0 0 L${fi} 0 L0 100 Z`} fill="currentColor" fillOpacity={0.18} />
          <path d={`M0 100 L${fi} 0`} {...line} />
        </g>
      )}
      {fo > 0 && (
        <g data-fade-slope="out">
          <path d={`M${w} 0 L${w - fo} 0 L${w} 100 Z`} fill="currentColor" fillOpacity={0.18} />
          <path d={`M${w - fo} 0 L${w} 100`} {...line} />
        </g>
      )}
    </svg>
  );
}

type Press = { onPointerDown: (e: PointerEvent<HTMLElement>) => void };

/** The gain line across the clip at its dB (ops.ts's gainY); `value`: the dB shown beside it while it is dragged. */
export function GainLine({ gain, press, value }: { gain: number; press: Press; value: boolean }) {
  const t = useT();
  const top = `${gainY(gain) * 100}%`;
  return (
    <>
      <div data-gain title={t('cutGainTip')} className="absolute inset-x-1.5 z-[2] h-2 -translate-y-1/2 cursor-ns-resize" style={{ top }} {...press}>
        <span className="absolute inset-x-0 top-1/2 h-px bg-[var(--nb-accent)] opacity-80" />
      </div>
      {value && (
        <span data-gain-value className="pointer-events-none absolute right-2 z-[4] -translate-y-full rounded bg-background/90 px-1 font-mono text-[0.625rem] text-foreground" style={{ top }}>
          {dB(gain)}
        </span>
      )}
    </>
  );
}

/** The trim edges' width, px (Timeline.tsx's `w-1.5`): a fade handle stays inside them, the very edge is the trim's. */
const TRIM_PX = 6;

/** A fade's handle at the clip's top corner, where its fade ends: dragged inward, the fade grows. */
export function FadeHandle({ edge, b, pps, w, press }: { edge: 'in' | 'out'; b: Block; pps: number; w: number; press: Press }) {
  const t = useT();
  const size = 8;
  const at = Math.max(TRIM_PX, Math.min(w - size - TRIM_PX, ((edge === 'in' ? b.fadeIn : b.fadeOut) ?? 0) * pps - size / 2));
  return (
    <span
      data-fade={edge} title={t(edge === 'in' ? 'cutFadeInTip' : 'cutFadeOutTip')}
      className="absolute top-0 z-[3] size-2 cursor-ew-resize rounded-sm border border-foreground/70 bg-background hover:bg-[var(--nb-accent)]"
      style={edge === 'in' ? { left: at } : { right: at }} {...press}
    />
  );
}
