import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { commentsSlice } from './slice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof commentsSlice> {}
}

export const commentsPlugin = definePlugin({ id: 'comments', slices: [commentsSlice] });
