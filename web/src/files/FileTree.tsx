import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT, openFile, useAppDispatch, useAppSelector } from '@/sdk';
import { PanelResizer, usePanelWidth, ContextMenu, ContextMenuTrigger } from '@/sdk/ui';
import { selectPendingCountByPath } from '@/comments/slice.ts';
import { selectActiveTab } from '@/tabs/slice.ts';
import { clearReveal, pickSource, revealFile, selectRefreshSeq, selectTree, setDirs, setTreeOpen, toggleDir } from './treeSlice.ts';
import { loadSources, useSources } from './sources.ts';
import { useTreeEntries } from './tree/useTreeEntries.ts';
import { useExpandAll } from './tree/useExpandAll.ts';
import { TreeHeader } from './tree/TreeHeader.tsx';
import { renderDir } from './tree/TreeRow.tsx';
import { TreeMenu } from './tree/TreeMenu.tsx';

export { EXPAND_CAP } from './tree/useExpandAll.ts';

const TREE_MIN = 200;

/** The left tool window, docked next to its strip: open, it narrows the middle column (R-M6-3). */
export function FileTree() {
  const t = useT();
  const d = useAppDispatch();
  const { open, dirs, reveal, src } = useAppSelector(selectTree);
  const turnSeq = useAppSelector(selectRefreshSeq);
  const counts = useAppSelector(selectPendingCountByPath);
  const active = useAppSelector(selectActiveTab);
  const activePath = active.kind === 'file' && active.src === src ? active.path : null;
  const sources = useSources();
  const source = sources.find((x) => x.id === src);
  const ref = src === 'here' ? undefined : source?.ref;

  const [filter, setFilter] = useState('');
  // the picked files (issue 426), in the order picked; `anchor` the last one picked, where a Shift-click's run starts
  const [sel, setSel] = useState<readonly string[]>([]);
  const anchor = useRef<string | null>(null);
  // the file row the context menu is open on; `pressed` the file row last pressed or right-clicked (a touch's long press
  // opens the menu without a contextmenu event, so the press says which row it is)
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const pressed = useRef<string | null>(null);
  // a New edit from selection being made (issue 426): one at a time
  const [creating, setCreating] = useState(false);
  useEffect(() => { setSel([]); anchor.current = null; }, [src]);
  const size = usePanelWidth('panel:tree:width', 300, TREE_MIN);
  const scroller = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  // a closing sheet becomes `hidden`: do not leave focus inside it, hand it to the header toggle (as the comments panel
  // does). A layout effect: it runs before the browser drops the focus of a now-hidden element to <body>
  useLayoutEffect(() => {
    if (!open && sheet.current?.contains(document.activeElement)) document.getElementById('toggleTree')?.focus();
  }, [open]);
  // "Expand all" in progress: the state lives here because both hooks read it (the entries skip a refresh during a run)
  const [expanding, setExpanding] = useState(false);
  const tree = useTreeEntries({ open, dirs, src, sources, turnSeq, run: { running: expanding, stop: () => setExpanding(false) } });
  const { entries, failed, loading, refresh } = tree;
  const expandAll = useExpandAll({ tree, open, dirs, src, running: expanding, setRunning: setExpanding });

  // the picker's list: fetched when the sheet opens (cached 5 s); a source that vanished falls back to this folder
  useEffect(() => {
    if (open) void loadSources();
  }, [open]);
  useEffect(() => {
    if (!source && sources.length > 0 && src !== 'here' && sources.some((x) => x.id !== 'here')) d(pickSource('here'));
  }, [source, sources, src, d]);

  // a reveal clears the filter, so the revealed row is not filtered away
  useEffect(() => {
    if (reveal) setFilter('');
  }, [reveal]);

  // reveal: scroll to the row once its folder is loaded, then clear the request
  useEffect(() => {
    if (!reveal || !open) return;
    const el = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find((n) => n.dataset.path === reveal);
    if (!el) return;
    el.scrollIntoView?.({ block: 'nearest' });
    d(clearReveal());
  }, [reveal, open, entries, d]);

  const rows = {
    entries, dirs, f: filter.trim().toLowerCase(), counts, activePath, src, ref,
    onToggle: (p: string) => { setExpanding(false); d(toggleDir(p)); },
    sel,
    onPick: (p: string, how: { add: boolean; range: boolean }) => {
      if (how.range && anchor.current) {
        // the run of file rows as shown, from the last one picked to this one
        const shown = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-file]') ?? [])].map((n) => n.dataset.path!);
        const a = shown.indexOf(anchor.current), b = shown.indexOf(p);
        if (a >= 0 && b >= 0) {
          const run = a <= b ? shown.slice(a, b + 1) : shown.slice(b, a + 1).reverse();
          return setSel(run);
        }
      }
      anchor.current = p;
      if (how.add || how.range) return setSel(sel.includes(p) ? sel.filter((x) => x !== p) : [...sel, p]);
      setSel([p]);
      d(openFile({ path: p, src, ref }));
    },
  };
  const fileAt = (e: React.SyntheticEvent) => (e.target as HTMLElement).closest<HTMLElement>('[data-file]')?.dataset.path ?? null;
  // a right-click on a file row: elsewhere there is no menu
  const onContextMenu = (e: React.MouseEvent) => {
    pressed.current = fileAt(e);
    if (!pressed.current) e.preventDefault();
  };
  // the menu opens on the row pressed: outside the picked files it picks that row alone
  const onMenu = (open: boolean) => {
    const p = pressed.current;
    if (!open || !p) return;
    setMenuRow(p);
    if (!sel.includes(p)) { setSel([p]); anchor.current = p; }
  };
  // the picked files that are no longer shown (gone, filtered out, in a folder closed) are let go
  useEffect(() => {
    if (!sel.length) return;
    const shown = new Set([...(scroller.current?.querySelectorAll<HTMLElement>('[data-file]') ?? [])].map((n) => n.dataset.path!));
    if (sel.some((p) => !shown.has(p))) setSel(sel.filter((p) => shown.has(p)));
  }, [sel, entries, dirs, filter]);

  return (
    <aside
      ref={sheet}
      id="tree-sheet"
      hidden={!open}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        // several files picked: Esc lets them go first
        if (sel.length > 1) setSel([]);
        else d(setTreeOpen(false));
      }}
      style={{ width: size.width, maxWidth: '45vw' }}
      className="relative flex flex-none flex-col border-r border-border-soft bg-chrome"
    >
      <PanelResizer edge="right" width={size.width} onWidth={size.set} onReset={size.reset} min={TREE_MIN} label={t('resizeFiles')} />
      <TreeHeader
        canReveal={active.kind === 'file'}
        onReveal={() => { if (active.kind === 'file') d(revealFile(active.path, active.src)); }}
        expanding={expanding} onExpandAll={expandAll.start}
        onCollapseAll={() => { setExpanding(false); d(setDirs([])); }}
        spinning={loading > 0 || creating} onRefresh={() => { void refresh(); void loadSources(true); }}
      />
      <input type="search" role="searchbox" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('filterPh')} aria-label={t('filterPh')}
        className="mx-2 mt-2.5 mb-1.5 h-[30px] flex-none rounded-lg border border-transparent bg-muted/50 px-2.5 text-[0.78125rem] text-foreground outline-0 focus:border-input-focus-soft focus:ring-2 focus:ring-input-ring" />
      {failed && <div role="alert" className="mx-2 mb-1 text-xs text-warn">{t('serverError', '/tree')}</div>}
      <ContextMenu onOpenChange={onMenu}>
        <ContextMenuTrigger asChild>
          <div ref={scroller} onContextMenu={onContextMenu} onPointerDown={(e) => { pressed.current = fileAt(e); }} className="min-h-0 flex-1 overflow-auto px-1.5 pt-0.5 pb-3">{renderDir(rows, '', 0)}</div>
        </ContextMenuTrigger>
        {menuRow && <TreeMenu row={menuRow} picked={sel.includes(menuRow) ? sel : [menuRow]} src={src} creating={creating} setCreating={setCreating} />}
      </ContextMenu>
    </aside>
  );
}
