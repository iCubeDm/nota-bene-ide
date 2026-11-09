import { isVoice, type Voice, type VoiceError } from '@nota-bene/shared';
import { apiFetch } from '@/net/auth.ts';

/** POST /voice with the WAV: the host stores it and answers its id, length and wave. Throws on any failure. */
export async function uploadVoice(wav: Blob): Promise<Voice> {
  const r = await apiFetch('/voice', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav });
  if (!r.ok) throw new Error(`voice ${r.status}`);
  const j: unknown = await r.json();
  if (!isVoice(j)) throw new Error('bad voice reply');
  return { id: j.id, ms: j.ms, wave: [...j.wave] };
}

/** POST /voice/<id>/text: a clip's transcript. The same three reasons a voice message has for no text. */
export async function transcribeVoice(id: string, lang: string): Promise<{ text: string } | { error: VoiceError }> {
  try {
    const r = await apiFetch(`/voice/${id}/text?lang=${encodeURIComponent(lang)}`, { method: 'POST' });
    if (r.status === 503) return { error: 'off' };
    if (!r.ok) return { error: 'failed' };
    const j = (await r.json()) as { text?: unknown };
    if (typeof j.text !== 'string') return { error: 'failed' };
    return j.text.trim() ? { text: j.text.trim() } : { error: 'empty' };
  } catch {
    return { error: 'failed' };
  }
}
