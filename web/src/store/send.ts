import { createAction } from '@reduxjs/toolkit';
import type { ImageRef } from '@nota-bene/shared';
import { getLang, t } from '../i18n/index.ts';
import { toast } from '../shell/toast.ts';
import type { Registry, SendResult, Taken } from '../sdk/registry.ts';
import { connState, sendMessage, serverEvent, type AppThunk, type RootState, type StartListening, type VoiceSend } from './store.ts';

/** How long a part may take to be ready (a combined image) before the send goes on without waiting for it. */
export const COMPOSITE_MS = 15_000;

/** A send waits for its parts to be ready (`true`) or has stopped waiting: the composer's Send is off meanwhile. */
export const sendBuilding = createAction<boolean>('chat/building');

/** The sends the server has not answered yet, by message id: what each took, given back on a refusal. One per store. */
export type SentParts = Map<string, Taken[]>;

/** The items every part would take now (the Send button's count). */
export const sendCount = (r: Registry, s: RootState): number => r.sendParts.reduce((n, p) => n + (p.count?.(s) ?? 0), 0);
/** Some part holds items that wait, sendable or not. */
export const sendWaiting = (r: Registry, s: RootState): boolean => r.sendParts.some((p) => p.waiting?.(s));

/** After the wait: anything but 'sent' is told to the user, never silent. */
const tell = (r: SendResult): void => {
  if (r === 'offline') toast(t('offline'), '');
  else if (r === 'switching') toast(t('switching'), '');
  else if (r === 'changed') toast(t('changedWhileSending'), '');
};

export type SendOptions = {
  /** interrupt the agent (only while it works) */
  force?: boolean;
  /** the ids of the parts to take (default: every part) */
  parts?: readonly string[];
  /** a recording: no draft goes, nothing waits */
  voice?: VoiceSend;
  id?: string;
};

/**
 * Sends a message (issue 511): `text`, then each part's in ascending order. SNAPSHOT AT THE CLICK: every part is taken
 * now (its items marked, so no second click and nothing added meanwhile touches them). A part not ready yet (a combined
 * image) is waited for up to `COMPOSITE_MS` ('building'); then, if the session and every part are unchanged, the parts
 * are composed in order (each sees the images before its own) and the message goes. Any end but 'sent' gives every part
 * back, and so does the server's refusal later.
 */
export const send = (text = '', o: SendOptions = {}): AppThunk<SendResult> => (d, getState, { registry, sent }) => {
  const st = getState();
  if (st.controls.switching) return 'switching'; // the server refuses sends mid-switch: the draft and the comments stay for the new session
  const taken: Taken[] = [];
  const release = (r: SendResult): SendResult => {
    for (const p of taken) p.released?.();
    return r;
  };
  for (const p of registry.sendParts) {
    if (o.parts && !o.parts.includes(p.id)) continue;
    const r = p.take(st, d, { voice: !!o.voice, registry });
    if (typeof r === 'string') return release(r);
    if (r) taken.push(r);
  }
  if (!taken.length && !text) return 'empty';
  const sid = st.feed.session?.id;
  const go = (): SendResult => {
    const now = getState();
    if (now.controls.switching) return release('switching');
    if (now.feed.session?.id !== sid || !taken.every((p) => p.unchanged?.(now) ?? true)) return release('changed');
    const lang = getLang();
    const texts = text ? [text] : [], images: ImageRef[] = [], commentIds: string[] = [];
    for (const p of taken) {
      const c = p.compose({ s: now, lang, images: [...images] });
      if (c.text) texts.push(c.text);
      images.push(...(c.images ?? []));
      commentIds.push(...(c.commentIds ?? []));
    }
    const id = o.id ?? crypto.randomUUID();
    if (!d(sendMessage(texts.join('\n\n'), !!o.force, commentIds, images, id, o.voice))) return release('offline');
    if (taken.some((p) => p.released)) sent.set(id, taken);
    for (const p of taken) p.sent?.(id);
    return 'sent';
  };
  const ready = taken.flatMap((p) => (p.ready ? [p.ready] : []));
  if (!ready.length) return go();
  d(sendBuilding(true));
  // a stalled part must not keep Send off for good: past COMPOSITE_MS the send goes on without it
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('composite timeout')), COMPOSITE_MS); });
  void Promise.race([Promise.all(ready), late])
    .catch(() => {})
    .then(() => {
      clearTimeout(timer);
      d(sendBuilding(false));
      try {
        tell(go());
      } catch (e) {
        release('changed'); // the parts are theirs again, nothing lost
        console.error('send after the composite failed', e);
        toast(t('sendFailedRetry'), '');
      }
    });
  return 'building';
};

/**
 * The server's answer to a send: its refusal (`send-refused`) gives every part back; the echo, a `send-held`, a new
 * history or a closed socket (the refusal can no longer arrive) forgets it.
 */
export const sendListener = (start: StartListening, sent: SentParts): void => {
  start({
    actionCreator: serverEvent,
    effect: ({ payload: ev }) => {
      if (ev.kind === 'send-refused') {
        const parts = sent.get(ev.id);
        sent.delete(ev.id);
        for (const p of parts ?? []) p.released?.();
      } else if (ev.kind === 'user' || ev.kind === 'send-held') sent.delete(ev.id);
      else if (ev.kind === 'replay') sent.clear();
    },
  });
  start({ actionCreator: connState, effect: ({ payload }) => void (payload !== 'open' && sent.clear()) });
};
