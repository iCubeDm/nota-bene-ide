import { createAction, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { connState, serverEvent, type ImageEntry, type RootState } from '@/sdk';

/** What the last `! cmd` took out of the composer; kept until the server's `shell-start`, so a `shell-refused` can put the draft back. */
export type ShellDraft = { id: string; draft: string };

export type { ImageEntry };

/** What the last send took out of the composer; kept until the server's `user` echo, so a `send-refused` can put it back. */
export type SentDraft = { id: string; text: string; images: ImageEntry[] };

/**
 * The draft's sync with the server (issue 174, `draftSync.ts`). `scope`: the session of the last `draft` event taken
 * (unset before the first); `pending`: this client's last write not yet acked; `dirty`: local edits since that write;
 * `typedInSwitch`: an edit made in this client's switch, whose writes wait for the new session.
 */
export type DraftSync = { scope?: string | null; pending: string | null; dirty: boolean; typedInSwitch: boolean };

/**
 * The composer's draft lives in the store so the comments panel's send can include it; its images are core (`message`).
 * `setDraft` is a local edit (the sync writes it); `draftApplied` another client's.
 */
export const composerSlice = createSlice({
  name: 'composer',
  initialState: { draft: '', unconfirmed: null as SentDraft | null, shellUnconfirmed: null as ShellDraft | null, sync: { pending: null, dirty: false, typedInSwitch: false } as DraftSync },
  reducers: {
    setDraft: (s, a: PayloadAction<string>) => void (s.draft = a.payload),
    draftApplied: (s, a: PayloadAction<string>) => void (s.draft = a.payload),
    draftEdited: (s, a: PayloadAction<{ inSwitch: boolean }>) => void ((s.sync.dirty = true), a.payload.inSwitch && (s.sync.typedInSwitch = true)),
    draftWritten: (s, a: PayloadAction<string>) => void ((s.sync.pending = a.payload), (s.sync.dirty = false)),
    draftSynced: (s, a: PayloadAction<DraftSync>) => void (s.sync = a.payload),
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
      if (a.payload === 'open') return;
      s.unconfirmed = s.shellUnconfirmed = null; // the refusal can no longer arrive on this socket
      // nor the ack of a write: it may be lost with the socket, so it goes again at the next hello
      if (s.sync.pending !== null) s.sync = { ...s.sync, pending: null, dirty: true };
    }),
});

export const { setDraft, draftSent, shellDraftSent, draftApplied, draftEdited, draftWritten, draftSynced } = composerSlice.actions;
/** write the draft now, not at the throttle's next turn: a send, a blur, the page going away */
export const flushDraft = createAction('composer/flushDraft');
export const selectDraft = (s: RootState): string => s.composer.draft;
