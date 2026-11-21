import { VIDEO } from '@nota-bene/shared/cut';
import { basename } from '@nota-bene/shared/paths';
import { useT, connections, routes, toast, useAppDispatch, openFile, projectFileUrl, useService, type TreeAction } from '@/sdk';
import { ContextMenuItem, ContextMenuSeparator } from '@/sdk/ui';
import { isEditMedia, newCutOf } from './assemble.ts';
import { srcSize } from './durations.ts';
import { PATH_MIME } from './drag.ts';
import { mediaLen } from './mediaLen.ts';
import { editTargetName, useEditTarget } from './targets.ts';

const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** The picture size of the first of `files` that is a video the browser reads; null: none. */
async function firstFrame(files: readonly string[]): Promise<{ width: number; height: number } | null> {
  for (const f of files) {
    if (!VIDEO.test(f)) continue;
    const size = await srcSize(projectFileUrl(f, 'here'));
    if (size) return size;
  }
  return null;
}

/**
 * For media of this folder (issue 426): Add to edit (the edit shown most recently of those open in a tab, through its
 * own editing state: off while none is open) and New edit from selection (a new edit beside the first file, opened; one
 * at a time: `busy` while one is made).
 */
function EditItems({ row, picked, src, busy: creating, setBusy: setCreating }: Parameters<NonNullable<TreeAction['Menu']>>[0]) {
  const t = useT();
  const d = useAppDispatch();
  const { diskChanged } = useService('files');
  const target = useEditTarget();
  const media = src === 'here' && isEditMedia(row) ? picked.filter(isEditMedia) : [];
  if (!media.length) return null;

  const add = () => {
    if (!target) return;
    void target.add(media);
    d(openFile({ path: target.path, src: 'here' }));
  };
  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const [items, frame] = await Promise.all([Promise.all(media.map(async (f) => ({ src: f, len: await mediaLen(f) }))), firstFrame(media)]);
      const made = newCutOf(items, frame);
      if (!made) return toast(t('treeNewEditFailed'), t('cutCannotAdd', media.map((f) => basename(f)).join(', ')));
      const r = await connections.current().fetch(routes.cutNew(), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: folderOf(media[0]!), cut: made.cut }),
      });
      const j = await r.json().catch(() => null) as { path?: string; error?: string; code?: string } | null;
      if (!r.ok || typeof j?.path !== 'string') {
        return toast(t('treeNewEditFailed'), j?.error ? `${j.error}${j.code ? ` (${j.code})` : ''}` : `${r.status} ${r.statusText}`.trim());
      }
      d(diskChanged());
      d(openFile({ path: j.path, src: 'here' }));
      // a video whose length could not be read is left out, and named
      if (made.skipped.length) toast(basename(j.path), t('cutCannotAdd', made.skipped.map((f) => basename(f)).join(', ')));
    } catch (e) {
      toast(t('treeNewEditFailed'), e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <ContextMenuItem disabled={!target} onSelect={add}>
        {target ? t('treeAddToEdit', media.length, editTargetName(target.path)) : t('treeAddToEditNone')}
      </ContextMenuItem>
      <ContextMenuItem disabled={creating} onSelect={() => void create()}>{creating ? t('treeNewEditBusy') : t('treeNewEdit', media.length)}</ContextMenuItem>
      <ContextMenuSeparator />
    </>
  );
}

/** The edits' part of a file row: the menu items above, and a video, sound or photo of this folder drags onto an edit's timeline (issue 409). */
export const editTreeAction: TreeAction = {
  id: 'cut', order: 10, Menu: EditItems,
  drag: (path, src, dt) => void (src === 'here' && isEditMedia(path) && dt.setData(PATH_MIME, path)),
};
