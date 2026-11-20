import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { treeSlice } from './slice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof treeSlice> {}
}

export const treePlugin = definePlugin({ id: 'tree', slices: [treeSlice] });
