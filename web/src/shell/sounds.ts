import { useEffect } from 'react';
import type { Store } from '@reduxjs/toolkit';
import { useStore } from 'react-redux';
import { apiFetch } from '@/net/auth.ts';
import type { RootState } from '@/store/store.ts';

/**
 * A sound when the tab is not looked at and the window needs the user (issue 136): `ask` when a permission, a plan or a
 * question starts waiting, `done` / `error` when a live turn ends. Which of them sound is one setting for every window
 * (Settings → Defaults, prefs.json), read right before each cue, so a change applies at once everywhere. A replay
 * (a reconnect, a reload) never sounds. Of several tabs of one window only one sounds, and none while one of them is
 * looked at. Each window is its own origin, so separate windows each sound for their own prompt.
 */

export type Cue = 'ask' | 'done' | 'error';
export type Sounds = { ask: boolean; done: boolean };

/** A tab that is looked at claims the cue at once; the others wait this long first, so it wins the claim. */
export const SETTLE_MS = 300;
const CLAIM = 'nb.sound.last';

// [Hz, start s]: two rising notes ask; one soft note says done; two falling ones say it failed
const TONES: Record<Cue, [number, number][]> = { ask: [[880, 0], [1175, 0.12]], done: [[660, 0]], error: [[440, 0], [330, 0.14]] };
const VOLUME: Record<Cue, number> = { ask: 0.2, done: 0.12, error: 0.12 };

let ctx: AudioContext | null = null;
const audio = (): AudioContext | null => {
  const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!ctx && AC) ctx = new AC();
  return ctx;
};
/** A user gesture lets the page's audio start (the autoplay rule): until the first one, a cue is silent. */
export const unlockAudio = () => { const c = audio(); if (c?.state === 'suspended') void c.resume().catch(() => {}); };

/** Plays a cue, generated with Web Audio (no asset). */
export function playCue(cue: Cue): void {
  const c = audio();
  if (!c) return;
  if (c.state === 'suspended') void c.resume().catch(() => {});
  for (const [hz, at] of TONES[cue]) {
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(VOLUME[cue], t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + 0.4);
  }
}

/** The setting as the server has it now; null when it cannot be read (then nothing sounds). */
export async function readSounds(): Promise<Sounds | null> {
  try {
    const r = await apiFetch('/system/prefs');
    const s = r.ok ? ((await r.json()) as { sounds?: Sounds }).sounds : undefined;
    return s && typeof s.ask === 'boolean' && typeof s.done === 'boolean' ? s : null;
  } catch { return null; }
}

/** The first tab of this origin to claim a cue's key gets it; the same key again is taken already. */
export function claim(key: string, storage: Storage = localStorage): boolean {
  try {
    if (storage.getItem(CLAIM) === key) return false;
    storage.setItem(CLAIM, key);
  } catch { /* no storage: this tab sounds alone */ }
  return true;
}

type Deps = { doc?: Document; win?: Window; read?: () => Promise<Sounds | null>; play?: (c: Cue) => void; storage?: Storage };

/** Subscribes to the store and sounds the cues; returns the unsubscribe. */
export function startSounds(store: Pick<Store<RootState>, 'getState' | 'subscribe'>, o: Deps = {}): () => void {
  const doc = o.doc ?? document;
  const win = o.win ?? window;
  const read = o.read ?? readSounds;
  const play = o.play ?? playCue;
  const storage = o.storage ?? localStorage;
  const away = () => doc.hidden || !doc.hasFocus();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const cue = (c: Cue, key: string, still: () => boolean) => {
    if (!away()) return void claim(key, storage); // seen here: no other tab sounds for it
    const id = setTimeout(() => {
      timers.delete(id);
      if (!still() || !away() || !claim(key, storage)) return;
      void read().then((s) => { if (s && (c === 'ask' ? s.ask : s.done)) play(c); });
    }, SETTLE_MS);
    timers.add(id);
  };
  const waiting = (it: RootState['feed']['items'][number]) => it.kind === 'permission' && it.answer === undefined && !it.archived;
  let { epoch, turnSeq: seq, items } = store.getState().feed;
  const asked = new Set(items.flatMap((it) => (it.kind === 'permission' ? [it.id] : []))); // what was there before is not news
  const unsub = store.subscribe(() => {
    const f = store.getState().feed;
    if (f.epoch !== epoch) { // a replay: what it brings is not news either
      ({ epoch, turnSeq: seq, items } = f);
      for (const it of items) if (it.kind === 'permission') asked.add(it.id);
      return;
    }
    if (f.items !== items) {
      items = f.items;
      for (const it of items) {
        if (it.kind !== 'permission' || !waiting(it) || asked.has(it.id)) continue;
        asked.add(it.id);
        const id = it.id;
        cue('ask', `ask:${id}`, () => store.getState().feed.items.some((x) => x.kind === 'permission' && x.id === id && waiting(x)));
      }
    }
    if (f.turnSeq !== seq) { // a live turn ended (a replay keeps turnSeq)
      seq = f.turnSeq;
      const last = f.items.findLast((it) => it.kind === 'done');
      // a stopped turn is the user's own doing: nothing to announce
      if (last?.kind === 'done' && last.status !== 'interrupted') cue(last.status === 'failed' ? 'error' : 'done', `done:${f.session?.id ?? ''}:${last.ts}`, () => true);
    }
  });
  const gesture = () => unlockAudio();
  win.addEventListener('pointerdown', gesture, true);
  win.addEventListener('keydown', gesture, true);
  return () => {
    unsub();
    for (const id of timers) clearTimeout(id);
    win.removeEventListener('pointerdown', gesture, true);
    win.removeEventListener('keydown', gesture, true);
  };
}

export function useSounds(): void {
  const store = useStore<RootState>();
  useEffect(() => startSounds(store), [store]);
}
