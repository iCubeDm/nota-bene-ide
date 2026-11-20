import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { filesSlice } from './slice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof filesSlice> {}
}

export const filesPlugin = definePlugin({ id: 'files', slices: [filesSlice] });
