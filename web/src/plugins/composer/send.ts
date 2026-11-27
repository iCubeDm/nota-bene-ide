import { activate, sendCount, sendWaiting, t, tIn, toast, type AppThunk, type SendPart, removeImage, selectBuilding, selectImages, selectUploading } from '@/sdk';
import { isClearCommand } from './slashRank.ts';
import { runShellDraft, selectShellMode } from './shellMode.ts';
import { draftSent, flushDraft, selectDraft, setDraft, type ImageEntry } from './slice.ts';

/**
 * Once the message went: only what was taken leaves the composer, the draft text (a tail typed since stays) and the
 * taken images; until the echo it is kept, so a refusal puts it back (`refused.ts`). A send switches to the chat tab.
 */
const draftGone = (id: string, draft: string, body: string, own: ImageEntry[]): AppThunk => (d, getState) => {
  d(draftSent({ id, text: body, images: own }));
  const cur = selectDraft(getState());
  d(setDraft(draft && cur.startsWith(draft) ? cur.slice(draft.length).trimStart() : cur));
  for (const im of own) d(removeImage(im.id));
  d(flushDraft()); // every client of the window sees the draft go
  d(activate('chat')); // sent from a file tab: the reply arrives in the chat (prototype parity)
};

/**
 * The composer's part of a send (issue 511): the draft and its images, first in the message. It decides whether a message
 * goes at all: a `! cmd` draft is run instead; an upload or a send still building, or nothing to send, sends nothing; a
 * /clear waits while other parts hold items (it would drop them). An empty draft is still taken: the message is the
 * composer's, cleared and given back on a refusal as one.
 */
export const draftPart: SendPart = {
  id: 'draft',
  order: 10,
  take: (st, d, { registry }) => {
    // `! cmd` is not a message: the server runs it (comments and images pending: refused, the draft kept)
    if (selectShellMode(st)) return d(runShellDraft());
    const draft = selectDraft(st), body = draft.trim(), own = selectImages(st);
    const busy = selectUploading(st) > 0 || selectBuilding(st);
    if ((!body && !own.length && !sendCount(registry, st)) || busy) {
      // only detached comments pending: say why nothing goes, never silence
      if (sendWaiting(registry, st) && !busy) return (toast(t('sendOnlyDetached'), ''), 'detached');
      return 'empty';
    }
    // /clear drops the whole conversation, the comments with it: hold it until they are sent or removed
    if (sendWaiting(registry, st) && isClearCommand(body, st.controls.commands)) return (toast(t('clearWithComments'), ''), 'blocked');
    return {
      compose: ({ lang }) => ({ text: body, images: own.map((im, k) => ({ ...im, label: tIn(lang, 'imgLabel', k + 1) })) }),
      sent: (id) => d(draftGone(id, draft, body, own)),
    };
  },
};
