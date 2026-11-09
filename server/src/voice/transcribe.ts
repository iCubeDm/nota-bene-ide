// A stored recording to text: the parts one after the other through the one Whisper queue, each tried once more.
import type { VoiceError } from '@nota-bene/shared';
import type { AttachmentStore } from '../attachments.ts';
import { queued, transcribe as defaultTranscribe } from '../dictation/transcribe.ts';
import { samplesOf } from '../dictation/wav.ts';
import { splitPcm } from './parts.ts';

export type Transcribe = (pcm: Float32Array, lang: string) => Promise<string>;

/** Why a recording has no text, as the `voice-text` event tells it. */
export class VoiceFailure extends Error {
  readonly why: VoiceError;
  constructor(why: VoiceError, message: string = why) {
    super(message);
    this.why = why;
  }
}

/** The recording's samples; a VoiceFailure when the store has no recording under `id`. */
export function voiceSamples(store: AttachmentStore, id: string): Int16Array {
  const found = store.get(id);
  if (!found || found.mediaType !== 'audio/wav') throw new VoiceFailure('failed', `unknown recording ${id}`);
  return samplesOf(found.bytes);
}

/**
 * `alive`: asked before each part; false (the session moved on) stops it, so the one Whisper queue is not held for minutes
 * by a recording nobody waits for. The parts become floats one at a time, inside their turn of the queue.
 */
export async function transcribeVoice(store: AttachmentStore, id: string, lang: string, run: Transcribe = defaultTranscribe, alive: () => boolean = () => true): Promise<string> {
  const parts = splitPcm(voiceSamples(store, id));
  const texts: string[] = [];
  for (const p of parts) {
    if (!alive()) throw new VoiceFailure('failed', 'dropped');
    const once = () => queued(() => {
      const pcm = new Float32Array(p.length);
      for (let i = 0; i < p.length; i++) pcm[i] = p[i]! / 32768;
      return run(pcm, lang);
    });
    texts.push((await once().catch(once)).trim());
  }
  return texts.filter(Boolean).join(' ');
}
