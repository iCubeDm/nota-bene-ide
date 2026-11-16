import { selectBuilding, selectDraft, selectImages, selectUploading } from '@/composer/slice.ts';
import { selectShellRunning } from '@/composer/shellMode.ts';
import { selectRunningCount } from '@/tasks/slice.ts';
import type { RootState } from '@/store/store.ts';

/**
 * The pause the server cannot see, for the update's hand-over and a pending server restart (gh-422): no upload, no
 * send on its way, no turn, no waiting question, no `! cmd` run and no running task (the server counts its own too).
 * `draft`: a typed draft or attached images count as well; the update reloads the page, which loses them, while a
 * restart (75) keeps the page and its draft.
 */
export const selectPagePause = (s: RootState, o: { draft: boolean }): boolean => {
  if (o.draft && (selectDraft(s).trim() !== '' || selectImages(s).length > 0)) return false;
  const feed = s.feed;
  return selectUploading(s) === 0 && !selectBuilding(s)
    && s.composer.unconfirmed === null && s.composer.shellUnconfirmed === null
    && selectShellRunning(s) === null && selectRunningCount(s) === 0
    && !feed.busy && !feed.items.some((it) => it.kind === 'permission' && it.answer === undefined && !it.archived);
};
