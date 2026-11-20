import { oneOf, storage, useStored } from '@/sdk';

/** The seconds a ← / → press seeks by; the bar's step chip picks one. */
export const SEEK_STEPS = [0.1, 0.5, 1, 5] as const;
export type SeekStepValue = (typeof SEEK_STEPS)[number];
const DEFAULT: SeekStepValue = 5;

// one pref for every player (file tabs, chat replies, md files), remembered; unknown stored values fall back to the default
const saved = storage.local<SeekStepValue>('nb.seekStep', oneOf(SEEK_STEPS), DEFAULT);

export const seekStep = {
  get: (): SeekStepValue => saved.get(),
  set: (v: SeekStepValue) => saved.set(v),
  subscribe: saved.subscribe,
};

export const useSeekStep = () => useStored(saved);
