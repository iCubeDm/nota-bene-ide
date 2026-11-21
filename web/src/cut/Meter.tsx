import { useEffect, useRef, useState } from 'react';
import { useT, useStored } from '@/sdk';
import type { CutPlayer } from './engine.ts';
import { meterFrac, meterStep, METER_FLOOR, quiet, type MeterChannel } from './metering.ts';

// the scale's colours by dBFS, as meters have them: up to −18 dB, to −6 dB, and the last 6 dB
const SCALE = `linear-gradient(to right, var(--color-success) ${meterFrac(-18) * 100}%, var(--color-warn) ${meterFrac(-18) * 100}% ${meterFrac(-6) * 100}%, var(--color-destructive) ${meterFrac(-6) * 100}%)`;

const fmt = (db: number) => (db <= METER_FLOOR ? '−∞' : `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)}`);

/**
 * The preview's master level meter (issue 410): a bar per side in dBFS from −60 to 0, the peak held 1.5 s as a mark and
 * as a number, and a light that turns red once the mix reaches 0 dBFS and stays so until clicked. It reads the player
 * on each animation frame while playing; paused, the bars rest at the floor and the peak stays until the next play. Before the first play there is no audio
 * graph to read, and it makes none.
 */
export function Meter({ player }: { player: CutPlayer }) {
  const t = useT();
  const { playing } = useStored({ subscribe: player.subscribe, get: player.state });
  const chans = useRef<[MeterChannel, MeterChannel]>([quiet(), quiet()]);
  const covers = useRef<(HTMLSpanElement | null)[]>([]);
  const marks = useRef<(HTMLSpanElement | null)[]>([]);
  const readout = useRef<HTMLSpanElement | null>(null);
  const [clip, setClip] = useState(false);

  useEffect(() => {
    // the bars drawn straight into the elements: no render a frame
    const draw = () => {
      chans.current.forEach((c, i) => {
        const cover = covers.current[i];
        const mark = marks.current[i];
        if (cover) cover.style.width = `${(1 - meterFrac(c.level)) * 100}%`;
        if (mark) {
          mark.style.left = `${meterFrac(c.peak) * 100}%`;
          mark.style.display = c.peak > METER_FLOOR ? '' : 'none';
        }
      });
      if (readout.current) readout.current.textContent = fmt(Math.max(chans.current[0].peak, chans.current[1].peak));
    };
    // paused, the bars drop and the peaks stay as they were, to be read; a play starts them from the floor again
    const rest = (keep: boolean) => {
      chans.current = chans.current.map((c) => ({ ...quiet(), clip: c.clip, ...(keep && { peak: c.peak, peakAt: c.peakAt }) })) as [MeterChannel, MeterChannel];
      draw();
    };
    if (!playing) return rest(true);
    rest(false);
    let last = performance.now();
    let id = requestAnimationFrame(function frame(now) {
      const peaks = player.meterPeaks();
      if (peaks) {
        const dt = Math.max(0, now - last);
        chans.current = chans.current.map((c, i) => meterStep(c, peaks[i]!, dt, now)) as [MeterChannel, MeterChannel];
        draw();
        if (chans.current.some((c) => c.clip)) setClip(true);
      }
      last = now;
      id = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(id);
  }, [player, playing]);

  const reset = () => {
    chans.current = chans.current.map((c) => ({ ...c, clip: false })) as [MeterChannel, MeterChannel];
    setClip(false);
  };
  const clipTip = t(clip ? 'cutClipOn' : 'cutClipOff');
  return (
    <span data-cut-meter className="flex items-center gap-1" title={t('cutMeter')}>
      <span role="img" aria-label={t('cutMeter')} className="flex w-24 flex-col gap-px">
        {[0, 1].map((i) => (
          <span key={i} className="relative block h-1 overflow-hidden rounded-sm bg-muted" style={{ backgroundImage: SCALE }}>
            <span ref={(el) => { covers.current[i] = el; }} data-meter-cover className="absolute inset-y-0 right-0 w-full bg-muted" />
            <span ref={(el) => { marks.current[i] = el; }} data-meter-peak className="absolute inset-y-0 w-px -translate-x-full bg-foreground" style={{ display: 'none' }} />
          </span>
        ))}
      </span>
      <span ref={readout} data-meter-readout className="w-8 text-right tabular-nums">−∞</span>
      <button
        type="button" aria-label={clipTip} title={clipTip} onClick={reset}
        data-meter-clip={clip || undefined}
        className={`size-2.5 rounded-full border ${clip ? 'border-destructive bg-destructive' : 'border-border-soft bg-transparent'}`}
      />
    </span>
  );
}
