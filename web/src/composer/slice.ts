import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { connState, serverEvent, type ImageEntry, type RootState } from '@/sdk';

/** What the last `! cmd` took out of the composer; kept until the server's `shell-start`, so a `shell-refused` can put the draft back. */
export type ShellDraft = { id: string; draft: string };

export type { ImageEntry };

/** What the last send took out of the composer; kept until the server's `user` echo, so a `send-refused` can put it back. */
export type SentDraft = { id: string; text: string; images: ImageEntry[] };

/** The composer's draft lives in the store so the comments panel's send can include it; its images are core (`message`). */
export const composerSlice = createSlice({
  name: 'composer',
  initialState: { draft: '', unconfirmed: null as SentDraft | null, shellUnconfirmed: null as ShellDraft | null },
  reducers: {
    setDraft: (s, a: PayloadAction<string>) => void (s.draft = a.payload),
    draftSent: (s, a: PayloadAction<SentDraft>) => void (s.unconfirmed = a.payload),
    shellDraftSent: (s, a: PayloadAction<ShellDraft>) => void (s.shellUnconfirmed = a.payload),
  },
  extraReducers: (b) =>
    b.addCase(serverEvent, (s, a) => {
      const ev = a.payload;
      // the echo (or the refusal, handled by refusedMiddleware before this runs), or a new history: nothing left to restore
      // `send-held` (protocol 27): taken, it waits behind a pending restart or compaction
      if (((ev.kind === 'user' || ev.kind === 'send-held') && ev.id === s.unconfirmed?.id) || ev.kind === 'send-refused' || ev.kind === 'replay') s.unconfirmed = null;
      if ((ev.kind === 'shell-start' && ev.id === s.shellUnconfirmed?.id) || ev.kind === 'shell-refused' || ev.kind === 'replay') s.shellUnconfirmed = null;
    }).addCase(connState, (s, a) => {
      if (a.payload !== 'open') s.unconfirmed = s.shellUnconfirmed = null; // the refusal can no longer arrive on this socket
    }),
});

export const { setDraft, draftSent, shellDraftSent } = composerSlice.actions;
export const selectDraft = (s: RootState): string => s.composer.draft;
