import { definePlugin } from '@/sdk';
import { changesTab } from './ChangesView.tsx';
import { commitResource, logResource, logTab } from './LogView.tsx';
import { ChangesPanel } from './ChangesPanel.tsx';
import { branchesResource, GitBranch } from './GitBranch.tsx';
import { VcsToggles } from './VcsToggles.tsx';
import { diffResource, patchResource, setPanel } from './store.ts';

export const vcsPlugin = definePlugin({
  id: 'vcs',
  tabs: [changesTab, logTab],
  // Files and Changes share the left side: the tree opening (its button, its key, a reveal) closes the panel
  listeners: (start) => start({ predicate: (_a, st, was) => st.tree.open && !was.tree.open, effect: () => setPanel(false) }),
  slots: [
    { slot: 'header.center', order: 10, render: GitBranch },
    { slot: 'strip.left', order: 20, render: VcsToggles },
    { slot: 'panel.left', order: 40, render: ChangesPanel },
  ],
  resources: [diffResource, patchResource, logResource, commitResource, branchesResource],
});
