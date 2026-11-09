import { openSettings } from '@/tabs/slice.ts';
import type { AppDispatch } from '@/store/store.ts';

/** The mic without Whisper: opens the Settings tab and brings the Dictation section into view (it may mount a moment later). */
export function openDictationSettings(dispatch: AppDispatch): void {
  dispatch(openSettings());
  let tries = 0;
  const look = () => {
    const el = document.getElementById('settings-dictation');
    if (el) el.scrollIntoView?.({ block: 'start' });
    else if (++tries < 10) setTimeout(look, 50);
  };
  setTimeout(look, 0);
}
