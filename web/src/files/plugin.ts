import type { WithSlice } from '@reduxjs/toolkit';
import { clearRefCache, definePlugin, enterRoot, serverEvent } from '@/sdk';
import { filesSlice } from './slice.ts';
import { loadSources } from './sources.ts';
import { pushRecent, RECENT_DWELL_MS } from './recent.ts';
import { setTmpDirs } from './tmpImages.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof filesSlice> {}
}

export const filesPlugin = definePlugin({
  id: 'files',
  slices: [filesSlice],
  listeners: (start) => {
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
