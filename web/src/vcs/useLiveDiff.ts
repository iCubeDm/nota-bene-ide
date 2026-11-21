import { selectSession, useAppSelector, useResource, useService } from '@/sdk';
import { baseOf, diffResource, useVcsUi } from './store.ts';

/**
 * Refreshes while shown: other agents' worktrees change without any turn of this window, so it polls (one poll however
 * many views show it), and reads again after a turn. The answer is for exactly this project, source and base: another's
 * list is never shown under this one's name.
 */
export function useLiveDiff(on: boolean) {
  const files = useService('files');
  const src = useAppSelector(files.selectSource);
  const root = useAppSelector(selectSession)?.root ?? '';
  const turn = useAppSelector(files.selectRefreshSeq);
  const base = baseOf(useVcsUi().bases, root, src);
  const { data, failed, refresh } = useResource(diffResource, { root, src, base }, { on: on && !!root, refreshOn: turn });
  return { root, src, base, data, failed, refresh };
}
