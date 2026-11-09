import type { Voice } from '@nota-bene/shared';
import { selectConn, type AppThunk } from '@/store/store.ts';
import { whisperLang } from './lang.ts';

/** ids of voice sends the server has not echoed yet: a `send-refused` for one of them is told to the user (composer/refused.ts) */
const inFlight = new Set<string>();
export const takeVoiceSend = (id: string): boolean => inFlight.delete(id);
export const voiceSendEchoed = (id: string): void => void inFlight.delete(id);

/**
 * Sends an uploaded recording as a message of its own: no text, no images, no comments, never forced (it waits its
 * turn). The draft and the pending comments stay in the composer. False when nothing was sent (offline, mid-switch).
 */
export const sendVoice = (voice: Voice, id: string = crypto.randomUUID()): AppThunk<boolean> => (_d, getState, { send }) => {
  const st = getState();
  if (selectConn(st) !== 'open' || st.controls.switching) return false;
  const ok = send({ type: 'send', id, text: '', voice: { id: voice.id, ms: voice.ms, wave: voice.wave }, lang: whisperLang() });
  if (ok) inFlight.add(id);
  return ok;
};
