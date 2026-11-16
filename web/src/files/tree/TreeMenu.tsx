import { VIDEO } from '@nota-bene/shared/cut';
import { basename } from '@nota-bene/shared/paths';
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu.tsx';
import { isEditMedia, newCutOf } from '@/cut/assemble.ts';
import { srcSize } from '@/cut/durations.ts';
import { mediaLen } from '@/cut/mediaLen.ts';
import { projectFileUrl } from '@/files/kinds.ts';
import { editTargetName, useEditTarget } from '@/cut/targets.ts';
import { useT } from '@/i18n/index.ts';
import { apiFetch } from '@/net/auth.ts';
import { toast } from '@/shell/toast.ts';
import { useAppDispatch } from '@/store/store.ts';
import { openFile } from '@/tabs/slice.ts';
import { diskChanged } from '@/tree/slice.ts';

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
 * A file row's menu in the Files tree. `picked`: the files it acts on (the selection when the row is in it, else the row),
 * in the order they were picked; `src` the tree's source. For media of this folder (issue 426): Add to edit (the edit
 * shown most recently of those open in a tab, through its own editing state: off while none is open) and New edit from
 * selection (a new edit beside the first file, opened; one at a time: `creating` while one is made). Copy path for any file.
 */
export function TreeMenu({ row, picked, src, creating, setCreating }: {
  row: string; picked: readonly string[]; src: string; creating: boolean; setCreating: (on: boolean) => void;
}) {
  const t = useT();
  const d = useAppDispatch();
  const target = useEditTarget();
  const media = src === 'here' && isEditMedia(row) ? picked.filter(isEditMedia) : [];

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
      const r = await apiFetch('/cut/new', {
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
    <ContextMenuContent>
      {media.length > 0 && (
        <>
          <ContextMenuItem disabled={!target} onSelect={add}>
            {target ? t('treeAddToEdit', media.length, editTargetName(target.path)) : t('treeAddToEditNone')}
          </ContextMenuItem>
          <ContextMenuItem disabled={creating} onSelect={() => void create()}>{creating ? t('treeNewEditBusy') : t('treeNewEdit', media.length)}</ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(row)}>{t('copyPath')}</ContextMenuItem>
    </ContextMenuContent>
  );
}
