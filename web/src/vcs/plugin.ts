import { definePlugin } from '@/sdk';
import { changesTab } from './ChangesView.tsx';
import { logTab } from './LogView.tsx';
import { ChangesPanel } from './ChangesPanel.tsx';
import { GitBranch } from './GitBranch.tsx';
import { VcsToggles } from './VcsToggles.tsx';

export const vcsPlugin = definePlugin({
  id: 'vcs',
  tabs: [changesTab, logTab],
  slots: [
    { slot: 'header.center', order: 10, render: GitBranch },
    { slot: 'strip.left', order: 20, render: VcsToggles },
    { slot: 'panel.left', order: 40, render: ChangesPanel },
  ],
});
