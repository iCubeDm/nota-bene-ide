import { useCallback, useState } from 'react';
import { useAppDispatch } from '@/sdk';
import { CommentsPanel } from './CommentsPanel.tsx';
import { CommentPopup } from './CommentPopup.tsx';
import { SelectionButton, type PendingSelection } from './SelectionButton.tsx';
import { sendBatch } from './send.ts';

/** The right panel: the comments not sent yet; its Send sends them alone. */
export function Comments() {
  const d = useAppDispatch();
  const send = useCallback(() => void d(sendBatch(false)), [d]);
  return <CommentsPanel onSend={send} />;
}

/** The button over a selection, and the popup it opens to comment on it. */
export function SelectionComment() {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const close = useCallback(() => setPending(null), []);
  return (
    <>
      <SelectionButton onComment={setPending} />
      {pending && <CommentPopup pending={pending} onClose={close} />}
    </>
  );
}
