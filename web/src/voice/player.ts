import { useSyncExternalStore } from 'react';

/** What a bubble shows of its recording: playing now, and the position in ms. */
export type PlayState = { playing: boolean; pos: number };
const IDLE: PlayState = { playing: false, pos: 0 };

const audios = new Map<string, HTMLAudioElement>();
const states = new Map<string, PlayState>();
const listeners = new Set<() => void>();

const set = (id: string, s: PlayState) => {
  const cur = states.get(id) ?? IDLE;
  if (cur.playing === s.playing && cur.pos === s.pos) return;
  states.set(id, s);
  for (const fn of listeners) fn();
};

/** The element for a recording, made on first use: `<audio>` on the same-origin `/voice/<id>` (Range works, the cookie goes along, as for `/attach`). */
function audioOf(id: string): HTMLAudioElement {
  let a = audios.get(id);
  if (a) return a;
  a = new Audio(`/voice/${id}`);
  a.preload = 'none';
  const el = a;
  const sync = () => set(id, { playing: !el.paused && !el.ended, pos: Math.round(el.currentTime * 1000) });
  for (const ev of ['play', 'pause', 'timeupdate', 'seeked']) el.addEventListener(ev, sync);
  el.addEventListener('ended', () => set(id, { playing: false, pos: 0 }));
  audios.set(id, el);
  return el;
}

/** Plays or pauses a recording. One voice plays at a time, across bubbles and clips: starting one pauses the others. */
export function toggle(id: string): void {
  const a = audioOf(id);
  if (!a.paused) {
    a.pause();
    return;
  }
  for (const [other, el] of audios) if (other !== id && !el.paused) el.pause();
  void Promise.resolve(a.play()).catch(() => set(id, { playing: false, pos: Math.round(a.currentTime * 1000) }));
}

/** Seeks to `ms`; the position shows at once, even before the audio has loaded. */
export function seek(id: string, ms: number): void {
  const a = audioOf(id);
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
