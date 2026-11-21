import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { compactTimingMiddleware } from './compactTiming.ts';
import { feedUiSlice } from './uiSlice.ts';
import { ChatFeed } from './Feed.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof feedUiSlice> {}
}

export const feedPlugin = definePlugin({ id: 'feed', slices: [feedUiSlice], middleware: [compactTimingMiddleware], slots: [{ slot: 'chat', order: 10, render: ChatFeed }] });
