import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { selectRunningCount, tasksSlice, tasksUiSlice } from './slice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof tasksSlice>, WithSlice<typeof tasksUiSlice> {}
}

// the server counts its own running tasks too
export const tasksPlugin = definePlugin({ id: 'tasks', slices: [tasksSlice, tasksUiSlice], pause: (s) => selectRunningCount(s) === 0 });
