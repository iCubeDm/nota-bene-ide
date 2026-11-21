import { basename } from '@nota-bene/shared/paths';
import { useT, routes, isMac, toast, projectFileUrl, isLocalPage, useRegistry, send } from '@/sdk';
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/sdk/ui';

/** Saves each file through `/file?…&download=1` (the login cookie opens it: no token or key in the link). */
function download(files: readonly string[], src: string): void {
  for (const f of files) {
    const a = document.createElement('a');
    a.href = `${projectFileUrl(f, src)}&download=1`;
    a.download = basename(f);
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  }
}

/** The server's refusals of /os/reveal and /os/open (osFiles.ts), in words; anything else is the generic failure. */
const OS_REASONS: Record<string, 'treeOpenRefused' | 'treeOsLocalOnly' | 'treeOsOutside' | 'treeOsMissing'> = {
  refused: 'treeOpenRefused', 'local-only': 'treeOsLocalOnly', 'outside project': 'treeOsOutside', 'not found': 'treeOsMissing',
};

/** The reveal item's name on the system the page runs on (it is the server's: Reveal is offered on this computer only). */
const revealLabel = (): 'treeRevealMac' | 'treeRevealWin' | 'treeRevealLinux' =>
  isMac() ? 'treeRevealMac' : /Win/.test(navigator.platform || navigator.userAgent) ? 'treeRevealWin' : 'treeRevealLinux';

/**
 * A file row's menu in the Files tree. `picked`: the files it acts on (the selection when the row is in it, else the row),
 * in the order they were picked; `src` the tree's source. Other plugins' items first (`treeActions`: the edits' Add to
 * edit and New edit, issue 426; `creating` is the tree's spinner while one works); then Copy path and Download (every
 * picked file) for any file; Show in Finder and Open in default app (issue 461) for a file of this folder, on this
 * computer only.
 */
export function TreeMenu({ row, picked, src, creating, setCreating }: {
  row: string; picked: readonly string[]; src: string; creating: boolean; setCreating: (on: boolean) => void;
}) {
  const t = useT();
  const parts = useRegistry().treeActions;

  // the server's refusal codes become words (OS_REASONS)
  const os = async (action: 'reveal' | 'open') => {
    try {
      const r = await send(routes.os(action), { path: row });
      if (r.ok) return;
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      toast(t('treeOsFail', basename(row)), t(OS_REASONS[j?.error ?? ''] ?? 'treeOsOther'));
    } catch {
      toast(t('treeOsFail', basename(row)), t('treeOsOther'));
    }
  };
  const desktop = src === 'here' && isLocalPage();

  return (
    <ContextMenuContent>
      {parts.map(({ id, Menu }) => Menu && <Menu key={id} row={row} picked={picked} src={src} busy={creating} setBusy={setCreating} />)}
      <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(row)}>{t('copyPath')}</ContextMenuItem>
      <ContextMenuItem onSelect={() => download(picked.length ? picked : [row], src)}>{t('treeDownload')}</ContextMenuItem>
      {desktop && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void os('reveal')}>{t(revealLabel())}</ContextMenuItem>
          <ContextMenuItem onSelect={() => void os('open')}>{t('treeOpenApp')}</ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}
