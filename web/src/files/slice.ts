import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { type RootState, openFile, requestJump, type AppThunk, fileKey, isCommitRef, loadSources, srcIdOfRef, enterRoot, openLog } from '@/sdk';

/**
 * What an open file view shows, for the comments on it (`FileLoad`), keyed by `fileKey(path, ref)`: the path alone for
 * this folder, so a.md and a.md @ feature/x never mix (M3-16).
 */
/**
 * What an open file view shows, for the comments on it. `loaded`: its text is in the DOM (anchors resolve against it);
 * `gone`: the view settled without text (deleted, too large, binary), so a comment on it is orphaned. No entry, or
 * `loading`: unknown (tab closed, not fetched yet, a transient error): a comment is neither marked nor orphaned.
 * `v` bumps on every settled load, so a reload re-runs the checks even when the state stays `loaded`.
 */
export type FileLoad = { s: 'loading' | 'loaded' | 'gone'; v: number };

/** A file of some source: `ref` only when it is not this folder. */
type FileRef = { path: string; ref?: string };
/**
 * `version`: the current ETag of an open media tab's file, read when it (re)loads (only while it has a media comment
 * with a version; absent for a branch source): a media comment compares it with its anchor's for "the file has changed
 * since". No entry = unknown (tab closed): no claim either way.
 */
type FilesState = { load: Record<string, FileLoad>; version: Record<string, string>; /** the recent files dialog is open (Alt+E) */ recentOpen: boolean };

const keyOf = (f: string | FileRef) => (typeof f === 'string' ? f : fileKey(f.path, f.ref));

export const filesSlice = createSlice({
  name: 'files',
  initialState: (): FilesState => ({ load: {}, version: {}, recentOpen: false }),
  reducers: {
    setRecentOpen: (s, a: PayloadAction<boolean>) => void (s.recentOpen = a.payload),
    setFileLoad: (s, a: PayloadAction<FileRef & { s: FileLoad['s'] }>) => {
      const k = keyOf(a.payload);
      s.load[k] = { s: a.payload.s, v: (s.load[k]?.v ?? 0) + 1 };
    },
    dropFileLoad: (s, a: PayloadAction<string | FileRef>) => {
      delete s.load[keyOf(a.payload)];
    },
    /** `version` undefined: unknown again (the tab closed, or the file has no ETag). */
    setFileVersion: (s, a: PayloadAction<FileRef & { version?: string }>) => {
      const k = keyOf(a.payload);
      if (a.payload.version === undefined) delete s.version[k];
      else s.version[k] = a.payload.version;
    },
  },
  extraReducers: (b) =>
    b.addCase(enterRoot, (s, a) => {
      // another root: its paths are other files; what was loaded belongs to the old one
      if (a.payload.first) return;
      s.load = {};
      s.version = {};
    }),
});

export const { setFileLoad, dropFileLoad, setFileVersion, setRecentOpen } = filesSlice.actions;
export const selectRecentOpen = (s: RootState): boolean => s.files.recentOpen;

/**
 * Opens (or activates) the file tab and asks its view to scroll to the comment's fragment once loaded. A comment with
 * a `ref` opens from `ref:<branch>` (the view says when that branch is gone), or from the detached worktree carrying it.
 * A comment made on a commit opens that commit in the log.
 */
export const jumpToFileComment = (path: string, id: string, ref?: string): AppThunk => (d, _get, { registry }) => {
  if (isCommitRef(ref)) {
    d(openLog());
    if (registry.vcs) d(registry.vcs.showCommit(ref, path));
    return;
  }
  const go = (src: string) => {
    d(openFile({ path, src, ref }));
    d(requestJump({ path, src, ...(ref ? { ref } : {}), id }));
  };
  const src = srcIdOfRef(ref);
  if (src) return go(src);
  void loadSources(true).then(() => {
    const again = srcIdOfRef(ref);
    if (again) go(again);
  });
};

export const selectFileLoad = (s: RootState, path: string, ref?: string): FileLoad | undefined => s.files.load[fileKey(path, ref)];
export const selectFileVersion = (s: RootState, path: string, ref?: string): string | undefined => s.files.version[fileKey(path, ref)];
