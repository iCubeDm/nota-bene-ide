import type { Plugin } from '@/sdk/plugin.ts';
import { useAppSelector, usePlugins, type RootState } from '@/store/store.ts';

/**
 * The pause the server cannot see, for the update's hand-over and a pending server restart (gh-422): no turn and no
 * waiting question, and every plugin's `pause` (no upload, no send on its way, no `! cmd` run, no running task: the
 * server counts its own too). `draft`: a typed draft or attached images count as well; the update reloads the page,
 * which loses them, while a restart (75) keeps the page and its draft.
 */
export const selectPagePause = (s: RootState, o: { draft: boolean }, plugins: readonly Plugin[]): boolean =>
  !s.feed.busy && !s.feed.items.some((it) => it.kind === 'permission' && it.answer === undefined && !it.archived)
  && plugins.every((p) => p.pause?.(s, o) ?? true);

export const usePagePause = (o: { draft: boolean }): boolean => {
  const plugins = usePlugins();
  return useAppSelector((s) => selectPagePause(s, o, plugins));
};
