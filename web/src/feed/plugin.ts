import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { feedUiSlice } from './uiSlice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof feedUiSlice> {}
}

export const feedPlugin = definePlugin({ id: 'feed', slices: [feedUiSlice] });
