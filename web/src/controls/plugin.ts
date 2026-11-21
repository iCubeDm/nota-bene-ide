import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { controlsListeners, controlsSlice } from './slice.ts';
import { chatTab } from './chatTab.tsx';
import { ConnNote } from './ConnNote.tsx';
import { CompactPending } from './CompactPending.tsx';
import { RestartMenu } from './RestartMenu.tsx';
import { ModelPill } from './ModelPill.tsx';
import { StopButton } from './StopButton.tsx';
import { Activity } from './useActivity.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof controlsSlice> {}
}

export const controlsPlugin = definePlugin({
  id: 'controls',
  slices: [controlsSlice],
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
  ],
});
