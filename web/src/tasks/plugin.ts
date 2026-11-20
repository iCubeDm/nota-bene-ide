import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { tasksSlice, tasksUiSlice } from './slice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof tasksSlice>, WithSlice<typeof tasksUiSlice> {}
}

export const tasksPlugin = definePlugin({ id: 'tasks', slices: [tasksSlice, tasksUiSlice] });
