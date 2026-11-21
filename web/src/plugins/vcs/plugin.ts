import type { UnknownAction, WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { changesTab } from './ChangesView.tsx';
import { commitResource, logResource, logTab } from './LogView.tsx';
import { ChangesPanel } from './ChangesPanel.tsx';
import { branchesResource, GitBranch } from './GitBranch.tsx';
import { VcsToggles } from './VcsToggles.tsx';
import { diffResource, patchResource, showCommit, vcsListeners, vcsSlice } from './store.ts';

declare module '@/sdk' {
  interface Services { vcs: VcsService }
  interface PluginState extends WithSlice<typeof vcsSlice> {}
}

/** The git views as other plugins reach them (issue 545), provided by the vcs plugin. */
export interface VcsService {
  /** the log shows this commit, with `path` picked (a comment on a commit asked for it) */
  showCommit(sha: string, path: string): UnknownAction;
}

export const vcsPlugin = definePlugin({
  id: 'vcs',
  tabs: [changesTab, logTab],
  slices: [vcsSlice],
  // the saved layout and bases; Files and Changes share the left side: the tree opening (its button, its key, a reveal) closes the panel
  listeners: vcsListeners,
  slots: [
    { slot: 'header.center', order: 10, render: GitBranch },
    { slot: 'strip.left', order: 20, render: VcsToggles },
    { slot: 'panel.left', order: 40, render: ChangesPanel },
  ],
  resources: [diffResource, patchResource, logResource, commitResource, branchesResource],
  vcs: { showCommit },
});
