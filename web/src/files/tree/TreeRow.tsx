import type { TreeEntry } from '@nota-bene/shared';
import { isEditMedia } from '@/cut/assemble.ts';
import { PATH_MIME } from '@/cut/drag.ts';
import { downloadUrl, PATHS_MIME } from '@/files/drag.ts';
import { openFile } from '@/tabs/slice.ts';
import { Svg } from '@/tabs/TabStrip.tsx';
import { FileIcon } from '../FileIcon.tsx';
import { fileKey } from '../sources.ts';
import { join } from './useExpandAll.ts';

/** What the rows read: the listings, the open folders, the filter, the badges, the active file and the source. */
export type RowsCtx = {
  entries: Record<string, TreeEntry[]>; dirs: string[]; f: string; counts: Record<string, number>;
  activePath: string | null; src: string; ref: string | undefined;
  /** the picked files (issue 426), in the order they were picked */
  sel: readonly string[];
  onToggle: (path: string) => void;
  /** a file row's click: Cmd/Ctrl (`add`) toggles it in the selection, Shift (`range`) picks the run to it, a plain one opens it */
  onPick: (path: string, how: { add: boolean; range: boolean }) => void;
};

/** The rows of one folder (and, recursively, of its open subfolders). */
export function renderDir(c: RowsCtx, dir: string, depth: number): React.ReactNode {
  const { entries, dirs, f, counts, activePath, src, ref } = c;
  return (entries[dir] ?? []).map((e) => {
    const p = join(dir, e.name);
    const dot = e.name.startsWith('.') ? ' opacity-50' : '';
    const pad = { paddingLeft: 6 + depth * 12 };
    if (e.dir) {
      const isOpen = dirs.includes(p);
      return (
        <div key={p}>
          <button type="button" data-path={p} aria-expanded={isOpen} onClick={() => c.onToggle(p)} style={pad}
            className={`flex h-6 w-full items-center gap-1.5 rounded pr-2 text-left text-xs text-foreground/85 hover:bg-muted/50 hover:text-foreground${dot}`}>
            <Svg size={12}><path d="m9 6 6 6-6 6" className={isOpen ? 'origin-center rotate-90' : ''} style={{ transformBox: 'fill-box' }} /></Svg>
            <FileIcon dir open={isOpen} />
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
          </button>
          {isOpen && renderDir(c, p, depth + 1)}
        </div>
      );
    }
    if (f && !e.name.toLowerCase().includes(f)) return null;
    const n = counts[fileKey(p, ref)] ?? 0;
    // a video, sound or photo of this folder drags onto an edit's timeline (issue 409)
    const media = src === 'here' && isEditMedia(p);
    // issue 461: every file drags: its path (with the rest of the selection) onto the composer, and out of the browser as a
    // download (Chrome/Edge DownloadURL, the cookie-tier /file: no token or key in it)
    const dragStart = (ev: React.DragEvent) => {
      const dt = ev.dataTransfer;
      if (media) dt.setData(PATH_MIME, p);
      if (src === 'here') dt.setData(PATHS_MIME, JSON.stringify(c.sel.includes(p) ? c.sel : [p]));
      dt.setData('DownloadURL', downloadUrl(p, src));
      dt.setData('text/plain', p);
      dt.effectAllowed = 'copy';
    };
    return (
      <button key={p} type="button" data-path={p} data-file data-selected={c.sel.includes(p) || undefined} style={pad}
        onClick={(ev) => c.onPick(p, { add: ev.metaKey || ev.ctrlKey, range: ev.shiftKey })}
        draggable onDragStart={dragStart}
        className={`flex h-6 w-full items-center gap-1.5 rounded pr-2 text-left text-xs hover:bg-muted/50 hover:text-foreground${dot} ${activePath === p ? 'bg-primary/15 text-foreground' : 'text-foreground/85'} data-[selected]:ring-1 data-[selected]:ring-inset data-[selected]:ring-primary/45`}>
        <span className="w-3 flex-none" />
        <FileIcon path={e.name} />
        <span className="min-w-0 flex-1 truncate">{e.name}</span>
        {n > 0 && <span data-badge className="rounded-full bg-nb-accent/[.18] px-1.5 text-[0.625rem] font-semibold leading-4 text-nb-accent">{n}</span>}
      </button>
    );
  });
}
