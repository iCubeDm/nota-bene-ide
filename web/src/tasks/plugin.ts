import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { selectRunningCount, tasksUiSlice, toggleDrawer } from './slice.ts';
import { shellTab } from './ShellView.tsx';
import { TasksDrawer } from './TasksDrawer.tsx';
import { TasksIndicator } from './TasksIndicator.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof tasksUiSlice> {}
}

export const tasksPlugin = definePlugin({
  id: 'tasks',
  slices: [tasksUiSlice],
  // the server counts its own running tasks too
  pause: (s) => selectRunningCount(s) === 0,
  tabs: [shellTab],
  slots: [{ slot: 'panes', order: 10, render: TasksDrawer }, { slot: 'footer', order: 10, render: TasksIndicator }],
  // Alt+T, in a field too (also on a Mac, where Option+T is the † key): the drawer of background tasks. Alt+Shift+T reopens a tab
  commands: [{ id: 'hk_tasks', codes: ['KeyT'], mods: { alt: true }, inFields: true, order: 130, run: ({ store }) => void store.dispatch(toggleDrawer()) }],
});
