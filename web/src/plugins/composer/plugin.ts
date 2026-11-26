import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin, selectBuilding, selectImages, selectUploading, type Field } from '@/sdk';
import { historyMiddleware, historySlice } from './history.ts';
import { refusedMiddleware } from './refused.ts';
import { Composer } from './Composer.tsx';
import { MentionPart } from './MentionPicker.tsx';
import { composerCommands, composerField } from './commands.ts';
import { draftPart } from './send.ts';
import { selectShellRunning } from './shellMode.ts';
import { ShellBlock } from './ShellBlock.tsx';
import { composerSettings } from './settings.tsx';
import { composerSlice, selectDraft } from './slice.ts';

declare module '@/sdk' {
  interface Services { composer: ComposerService }
  interface PluginState extends WithSlice<typeof composerSlice>, WithSlice<typeof historySlice> {}
}

/** The composer as other plugins reach it (issue 563), provided by the composer plugin. */
export interface ComposerService {
  /** the message field, to hand the focus back to */
  field(): Field | null;
}

export const composerPlugin = definePlugin({
  id: 'composer',
  slices: [composerSlice, historySlice],
  // the refusal first: it reads `composer.unconfirmed` before the history's record and the reducer drop it
  middleware: [refusedMiddleware, historyMiddleware],
  // no upload, no send on its way and no `! cmd` run; `draft`: a typed draft or attached images count as well
  pause: (s, o) => !(o.draft && (selectDraft(s).trim() !== '' || selectImages(s).length > 0))
    && selectUploading(s) === 0 && !selectBuilding(s)
    && s.composer.unconfirmed === null && s.composer.shellUnconfirmed === null && selectShellRunning(s) === null,
  slots: [{ slot: 'footer', order: 20, render: Composer }, { slot: 'composer.pickers', order: 10, render: MentionPart }],
  commands: composerCommands,
  sendParts: [draftPart],
  // a `! cmd` run's block in the chat, and the shell it runs in on Windows
  feed: [{ kind: 'shell', render: ShellBlock }],
  settings: composerSettings,
  composer: { field: composerField },
});
