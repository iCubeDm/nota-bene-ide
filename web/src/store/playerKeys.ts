import { seekStep } from './seekStep.ts';

/** YouTube's keys for a media tab (see docs: player keys). `code`, not `key`: any keyboard layout. */

const FRAME = 1 / 30; // the frame rate is not exposed by the element; 30 fps is the usual

const MINUS = '−';
const sec = (n: number, unit: string) => `${n < 0 ? MINUS : '+'}${Math.abs(n)} ${unit}`;

/** Where focus may sit for the keys to stay ours: the tab's own file view, the tab strip, the file tree. */
const OURS = '[data-file-view], [role="tablist"], #tree-sheet';
export const THEIRS = '[role="dialog"], [role="menu"], [role="listbox"], [data-nb-modal]';
export const inPlayerScope = (f: Element): boolean => !f.closest(THEIRS) && !!f.closest(OURS);

/** The one-per-press keys: a held key must not toggle again and again. */
export const ONCE = (c: string) => !/^(Arrow|Comma|Period|Key[JL])/.test(c);

/**
 * Applies `code` to `el`; returns the on-screen flash text, or null when the key does not apply here (then the event
 * stays untouched: no preventDefault). `video`: frame step and fullscreen exist only for it. Fullscreen takes `box`, the
 * player container (video, marks, bar), so the marks and the bar stay visible; the element itself without one.
 */
export function applyPlayerKey(el: HTMLMediaElement, code: string, unit: string, box?: HTMLElement | null): string | null {
  const video = el instanceof HTMLVideoElement;
  const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
  const seek = (to: number) => void (el.currentTime = Math.max(0, Math.min(dur, to)));
  // a step lands on whole milliseconds: 0.1 s steps must not pile up float noise (the frame step stays exact: 1/30 s)
  const by = (d: number) => (seek(Math.round((el.currentTime + d) * 1000) / 1000), sec(d, unit));
  const vol = (d: number) => {
    if (d > 0 && el.muted) el.muted = false;
    el.volume = Math.max(0, Math.min(1, Math.round((el.volume + d) * 100) / 100));
    return `\u{1F50A} ${Math.round(el.volume * 100)} %`;
  };
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  switch (code) {
    case 'Space': case 'KeyK':
      if (el.paused) { void el.play()?.catch(() => {}); return '▶'; }
      el.pause();
      return '❚❚';
    case 'ArrowLeft': return by(-seekStep.get());
    case 'ArrowRight': return by(seekStep.get());
    case 'KeyJ': return by(-10);
    case 'KeyL': return by(10);
    case 'ArrowUp': return vol(0.05);
    case 'ArrowDown': return vol(-0.05);
    case 'KeyM': el.muted = !el.muted; return el.muted ? '\u{1F507}' : `\u{1F50A} ${Math.round(el.volume * 100)} %`;
    case 'KeyF':
      if (!video) return null;
      if (document.fullscreenElement) void document.exitFullscreen?.()?.catch(() => {});
      else void (box ?? el).requestFullscreen?.()?.catch(() => {});
      return '⛶';
    case 'Comma': case 'Period':
      if (!video || !el.paused) return null;
      seek(el.currentTime + (code === 'Comma' ? -FRAME : FRAME));
      return code === 'Comma' ? '◀▏' : '▕▶';
    case 'Home': seek(0); return '0 %';
    case 'End': if (!Number.isFinite(dur)) return null; seek(dur); return '100 %';
  }
  if (digit) {
    if (!Number.isFinite(dur)) return null;
    seek((dur * Number(digit[1])) / 10);
    return `${Number(digit[1]) * 10} %`;
  }
  return null;
}

export type Flash = { n: number; text: string };

/** The player's help rows: [keys, i18n id], shown as one group in the hotkey tooltip. */
export const PLAYER_HELP = [
  ['Space, K', 'pk_toggle'], ['← / →', 'pk_seek'], ['J / L', 'pk_seek10'], ['↑ / ↓', 'pk_volume'], ['M', 'pk_mute'],
  ['F', 'pk_fullscreen'], ['0…9', 'pk_percent'], [', / .', 'pk_frame'], ['Home / End', 'pk_ends'], ['N', 'pk_annotate'],
] as const;
