import type { Voice } from '@nota-bene/shared';
import { selectConn, type AppThunk } from '@/store/store.ts';
import { whisperLang } from './lang.ts';

/** voice sends the server has not echoed yet, by message id: a `send-refused` for one of them is told to the user and the voice comes back (composer/refused.ts) */
const inFlight = new Map<string, Voice>();
/** the voice of a refused send (and forgets it), or undefined when `id` was no voice send */
export const takeVoiceSend = (id: string): Voice | undefined => {
  const v = inFlight.get(id);
  inFlight.delete(id);
  return v;
};
export const voiceSendEchoed = (id: string): void => void inFlight.delete(id);

const refusedListeners = new Set<(v: Voice) => void>();
/** The composer listens: a refused voice send goes back to its preview. */
export const onVoiceRefused = (fn: (v: Voice) => void): (() => void) => (refusedListeners.add(fn), () => void refusedListeners.delete(fn));
export const voiceRefused = (v: Voice): void => { for (const fn of refusedListeners) fn(v); };

/**
 * Sends an uploaded recording as a message of its own: no text, no images, no comments, never forced (it waits its
 * turn). The draft and the pending comments stay in the composer. False when nothing was sent (offline, mid-switch).
 */
export const sendVoice = (voice: Voice, id: string = crypto.randomUUID()): AppThunk<boolean> => (_d, getState, { send }) => {
  const st = getState();
  if (selectConn(st) !== 'open' || st.controls.switching) return false;
  const ok = send({ type: 'send', id, text: '', voice: { id: voice.id, ms: voice.ms, wave: voice.wave }, lang: whisperLang() });
  if (ok) inFlight.set(id, voice);
  return ok;
};
