import { useEffect } from 'react';
import { selectSession, selectTurnSeq, useAppSelector } from '@/store/store.ts';
import { selectTree } from '@/tree/slice.ts';
import { baseOf, loadDiff, useDiffData, useVcsUi } from './store.ts';

/** Refreshes while shown: other agents' worktrees change without any turn of this window, so it polls. */
export function useLiveDiff(on: boolean) {
  const src = useAppSelector(selectTree).src;
  const root = useAppSelector(selectSession)?.root ?? '';
  const turn = useAppSelector(selectTurnSeq);
  const base = baseOf(useVcsUi().bases, root, src);
  useEffect(() => {
    if (!on || !root) return;
    void loadDiff(root, src, base);
    const id = setInterval(() => { if (document.visibilityState === 'visible') void loadDiff(root, src, base); }, 4_000);
    return () => clearInterval(id);
  }, [on, root, src, base, turn]);
  return { root, src, base, data: useDiffData(root, src, base) };
}
