import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { markupSlice } from './markup/slice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof markupSlice> {}
}

export const mediaPlugin = definePlugin({ id: 'media', slices: [markupSlice] });
