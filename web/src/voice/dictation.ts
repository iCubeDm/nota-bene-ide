import { dictationLangSet, dictationSet } from '@/controls/slice.ts';
import { connections, defineResource, routes, type AppDispatch } from '@/sdk';

/** `GET /dictation`: the optional Whisper install that transcribes voice messages and the phone's microphone */
export type Dictation = { on: boolean; phase: 'none' | 'installing' | 'ready' | 'failed'; downloadMb: number; diskMb: number; dir: string; model: string; /** protocol 18: `auto` or an ISO 639 code */ dictationLang?: string };

export const dictationResource = defineResource<void, Dictation>({ key: () => '', route: () => routes.dictation() });

/**
 * The composer's and the comment popup's mic read the capabilities, which only `hello` sets: a change of Whisper that a
 * POST to `/dictation/on | remove` made is told to them here, in the tick of the answer.
 */
export function dictationChanged(dispatch: AppDispatch, url: string, body: unknown): void {
  if (url === routes.dictation('remove')) dispatch(dictationSet(false));
  else if (url === routes.dictation('lang')) dispatch(dictationLangSet((body as { lang: string }).lang));
  else if (url === routes.dictation('on')) dispatch(dictationSet((body as { on: boolean }).on));
}

/** Settings → Dictation and the mic's prompt act through POSTs to `/dictation/install | on | remove`. Throws on a refusal. */
export async function postDictation(dispatch: AppDispatch, url: string, body: unknown = {}): Promise<void> {
  const r = await connections.current().fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}`);
  dictationChanged(dispatch, url, body);
}
