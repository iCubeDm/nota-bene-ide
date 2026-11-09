// A stored recording to text: the parts one after the other through the one Whisper queue, each tried once more.
import type { VoiceError } from '@nota-bene/shared';
import type { AttachmentStore } from '../attachments.ts';
import { queued, transcribe as defaultTranscribe } from '../dictation/transcribe.ts';
import { pcmFromWav } from '../dictation/wav.ts';
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

/** The recording's PCM; a VoiceFailure when the store has no recording under `id`. */
export function voicePcm(store: AttachmentStore, id: string): Float32Array {
  const found = store.get(id);
  if (!found || found.mediaType !== 'audio/wav') throw new VoiceFailure('failed', `unknown recording ${id}`);
  return pcmFromWav(found.bytes);
}

export async function transcribeVoice(store: AttachmentStore, id: string, lang: string, run: Transcribe = defaultTranscribe): Promise<string> {
  const parts = splitPcm(voicePcm(store, id));
  const texts: string[] = [];
  for (const p of parts) {
    // a copy of a part, not a view: posting a view to the worker would clone the whole recording's buffer
    const pcm = parts.length > 1 ? p.slice() : p;
    const once = () => queued(() => run(pcm, lang));
    texts.push((await once().catch(once)).trim());
  }
  return texts.filter(Boolean).join(' ');
}
