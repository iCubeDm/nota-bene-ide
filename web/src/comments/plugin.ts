import type { FC } from 'react';
import type { PayloadAction, WithSlice } from '@reduxjs/toolkit';
import type { Comment, CutAnchor } from '@nota-bene/shared';
import { connState, definePlugin, serverEvent, t, toast, type AppThunk, type MediaComment, type PendingComment, type RootState } from '@/sdk';
import { commentsSlice, savedPanelOpen, flushComments, moveCutComment, openCommentCard, removeComment, selectComments, selectMediaComments, selectPendingCountByPath, setPanelOpen } from './slice.ts';
import { CommentsToggle } from './CommentsToggle.tsx';
import { Comments, SelectionComment } from './FrameParts.tsx';
import { flashRange, flashRects, HighlightLayer } from './HighlightLayer.tsx';
import { CommentPopup } from './CommentPopup.tsx';
import { CommentCardPopover, SentComments } from './CommentCard.tsx';
import { commentsPart } from './send.ts';
import { ShortcodePart } from './ShortcodePicker.tsx';

declare module '@/sdk' {
  interface Services { comments: CommentsService }
  interface PluginState extends WithSlice<typeof commentsSlice> {}
}

/**
 * The comments as other plugins' views use them (issue 545), provided by the comments plugin and read with
 * `useService('comments')`: the marks over a pane's text, the popup over a fresh selection or drawing, the flash of a jump, and
 * the comment set.
 */
export interface CommentsService {
  /**
   * The marks over the commented text of a pane (`pane`: the tab id, 'chat' by default), inside its scroll element. A
   * diff view passes the file it shows (`diff`, null for none) and what repaints it (`content`).
   */
  HighlightLayer: FC<{ pane?: string; diff?: { path: string; ref?: string } | null; content?: unknown }>;
  /**
   * `onAdded`: the comment is in the store; `onBusy`: a drawing's Add started (true) or ended without a comment (false);
   * `hidden`: its tab is not shown.
   */
  CommentPopup: FC<{ pending: PendingComment; onClose: () => void; onAdded?: () => void; onBusy?: (busy: boolean) => void; hidden?: boolean }>;
  /** a one-off flash over a fragment, in the pane's layer */
  flashRange(pane: HTMLElement, range: Range): void;
  /** the same over boxes in this window's coordinates (a page element or area) */
  flashRects(pane: HTMLElement, rects: DOMRect[]): void;
  selectComments(s: RootState): Comment[];
  /** pending comments per file, keyed by `fileKey(path, ref)` */
  selectPendingCountByPath(s: RootState): Record<string, number>;
  /** the media comments on one file of one source, in store order */
  selectMediaComments(s: RootState, path: string, ref?: string): MediaComment[];
  /** opens a comment's card at a point */
  openCommentCard(at: { id: string; x: number; y: number }): PayloadAction<{ id: string; x: number; y: number }>;
  /** a comment on an edit, moved with what it marks */
  moveCutComment(id: string, anchor: CutAnchor): AppThunk;
  removeComment(id: string): AppThunk;
}

export const commentsPlugin = definePlugin({
  id: 'comments',
  slices: [commentsSlice],
  slots: [
    { slot: 'strip.right', order: 10, render: CommentsToggle },
    { slot: 'panel.right', order: 10, render: Comments },
    { slot: 'chat', order: 20, render: HighlightLayer },
    { slot: 'overlay', order: 10, render: SelectionComment },
    { slot: 'overlay', order: 20, render: CommentCardPopover },
    { slot: 'composer.pickers', order: 20, render: ShortcodePart },
  ],
  userParts: [{ id: 'comments', order: 40, render: SentComments }],
  sendParts: [commentsPart],
  comments: { HighlightLayer, CommentPopup, flashRange, flashRects, selectComments, selectPendingCountByPath, selectMediaComments, openCommentCard, moveCutComment, removeComment },
  commands: [{ id: 'hk_comments', codes: ['KeyC'], mods: { mod: true, shift: true }, inFields: true, order: 120,
    run: ({ store }) => void store.dispatch(setPanelOpen(!store.getState().comments.ui.panelOpen)) }],
  listeners: (start) => {
    start({
      predicate: (_a, st, was) => st.comments.ui.panelOpen !== was.comments.ui.panelOpen,
      effect: (_a, api) => savedPanelOpen.set(api.getState().comments.ui.panelOpen),
    });
    start({
      actionCreator: serverEvent,
      effect: ({ payload: ev }, api) => {
        // protocol 19: another window changed or deleted the comment first, so this change was not made
        if (ev.kind === 'comment-refused' && ev.reason !== 'failed') toast(t('commentChangedElsewhere'), '');
        // the next queued comment change goes once the server is known (hello) and the previous one is answered
        if (ev.kind === 'hello' || ev.kind === 'comments' || ev.kind === 'comment-ack' || ev.kind === 'comment-refused') api.dispatch(flushComments());
      },
    });
    start({ actionCreator: connState, effect: ({ payload }, api) => void (payload === 'open' && api.dispatch(flushComments())) });
  },
});
