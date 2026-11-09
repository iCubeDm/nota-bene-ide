import { useRef } from 'react';
import type { Voice } from '@nota-bene/shared';
import { useT } from '@/i18n/index.ts';
import { clock } from './lang.ts';
import { seek, toggle, usePlay } from './player.ts';

/** The recording's wave: bars 2 px wide with 1 px gaps, the played part in the primary colour; a click or a drag on it seeks. */
export function Wave({ wave, frac, onSeek }: { wave: number[]; frac: number; onSeek?: (f: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const at = (e: { clientX: number }) => {
    const r = box.current!.getBoundingClientRect();
    onSeek?.(Math.min(1, Math.max(0, r.width ? (e.clientX - r.left) / r.width : 0)));
  };
  const played = Math.round(frac * wave.length);
  return (
    <div
      ref={box}
      data-testid="wave"
      role={onSeek ? 'slider' : undefined}
      aria-valuenow={onSeek ? Math.round(frac * 100) : undefined}
      onPointerDown={onSeek ? (e) => { at(e); e.currentTarget.setPointerCapture?.(e.pointerId); } : undefined}
      onPointerMove={onSeek ? (e) => { if (e.buttons) at(e); } : undefined}
      className={`flex h-6 items-center gap-px ${onSeek ? 'cursor-pointer touch-none' : ''}`}
    >
      {wave.map((v, i) => (
        <span
          key={i}
          data-bar
          data-played={i < played || undefined}
          style={{ height: `${3 + Math.round((v / 31) * 19)}px` }}
          className="w-0.5 rounded-full bg-muted-foreground/40 data-[played]:bg-primary"
        />
      ))}
    </div>
  );
}

/** A round play/pause button, the wave and the length (the position while playing): the voice part of a bubble and of a clip. */
export function VoiceView({ voice }: { voice: Voice }) {
  const t = useT();
  const { playing, pos } = usePlay(voice.id);
  const frac = Math.min(1, pos / voice.ms);
  return (
    <div data-anchor-skip className="flex items-center gap-2.5">
      <button
        type="button"
        aria-label={playing ? t('voicePause') : t('voicePlay')}
        onClick={() => toggle(voice.id)}
        className="grid size-9 flex-none place-items-center rounded-full bg-primary text-primary-foreground hover:opacity-90"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
          {playing ? <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /> : <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />}
        </svg>
      </button>
      <div className="min-w-0">
        <Wave wave={voice.wave} frac={frac} onSeek={(f) => seek(voice.id, f * voice.ms)} />
        <div data-testid="voice-time" className="font-mono text-[0.65625rem] text-muted-foreground">{playing || pos > 0 ? clock(pos) : clock(voice.ms, true)}</div>
      </div>
    </div>
  );
}
