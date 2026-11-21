import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { selectRunningCount, tasksSlice, tasksUiSlice } from './slice.ts';
import { shellTab } from './ShellView.tsx';
import { TasksDrawer } from './TasksDrawer.tsx';
import { TasksIndicator } from './TasksIndicator.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof tasksSlice>, WithSlice<typeof tasksUiSlice> {}
}

export const tasksPlugin = definePlugin({
  id: 'tasks',
  slices: [tasksSlice, tasksUiSlice],
  // the server counts its own running tasks too
  pause: (s) => selectRunningCount(s) === 0,
  tabs: [shellTab],
  slots: [{ slot: 'panes', order: 10, render: TasksDrawer }, { slot: 'footer', order: 10, render: TasksIndicator }],
});
