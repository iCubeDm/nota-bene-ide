import { type AppDispatch, openView } from '@/sdk';

/** The mic without Whisper: opens the Settings tab and brings the Dictation section into view (it may mount a moment later). */
export function openDictationSettings(dispatch: AppDispatch): void {
  dispatch(openView('settings'));
  let tries = 0;
  const look = () => {
    const el = document.getElementById('settings-dictation');
    if (el) el.scrollIntoView?.({ block: 'start' });
    else if (++tries < 10) setTimeout(look, 50);
  };
  setTimeout(look, 0);
}
