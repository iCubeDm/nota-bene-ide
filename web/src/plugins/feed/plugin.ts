import type { FC } from 'react';
import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin, type AppThunk, type FeedItem, type FeedState, type RootState } from '@/sdk';
import { compactTimingMiddleware } from './compactTiming.ts';
import { feedUiSlice, revealToolOf } from './uiSlice.ts';
import { ChatFeed, Feed } from './Feed.tsx';
import { FEED_RENDERERS } from './items.tsx';
import { UserText } from './UserMessage.tsx';

declare module '@/sdk' {
  interface Services { feedUi: FeedUiService }
  interface PluginState extends WithSlice<typeof feedUiSlice> {}
}

/** The chat feed's panels as other plugins open them (issue 545), provided by the feed plugin. */
export interface FeedUiService {
  /** opens an action's panel and its group, read from its conversation's `items` (`agent`: a subagent's) at call time */
  revealTool(toolId: string, items: (s: RootState) => FeedItem[] | null, agent?: string): AppThunk;
  /** a conversation drawn as the chat's: `agent`, a subagent's (its panels and comments are keyed by it) */
  Feed: FC<{ feed: FeedState; agent: string; running?: boolean }>;
  /** the open panels and groups: they move a conversation's text without a feed change */
  selectFolds(s: RootState): unknown;
}

export const feedPlugin = definePlugin({
  id: 'feed', slices: [feedUiSlice], middleware: [compactTimingMiddleware], slots: [{ slot: 'chat', order: 10, render: ChatFeed }],
  feed: FEED_RENDERERS,
  userParts: [{ id: 'text', order: 20, render: UserText }],
  feedUi: { revealTool: revealToolOf, Feed, selectFolds: (s) => s.feedUi },
});
