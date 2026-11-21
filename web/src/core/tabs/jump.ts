import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store/store.ts';
import { fileKey } from '../refs/sources.ts';
import { activate, enterRoot, fileArg, fileTabId, openFile } from './slice.ts';

/**
 * A "jump to source" (issue 511): the comment `id` on a file, waiting for that file's view to show it and become
 * active. The view that shows the comment takes it (`clearJump`) once it is on screen: each file view its own.
 */
export type Jump = { path: string; src: string; ref?: string; id: string };

export const jumpSlice = createSlice({
  name: 'jump',
  initialState: null as Jump | null,
  reducers: {
    requestJump: (_s, a: PayloadAction<Jump>) => a.payload,
    clearJump: () => null,
    /** The view of this file closed: a jump still waiting for it is dropped (it must not meet the next open of the file). */
    dropJump: (s, a: PayloadAction<{ path: string; ref?: string }>) => (s && fileKey(s.path, s.ref) === fileKey(a.payload.path, a.payload.ref) ? null : s),
  },
  // the user went elsewhere (another tab, or a jump to a chat comment activates the chat): the pending jump is dropped;
  // another root's paths are other files
  extraReducers: (b) =>
    b.addCase(activate, (s, a) => (s && a.payload !== fileTabId(s.path, s.src) ? null : s))
      .addCase(openFile, (s, a) => {
        const f = fileArg(a.payload);
        return s && (f.path !== s.path || f.src !== s.src) ? null : s;
      })
      .addCase(enterRoot, (s, a) => (a.payload.first ? s : null)),
});

export const { requestJump, clearJump, dropJump } = jumpSlice.actions;
export const selectJump = (s: RootState): Jump | null => s.jump;
