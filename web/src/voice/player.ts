import { useSyncExternalStore } from 'react';

/** What a bubble shows of its recording: playing now, and the position in ms. */
export type PlayState = { playing: boolean; pos: number };
const IDLE: PlayState = { playing: false, pos: 0 };

/** Recently used elements, oldest first: a feed of many voice messages must not keep an element (and its buffered audio) for each. */
const KEEP = 4;
const audios = new Map<string, HTMLAudioElement>();
const states = new Map<string, PlayState>();
const listeners = new Set<() => void>();

const set = (id: string, s: PlayState) => {
  const cur = states.get(id) ?? IDLE;
  if (cur.playing === s.playing && cur.pos === s.pos) return;
  states.set(id, s);
  for (const fn of listeners) fn();
};

/** The element for a recording, made on first use: `<audio>` on the same-origin `/voice/<id>` (Range works, the cookie goes along, as for `/attach`); a recording not yet sent plays from its own `src` (a blob URL). */
function audioOf(id: string, src = `/voice/${id}`): HTMLAudioElement {
  let a = audios.get(id);
  if (a) {
    audios.delete(id); // used now: to the young end
    audios.set(id, a);
    return a;
  }
  a = new Audio(src);
  a.preload = 'none';
  const el = a;
  const sync = () => set(id, { playing: !el.paused && !el.ended, pos: Math.round(el.currentTime * 1000) });
  for (const ev of ['play', 'pause', 'timeupdate', 'seeked']) el.addEventListener(ev, sync);
  el.addEventListener('ended', () => set(id, { playing: false, pos: 0 }));
  audios.set(id, el);
  // over the limit: the oldest ones that are not playing go (their next play makes a new element)
  for (const [old, e] of audios) {
    if (audios.size <= KEEP) break;
    if (old !== id && e.paused) release(old);
  }
  return el;
}

/** Plays or pauses a recording. One voice plays at a time, across bubbles and clips: starting one pauses the others. */
export function toggle(id: string, src?: string): void {
  const a = audioOf(id, src);
  if (!a.paused) {
    a.pause();
    return;
  }
  for (const [other, el] of audios) if (other !== id && !el.paused) el.pause();
  void Promise.resolve(a.play()).catch(() => set(id, { playing: false, pos: Math.round(a.currentTime * 1000) }));
}

/** Seeks to `ms`; the position shows at once, even before the audio has loaded. */
export function seek(id: string, ms: number, src?: string): void {
  const a = audioOf(id, src);
  a.currentTime = ms / 1000;
  set(id, { playing: !a.paused, pos: Math.round(ms) });
}

/** Stops and forgets a recording (a deleted clip, a cancelled preview): nothing keeps playing for it. */
export function release(id: string): void {
  const a = audios.get(id);
  if (!a) return;
  a.pause();
  audios.delete(id);
  states.delete(id);
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));

export const usePlay = (id: string): PlayState => useSyncExternalStore(subscribe, () => states.get(id) ?? IDLE);

/** For tests: forget everything. */
export function resetPlayer(): void {
  for (const a of audios.values()) a.pause();
  audios.clear();
  states.clear();
}
