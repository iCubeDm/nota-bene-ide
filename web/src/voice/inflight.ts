import type { Voice } from '@nota-bene/shared';

/** voice sends the server has not echoed yet, by message id: a `send-refused` for one of them is told to the user and the voice comes back (composer/refused.ts) */
const inFlight = new Map<string, { voice: Voice; commentIds: string[] }>();
/** the voice of a refused send and the comments it carried (and forgets it), or undefined when `id` was no voice send */
export const takeVoiceSend = (id: string): { voice: Voice; commentIds: string[] } | undefined => {
  const v = inFlight.get(id);
  inFlight.delete(id);
  return v;
};
export const voiceSendEchoed = (id: string): void => void inFlight.delete(id);

const refusedListeners = new Set<(v: Voice) => void>();
/** The composer listens: a refused voice send goes back to its preview. */
export const onVoiceRefused = (fn: (v: Voice) => void): (() => void) => (refusedListeners.add(fn), () => void refusedListeners.delete(fn));
export const voiceRefused = (v: Voice): void => { for (const fn of refusedListeners) fn(v); };

export const trackVoiceSend = (id: string, voice: Voice, commentIds: string[]): void => void inFlight.set(id, { voice, commentIds });
