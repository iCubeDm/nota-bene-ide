import type { UnknownAction, WithSlice } from '@reduxjs/toolkit';
import { clearRefCache, definePlugin, enterRoot, json, storage, loadSources, type AppThunk, type RootState } from '@/sdk';
import { filesSlice, jumpToFileComment, selectFileLoad, selectFileVersion, type FileLoad } from './slice.ts';
import { diskChanged, inTree, pickSource, readSavedDirs, savedTreeOpen, selectRefreshSeq, setDirs, setTreeOpen, treeKey, treeSlice } from './treeSlice.ts';
import { pushRecent, RECENT_DWELL_MS } from './recent.ts';
import { fileTab } from './FileView.tsx';
import { Tree } from './FileTree.tsx';
import { FilesToggle } from './FilesToggle.tsx';
import { RecentFiles } from './RecentFiles.tsx';
import { filesCommands } from './commands.ts';

declare module '@/sdk' {
  interface Services { files: FilesService }
  interface PluginState extends WithSlice<typeof treeSlice>, WithSlice<typeof filesSlice> {}
}

/**
 * The Files tree and the open file views as other plugins read them (issue 545), provided by the files plugin: the
 * source the tree shows (the git views show the same), what moves when the folder's files change, and each open file
 * view's load and media version (keyed by path and `ref`, see `fileKey`).
 */
export interface FilesService {
  /** the source the tree shows: 'here', 'ref:<branch>', 'dir:<hash>' */
  selectSource(s: RootState): string;
  /** moves when this folder's files changed outside a turn (a branch switch) */
  selectDiskSeq(s: RootState): number;
  /** moves after each live turn and each change of this folder outside one: the views that reload after a turn watch it */
  selectRefreshSeq(s: RootState): number;
  /** shows another source in the tree, with the folders that were open there last time */
  pickSource(id: string): AppThunk;
  /** this folder's files changed outside a turn: the views reload as after one */
  diskChanged(): UnknownAction;
  setTreeOpen(open: boolean): UnknownAction;
  selectTreeOpen(s: RootState): boolean;
  /** the focus is in the tree (its own keys, Esc closes it) */
  inTree(el: Element | null): boolean;
  selectFileLoad(s: RootState, path: string, ref?: string): FileLoad | undefined;
  /** an open media tab's file's current ETag; undefined: unknown (tab closed), no claim either way */
  selectFileVersion(s: RootState, path: string, ref?: string): string | undefined;
  /** opens the comment's file (a comment made on a commit: that commit in the log) and scrolls to its fragment once loaded */
  jumpToFileComment(path: string, id: string, ref?: string): AppThunk;
}

export const filesPlugin = definePlugin({
  id: 'files',
  slices: [treeSlice, filesSlice],
  tabs: [fileTab],
  slots: [
    { slot: 'strip.left', order: 10, render: FilesToggle },
    { slot: 'panel.left', order: 30, render: Tree },
    { slot: 'overlay', order: 40, render: RecentFiles },
  ],
  commands: filesCommands,
  files: {
    selectSource: (s) => s.tree.src, selectDiskSeq: (s) => s.tree.diskSeq, selectRefreshSeq, pickSource, diskChanged, setTreeOpen,
    selectTreeOpen: (s) => s.tree.open, inTree, selectFileLoad, selectFileVersion, jumpToFileComment,
  },
  listeners: (start) => {
    // a root's saved folders: merged on the first root (folders expanded before it was known stay), replacing after
    start({
      actionCreator: enterRoot,
      effect: ({ payload: { root, first } }, api) => {
        const saved = readSavedDirs(root);
        if (saved) api.dispatch(setDirs(first ? [...new Set([...saved, ...api.getState().tree.dirs])] : saved));
      },
    });
    start({
      predicate: (_a, st, was) => st.tree.open !== was.tree.open,
      effect: (_a, api) => savedTreeOpen.set(api.getState().tree.open),
    });
    start({
      predicate: (_a, st, was) => st.tree.dirs !== was.tree.dirs,
      effect: (_a, api) => {
        const { tabs: { root }, tree: { dirs, src } } = api.getState();
        if (root) storage.local(treeKey(root, src), json<string[]>(), []).set(dirs);
      },
    });
    // source ids are stable (M3-16): every saved tab comes back at once, whatever /sources says; a tab whose source is
    // gone keeps its place and says so in its view. The load feeds the picker and absolute refs; another root has other
    // worktrees and branches, and its paths other HEAD answers, so both caches are dropped then.
    start({
      actionCreator: enterRoot,
      effect: ({ payload: { first } }) => {
        if (!first) clearRefCache();
        void loadSources(!first);
      },
    });
    // a file tab became active and stays so a moment: the most recent file of this root (Alt+E, M6-13).
    // The next active change cancels the wait (also when it activates a non-file tab).
    start({
      predicate: (_a, st, was) => st.tabs.active !== was.tabs.active,
      effect: async (_a, api) => {
        api.cancelActiveListeners();
        const { tabs } = api.getState();
        const at = tabs.root;
        if (!at) return;
        const f = tabs.open.find((x) => x.id === tabs.active);
        if (f?.kind !== 'file') return;
        try { await api.delay(RECENT_DWELL_MS); } catch { return; } // cancelled
        const now = api.getState().tabs;
        if (now.active === f.id && now.root === at) pushRecent(at, { path: f.path, ...(f.src !== 'here' && { src: f.src }), ...(f.ref && { ref: f.ref }) });
      },
    });
  },
});
