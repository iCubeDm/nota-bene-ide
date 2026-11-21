import type { WithSlice } from '@reduxjs/toolkit';
import { definePlugin } from '@/sdk';
import { historyMiddleware, historySlice } from './history.ts';
import { refusedMiddleware } from './refused.ts';
import { Composer } from './Composer.tsx';
import { composerCommands } from './commands.ts';
import { selectShellRunning } from './shellMode.ts';
import { composerSlice, selectBuilding, selectDraft, selectImages, selectUploading } from './slice.ts';

declare module '@/sdk' {
  interface PluginState extends WithSlice<typeof composerSlice>, WithSlice<typeof historySlice> {}
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
  slots: [{ slot: 'footer', order: 20, render: Composer }],
  commands: composerCommands,
});
