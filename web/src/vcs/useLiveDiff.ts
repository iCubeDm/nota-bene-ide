import { useEffect } from 'react';
import { selectSession, useAppSelector } from '@/sdk';
import { selectRefreshSeq, selectTree } from '@/tree/slice.ts';
import { baseOf, useDiffData, useVcsUi, watchDiff } from './store.ts';

/** Refreshes while shown: other agents' worktrees change without any turn of this window, so it polls (one poll however many views show it). */
export function useLiveDiff(on: boolean) {
  const src = useAppSelector(selectTree).src;
  const root = useAppSelector(selectSession)?.root ?? '';
  const turn = useAppSelector(selectRefreshSeq);
  const base = baseOf(useVcsUi().bases, root, src);
  useEffect(() => {
    if (!on || !root) return;
    return watchDiff(root, src, base);
  }, [on, root, src, base, turn]);
  return { root, src, base, data: useDiffData(root, src, base) };
}
