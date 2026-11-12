// A stored recording to text: the parts one after the other through the one Whisper queue, each tried once more.
import type { VoiceError } from '@nota-bene/shared';
import type { AttachmentStore } from '../attachments.ts';
import { WhisperBusy, WhisperOff } from '../dictation/hostClient.ts';
import { queued, spokenOf, transcribeWith as defaultTranscribe, type Spoken, type SpokenOrText } from '../dictation/transcribe.ts';
import { samplesOf } from '../dictation/wav.ts';
import { splitPcm } from './parts.ts';

/** `detect`: `lang` is only the hint. Answers the text, or the text and the language it was made in. `signal`: aborts when nobody waits for the part any more. */
export type Transcribe = (pcm: Float32Array, lang: string, detect?: boolean, signal?: AbortSignal) => Promise<SpokenOrText>;

/** How often `alive` is asked while a part waits for the model. */
export const ALIVE_POLL_MS = 250;

/** Why a recording has no text, as the `voice-text` event tells it. */
export class VoiceFailure extends Error {
  readonly why: VoiceError;
  constructor(why: VoiceError, message: string = why) {
    super(message);
    this.why = why;
  }
}

/** The Whisper host's queue was full: the message fails as any other (`failed`); the HTTP route says 503 `busy`. */
export class VoiceBusy extends VoiceFailure {
  constructor() { super('failed', 'busy'); }
}

/** The recording's samples; a VoiceFailure when the store has no recording under `id`. */
export function voiceSamples(store: AttachmentStore, id: string): Int16Array {
  const found = store.get(id);
  if (!found || found.mediaType !== 'audio/wav') throw new VoiceFailure('failed', `unknown recording ${id}`);
  return samplesOf(found.bytes);
}

/**
 * `alive`: asked before each part, and while one waits for the model; false (the session moved on) stops it, and the part still
 * queued (here or at the Whisper host) is cancelled, so the one Whisper queue is not held for minutes by a recording nobody
 * waits for. The parts become floats one at a time, inside their turn of the queue.
 * `detect`: the language is detected on the first part and that one is kept for the rest (one language per message, no
 * flip-flopping between parts); `lang` is the hint. The answer names the language the message was transcribed in.
 */
export async function transcribeVoice(store: AttachmentStore, id: string, lang: string, run: Transcribe = defaultTranscribe, alive: () => boolean = () => true, detect = false): Promise<Spoken> {
  const parts = splitPcm(voiceSamples(store, id));
  const texts: string[] = [];
  let using = lang;
  let first = true;
  for (const p of parts) {
    if (!alive()) throw new VoiceFailure('failed', 'dropped');
    const dropped = new AbortController();
    const watch = setInterval(() => { if (!alive()) dropped.abort(); }, ALIVE_POLL_MS);
    const once = () => queued(() => {
      const pcm = new Float32Array(p.length);
      for (let i = 0; i < p.length; i++) pcm[i] = p[i]! / 32768;
      return run(pcm, using, detect && first, dropped.signal);
    }, dropped.signal);
    let got: ReturnType<typeof spokenOf>;
    try {
      // a part is tried once more, except when the host is busy or off (nothing changes at once) or nobody waits any more
      got = spokenOf(await once().catch((e: unknown) => (e instanceof WhisperBusy || e instanceof WhisperOff || dropped.signal.aborted ? Promise.reject(e) : once())));
    } catch (e) {
      if (dropped.signal.aborted) throw new VoiceFailure('failed', 'dropped');
      if (e instanceof WhisperBusy) throw new VoiceBusy();
      if (e instanceof WhisperOff) throw new VoiceFailure('off');
      throw e;
    } finally {
      clearInterval(watch);
    }
    if (first && got.lang) using = got.lang;
    first = false;
    texts.push(got.text.trim());
  }
  return { text: texts.filter(Boolean).join(' '), lang: using };
}
