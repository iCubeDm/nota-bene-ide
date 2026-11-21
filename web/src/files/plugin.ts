import type { WithSlice } from '@reduxjs/toolkit';
import { bool, clearRefCache, definePlugin, enterRoot, json, serverEvent, storage } from '@/sdk';
import { filesSlice } from './slice.ts';
import { readSavedDirs, setDirs, treeKey, treeSlice } from './treeSlice.ts';
import { loadSources } from './sources.ts';
import { pushRecent, RECENT_DWELL_MS } from './recent.ts';
import { setTmpDirs } from './tmpImages.ts';
import { fileTab } from './FileView.tsx';
import { Tree } from './FileTree.tsx';
import { FilesToggle } from './FilesToggle.tsx';
import { RecentFiles } from './RecentFiles.tsx';
import { filesCommands } from './commands.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof treeSlice>, WithSlice<typeof filesSlice> {}
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
      effect: (_a, api) => storage.local('panel:tree', bool, true).set(api.getState().tree.open),
    });
    start({
      predicate: (_a, st, was) => st.tree.dirs !== was.tree.dirs,
      effect: (_a, api) => {
        const { tabs: { root }, tree: { dirs, src } } = api.getState();
        if (root) storage.local(treeKey(root, src), json<string[]>(), []).set(dirs);
      },
    });
    // where the server keeps the agent's temporary images: from its hello
    start({ actionCreator: serverEvent, effect: ({ payload: ev }) => void (ev.kind === 'hello' && setTmpDirs(ev.tmpDirs)) });
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
