import type { ClipboardEvent, FC } from 'react';
import { definePlugin, type ImageEntry } from '@/sdk';
import { Attachments, ImagesPart } from './Attachments.tsx';
import { AttachmentCard, revealAttachment } from './AttachmentCard.tsx';
import { ComposerAttachments } from './ComposerAttachments.tsx';
import { useImageIntake, type PendingThumb } from './useImageIntake.ts';

declare module '@/sdk' {
  interface Services { attachments: AttachmentsService }
}

/**
 * The attachments as the composer and the comment popup take them (issue 545), provided by the attachments plugin and
 * read with `useService('attachments')`: the intake of pasted, dropped and picked files, and their thumbnails.
 */
export interface AttachmentsService {
  /**
   * A finished image goes to `onUploaded`, any other file's project path to `onFilePath`; `notify` gets the failures,
   * `onBusy(±1)` the uploads running. `add` takes files, `cancel(key)` stops a file's upload.
   */
  useIntake(o: { onUploaded: (e: ImageEntry) => void; onFilePath: (path: string) => void; notify: (msg: string) => void; onBusy?: (d: 1 | -1) => void }): {
    pending: PendingThumb[]; add(files: Iterable<File>): boolean; onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void; cancel(key: string): void;
  };
  /** a strip of thumbnails: the uploaded `ids` (× with `onRemove`) and the uploads in flight */
  Attachments: FC<{ ids: string[]; pending?: PendingThumb[]; onCancel?: (key: string) => void; onRemove?: (id: string) => void } & { 'data-testid'?: string }>;
  /** the composer's strip, with each image's markup */
  ComposerAttachments: FC<{ pending: PendingThumb[]; onCancel?: (key: string) => void }>;
}

export const attachmentsPlugin = definePlugin({
  id: 'attachments',
  userParts: [{ id: 'images', order: 30, render: ImagesPart }],
  anchorViews: [{ kind: 'attachment', Card: AttachmentCard, reveal: revealAttachment }],
  attachments: { useIntake: useImageIntake, Attachments, ComposerAttachments },
});
