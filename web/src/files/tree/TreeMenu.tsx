import { basename } from '@nota-bene/shared/paths';
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu.tsx';
import { isEditMedia, newCutOf } from '@/cut/assemble.ts';
import { mediaLen } from '@/cut/mediaLen.ts';
import { useEditTarget } from '@/cut/targets.ts';
import { useT } from '@/i18n/index.ts';
import { apiFetch } from '@/net/auth.ts';
import { toast } from '@/shell/toast.ts';
import { useAppDispatch } from '@/store/store.ts';
import { openFile } from '@/tabs/slice.ts';
import { diskChanged } from '@/tree/slice.ts';

const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * A file row's menu in the Files tree. `picked`: the files it acts on (the selection when the row is in it, else the row),
 * in the order they were picked; `src` the tree's source. For media of this folder (issue 426): Add to edit (the edit
 * shown most recently of those open in a tab, through its own editing state: off while none is open) and New edit from
 * selection (a new edit beside the first file, opened). Copy path for any file.
 */
export function TreeMenu({ row, picked, src }: { row: string; picked: readonly string[]; src: string }) {
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
    try {
      const items = await Promise.all(media.map(async (f) => ({ src: f, len: await mediaLen(f) })));
      const made = newCutOf(items);
      if (!made) return toast(t('treeNewEditFailed'), t('cutCannotAdd', media.map((f) => basename(f)).join(', ')));
      const r = await apiFetch('/cut/new', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: folderOf(media[0]!), cut: made.cut }),
      });
      const j = await r.json().catch(() => null) as { path?: string; error?: string } | null;
      if (!r.ok || typeof j?.path !== 'string') return toast(t('treeNewEditFailed'), j?.error ?? `${r.status} ${r.statusText}`.trim());
      d(diskChanged());
      d(openFile({ path: j.path, src: 'here' }));
    } catch (e) {
      toast(t('treeNewEditFailed'), e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ContextMenuContent>
      {media.length > 0 && (
        <>
          <ContextMenuItem disabled={!target} onSelect={add}>
            {target ? t('treeAddToEdit', media.length, basename(target.path)) : t('treeAddToEditNone')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void create()}>{t('treeNewEdit', media.length)}</ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(row)}>{t('copyPath')}</ContextMenuItem>
    </ContextMenuContent>
  );
}
