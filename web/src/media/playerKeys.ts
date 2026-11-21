import { has } from '@nota-bene/shared';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { keysInScope, useT, useAppDispatch, useAppSelector, type AppDispatch, applyPlayerKey, inPlayerScope, ONCE, type Flash } from '@/sdk';
import { setMode } from './markup/slice.ts';

/** N and the bar's ✎: one still frame, then the markup mode. */
export function startAnnotate(dispatch: AppDispatch, tabId: string, m: HTMLVideoElement | HTMLImageElement): void {
  if (m instanceof HTMLVideoElement && !m.paused) m.pause();
  dispatch(setMode(tabId, true));
}

/**
 * The visible media tab's player keys, plus N = annotate. Off while marking up (the markup mode owns the keys then).
 * Capture phase and preventDefault+stopPropagation: a focused <video> must not also act on its own, and Space neither
 * scrolls nor presses a focused button (its keyup is swallowed too, Firefox clicks on it).
 * `image`: the element N annotates; `media`: the video/audio the rest acts on (null for an image tab).
 */
export function usePlayerKeys({ tabId, active, marking, media, image, box }: {
  tabId: string; active: boolean; marking: boolean; media: MutableRefObject<HTMLMediaElement | null>; image: HTMLImageElement | null;
  box?: MutableRefObject<HTMLElement | null>;
}): Flash | null {
  const t = useT();
  const dispatch = useAppDispatch();
  const offered = useAppSelector((s) => has(s.controls.protocol, 'mediaAnchors'));
  const [flash, setFlash] = useState<Flash | null>(null);
  const n = useRef(0);
  const unit = t('unitSec');
  useEffect(() => {
    if (!active || marking) return;
    let swallowKeyup = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const code = e.code.replace(/^Numpad(\d)$/, 'Digit$1');
      const el = media.current ?? image;
      if (!el || !keysInScope(e, el, inPlayerScope)) return;
      if (code === 'KeyN') {
        const m = media.current ?? image;
        if (!offered || !(m instanceof HTMLVideoElement || m instanceof HTMLImageElement)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        startAnnotate(dispatch, tabId, m);
        return;
      }
      if (!media.current) return;
      const text = e.repeat && ONCE(code) ? '' : applyPlayerKey(media.current, code, unit, box?.current);
      if (text === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (code === 'Space') swallowKeyup = true;
      if (text) setFlash({ n: ++n.current, text });
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
  }, [active, marking, media, image, box, offered, dispatch, tabId, unit]);
  return flash;
}
