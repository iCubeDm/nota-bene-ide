import type { WithSlice } from '@reduxjs/toolkit';
import { bool, definePlugin, enterRoot, json, storage } from '@/sdk';
import { readSavedDirs, setDirs, treeKey, treeSlice } from './slice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof treeSlice> {}
}

export const treePlugin = definePlugin({
  id: 'tree',
  slices: [treeSlice],
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
  },
});
