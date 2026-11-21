import { definePlugin } from '@/sdk';
import { Attachments, ImagesPart } from './Attachments.tsx';
import { AttachmentCard, revealAttachment } from './AttachmentCard.tsx';
import { ComposerAttachments } from './ComposerAttachments.tsx';
import { useImageIntake } from './useImageIntake.ts';

export const attachmentsPlugin = definePlugin({
  id: 'attachments',
  userParts: [{ id: 'images', order: 30, render: ImagesPart }],
  anchorViews: [{ kind: 'attachment', Card: AttachmentCard, reveal: revealAttachment }],
  attachments: { useIntake: useImageIntake, Attachments, ComposerAttachments },
});
