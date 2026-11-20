import { useEffect, type RefObject } from 'react';
import { keysInScope } from '@/sdk';
import { inPlayerScope, ONCE } from '@/media/playerKeys.ts';
import { seekStep } from '@/media/seekStep.ts';
import type { CutPlayer } from './engine.ts';
import { edgeStep, frameStep } from './playback.ts';

/** The preview's keys by `code` (any layout), the media player's where they mean the same (docs/guide.md, video edits). */
const CODES = new Set(['Space', 'KeyK', 'KeyJ', 'KeyL', 'ArrowLeft', 'ArrowRight', 'Comma', 'Period', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * Applies `code` to the preview; false when it is not one of its keys. Space/K play and pause, J/L −10/+10 s, ← → the
 * player's seek step, `,` `.` one frame of the edit back or forward (pausing), ↑ ↓ the previous or next clip edge,
 * Home/End the start and the end.
 */
export function applyCutKey(p: CutPlayer, code: string): boolean {
  const t = p.time();
  const end = p.state().duration;
  switch (code) {
    case 'Space': case 'KeyK': p.toggle(); return true;
    case 'KeyJ': p.seek(t - 10); return true;
    case 'KeyL': p.seek(t + 10); return true;
    case 'ArrowLeft': p.seek(Math.round((t - seekStep.get()) * 1000) / 1000); return true;
    case 'ArrowRight': p.seek(Math.round((t + seekStep.get()) * 1000) / 1000); return true;
    case 'Comma': case 'Period':
      p.pause();
      p.seek(frameStep(p.time(), p.fps, code === 'Comma' ? -1 : 1, end));
      return true;
    case 'ArrowUp': case 'ArrowDown': {
      const cut = p.edit;
      if (cut) p.seek(edgeStep(cut, t, code === 'ArrowUp' ? -1 : 1));
      return true;
    }
    case 'Home': p.seek(0); return true;
    case 'End': p.seek(end); return true;
  }
  return false;
}

/**
 * The keys while the edit's tab is shown, focus is in it (or nowhere) and not in a field. Capture phase with
 * preventDefault and stopPropagation as usePlayerKeys does: Space never presses a focused button nor scrolls, arrows
 * never scroll the timeline. `edit`: the editor's keys, true for one it took.
 */
export function useCutKeys(player: CutPlayer, active: boolean, pane: RefObject<HTMLElement | null>, edit?: RefObject<((e: KeyboardEvent) => boolean) | null>): void {
  useEffect(() => {
    if (!active) return;
    let swallowKeyup = false;
    const onKey = (e: KeyboardEvent) => {
      if (!pane.current || !keysInScope(e, pane.current, inPlayerScope)) return;
      // the editor's keys first (issue 409): they take what they handle, the preview the rest
      if (edit?.current?.(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !CODES.has(e.code)) return;
      // a held key repeats the seeks and steps only, as in the player
      if (!(e.repeat && ONCE(e.code))) applyCutKey(player, e.code);
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Space') swallowKeyup = true;
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && swallowKeyup) { swallowKeyup = false; e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onUp, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onUp, true);
    };
  }, [player, active, pane, edit]);
}
