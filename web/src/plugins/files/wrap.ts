import { bool, storage, useStored } from '@/sdk';

// line wrapping of text files: one switch for every file view (the button in a file's header, Alt+Z), remembered;
// on by default, so a long line reads without a horizontal scroll
const saved = storage.local('nb.wrap', bool, true);

export const wrapLines = {
  get: () => saved.get(),
  set: (v: boolean) => saved.set(v),
  toggle: () => saved.set(!saved.get()),
  subscribe: saved.subscribe,
};

export const useWrapLines = () => useStored(saved);
