import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { historySlice } from './history.ts';
import { composerSlice } from './slice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof composerSlice>, WithSlice<typeof historySlice> {}
}

export const composerPlugin = definePlugin({ id: 'composer', slices: [composerSlice, historySlice] });
