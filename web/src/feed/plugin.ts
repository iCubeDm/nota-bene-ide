import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { compactTimingMiddleware } from './compactTiming.ts';
import { feedUiSlice, revealToolOf } from './uiSlice.ts';
import { ChatFeed } from './Feed.tsx';
import { FEED_RENDERERS } from './items.tsx';
import { UserText } from './UserMessage.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof feedUiSlice> {}
}

export const feedPlugin = definePlugin({
  id: 'feed', slices: [feedUiSlice], middleware: [compactTimingMiddleware], slots: [{ slot: 'chat', order: 10, render: ChatFeed }],
  feed: FEED_RENDERERS,
  userParts: [{ id: 'text', order: 20, render: UserText }],
  feedUi: { revealTool: revealToolOf },
});
