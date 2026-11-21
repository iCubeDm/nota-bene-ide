import type { WithSlice } from '@reduxjs/toolkit';
import { bool, connState, definePlugin, serverEvent, storage, t, toast } from '@/sdk';
import { commentsSlice, flushComments, setPanelOpen } from './slice.ts';
import { CommentsToggle } from './CommentsToggle.tsx';
import { Comments, SelectionComment } from './FrameParts.tsx';
import { HighlightLayer } from './HighlightLayer.tsx';
import { CommentCardPopover } from './CommentCard.tsx';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof commentsSlice> {}
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
  ],
  commands: [{ id: 'hk_comments', codes: ['KeyC'], mods: { mod: true, shift: true }, inFields: true, order: 120,
    run: ({ store }) => void store.dispatch(setPanelOpen(!store.getState().comments.ui.panelOpen)) }],
  listeners: (start) => {
    start({
      predicate: (_a, st, was) => st.comments.ui.panelOpen !== was.comments.ui.panelOpen,
      effect: (_a, api) => storage.local('panel:comments', bool, true).set(api.getState().comments.ui.panelOpen),
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
