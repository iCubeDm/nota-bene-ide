import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { markupSlice, selectDraft } from './markup/slice.ts';
import { MediaBody } from './MediaBody.tsx';
import { MediaCard } from './MediaCard.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof markupSlice> {}
}

export const mediaPlugin = definePlugin({
  id: 'media',
  slices: [markupSlice],
  fileViews: [{
    id: 'media', order: 30, media: true, match: (_path, kind) => kind === 'image' || kind === 'video' || kind === 'audio', render: MediaBody,
    // while marking up, the media is held as it is (the drawing belongs to this frame); leaving catches up
    holds: (s, tabId) => selectDraft(s, tabId).on,
  }],
  // a mark is drawn from relative coordinates: never orphaned
  anchorViews: [{ kind: 'media', Card: MediaCard, orphan: false }],
});
