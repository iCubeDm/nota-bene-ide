import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { statsSlice } from './slice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof statsSlice> {}
}

export const statsPlugin = definePlugin({ id: 'stats', slices: [statsSlice] });
