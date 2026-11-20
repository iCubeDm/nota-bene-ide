import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { controlsSlice } from './slice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof controlsSlice> {}
}

export const controlsPlugin = definePlugin({ id: 'controls', slices: [controlsSlice] });
