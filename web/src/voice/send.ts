import { has, type Voice } from '@nota-bene/shared';
import { chat, selectBusy, selectConn, serverEvent, refusedWhy, t, toast, type AppThunk, type StartListening, dictationAsk } from '@/sdk';
import { takeVoiceSend, trackVoiceSend, voiceRefused, voiceSendEchoed } from './inflight.ts';

/**
 * Sends an uploaded recording as a message of its own: no text, no images. While the agent works it waits its
 * turn, as a typed message does; `force` (only meant while busy, as `sendMessage`'s) interrupts the agent instead.
 * The draft and the composer's images stay where they are. `rides`: the pending comments go with it (protocol 16; the
 * phone does the same): the same send as a typed message's, with the comments' part alone, composed now; without it (a
 * retry from a bubble) or with no comment to take, the recording goes alone.
 * False when nothing was sent (offline, mid-switch).
 */
export const sendVoice = (voice: Voice, id: string = crypto.randomUUID(), force = false, rides = false): AppThunk<boolean> => (d, getState, { connections }) => {
  const st = getState();
  if (selectConn(st) !== 'open' || st.controls.switching) return false;
  if (rides && has(st.controls.protocol, 'voiceComments')) {
    const r = d(chat.send('', { force, parts: ['comments'], voice: { voice, ask: dictationAsk(st) }, id }));
    if (r !== 'empty') {
      if (r === 'sent') trackVoiceSend(id, voice);
      return r === 'sent';
    }
  }
  const ok = connections.current().send({ type: 'send', id, text: '', voice: { id: voice.id, ms: voice.ms, wave: voice.wave }, ...dictationAsk(st), ...(force && selectBusy(st) ? { force: true } : {}) });
  if (ok) trackVoiceSend(id, voice);
  return ok;
};

/**
 * A voice send's echo, or its refusal (issue 511: the voice plugin's own, no longer the composer's). A voice message has
 * no draft: the refusal is told and its recording comes back in the composer's preview (Send again); the comments that
 * rode along are given back by the send itself.
 */
export const voiceSendListener = (start: StartListening): void => void start({
  actionCreator: serverEvent,
  effect: ({ payload: ev }) => {
    if (ev.kind === 'user' || ev.kind === 'send-held') return voiceSendEchoed(ev.id);
    const voice = ev.kind === 'send-refused' ? takeVoiceSend(ev.id) : undefined;
    if (ev.kind !== 'send-refused' || !voice) return;
    toast(t('voiceRefused', refusedWhy(ev.reason)), '');
    voiceRefused(voice);
  },
});
