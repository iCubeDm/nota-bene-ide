import { dictationSet } from '@/controls/slice.ts';
import { apiFetch } from '@/net/auth.ts';
import type { AppDispatch } from '@/store/store.ts';

/** `GET /dictation`: the optional Whisper install that transcribes voice messages and the phone's microphone */
export type Dictation = { on: boolean; phase: 'none' | 'installing' | 'ready' | 'failed'; downloadMb: number; diskMb: number; dir: string; model: string };

export async function getDictation(): Promise<Dictation> {
  const r = await apiFetch('/dictation');
  if (!r.ok) throw new Error(`/dictation ${r.status}`);
  return (await r.json()) as Dictation;
}

/**
 * The composer's and the comment popup's mic read the capabilities, which only `hello` sets: a change of Whisper that a
 * POST to `/dictation/on | remove` made is told to them here, in the tick of the answer.
 */
export function dictationChanged(dispatch: AppDispatch, url: string, body: unknown): void {
  if (url === '/dictation/remove') dispatch(dictationSet(false));
  else if (url === '/dictation/on') dispatch(dictationSet((body as { on: boolean }).on));
}

/** Settings → Dictation and the mic's prompt act through POSTs to `/dictation/install | on | remove`. Throws on a refusal. */
export async function postDictation(dispatch: AppDispatch, url: string, body: unknown = {}): Promise<void> {
  const r = await apiFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}`);
  dictationChanged(dispatch, url, body);
}
