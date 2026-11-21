import { definePlugin } from '@/sdk';
import { ImagesPart } from './Attachments.tsx';
import { AttachmentCard, revealAttachment } from './AttachmentCard.tsx';

export const attachmentsPlugin = definePlugin({
  id: 'attachments',
  userParts: [{ id: 'images', order: 30, render: ImagesPart }],
  anchorViews: [{ kind: 'attachment', Card: AttachmentCard, reveal: revealAttachment }],
});
