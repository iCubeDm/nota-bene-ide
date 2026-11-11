import type { Voice } from '@nota-bene/shared';
import { selectBusy, selectConn, type AppThunk } from '@/store/store.ts';
import { voiceComments } from '../comments/send.ts';
import { dictationAsk } from './lang.ts';
import { trackVoiceSend } from './inflight.ts';

/**
 * Sends an uploaded recording as a message of its own: no text, no images. While the agent works it waits its
 * turn, as a typed message does; `force` (only meant while busy, as `sendMessage`'s) interrupts the agent instead.
 * The draft and the composer's images stay where they are. `rides`: the pending comments go with it (protocol 16; the
 * phone does the same), composed now; without it (a retry from a bubble) the recording goes alone.
 * False when nothing was sent (offline, mid-switch).
 */
export const sendVoice = (voice: Voice, id: string = crypto.randomUUID(), force = false, rides = false): AppThunk<boolean> => (d, getState, { send }) => {
  const st = getState();
  if (selectConn(st) !== 'open' || st.controls.switching) return false;
  if (rides) {
    const r = d(voiceComments(id, voice, force));
    if (r.ids.length) {
      if (r.sent) trackVoiceSend(id, voice, r.ids);
      return r.sent;
    }
  }
  const ok = send({ type: 'send', id, text: '', voice: { id: voice.id, ms: voice.ms, wave: voice.wave }, ...dictationAsk(st), ...(force && selectBusy(st) ? { force: true } : {}) });
  if (ok) trackVoiceSend(id, voice, []);
  return ok;
};
