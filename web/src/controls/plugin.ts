import { definePlugin, controlsListeners } from '@/sdk';
import { chatTab } from './chatTab.tsx';
import { ConnNote } from './ConnNote.tsx';
import { CompactPending } from './CompactPending.tsx';
import { infoResource, RestartMenu } from './RestartMenu.tsx';
import { ModelPill } from './ModelPill.tsx';
import { StopButton } from './StopButton.tsx';
import { Activity } from './useActivity.ts';
import { controlsSettings } from './settings.tsx';
import { ModePill } from './ModePill.tsx';
import { AgentAccount } from './AgentAccount.tsx';
import { CompactClear } from './CompactClear.tsx';

export const controlsPlugin = definePlugin({
  id: 'controls',
  listeners: controlsListeners,
  tabs: [chatTab],
  // the header's right end, around the update notice (20), the session (60) and the settings (70)
  slots: [
    { slot: 'header.end', order: 10, render: ConnNote },
    { slot: 'header.end', order: 30, render: CompactPending },
    // enabled while busy: the escape hatch for a stuck agent (R-M4-4); only a running switch/restart disables it
    { slot: 'header.end', order: 40, render: RestartMenu },
    { slot: 'header.end', order: 50, render: ModelPill },
    { slot: 'header.end', order: 80, render: StopButton },
    { slot: 'overlay', order: 60, render: Activity },
    // the composer's tools row: the mode after the keys help; the account and compaction around the meters (20)
    { slot: 'composer.tools', order: 10, render: ModePill },
    { slot: 'composer.end', order: 10, render: AgentAccount },
    { slot: 'composer.end', order: 30, render: CompactClear },
  ],
  settings: controlsSettings,
  resources: [infoResource],
});
