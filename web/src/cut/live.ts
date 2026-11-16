// The clip ids of the edits open in a tab now (issue 430), by file: what tells a comment's card and the batch that its
// clip is no longer in the edit. Known only while the edit's tab shows it: a closed tab makes no claim.
import { useSyncExternalStore } from 'react';
import { fileKey } from '@/files/sources.ts';

const clips = new Map<string, ReadonlySet<string>>();
const subs = new Set<() => void>();
const tell = () => { for (const f of subs) f(); };

/** The edit at `path` (`ref`: of another branch) has these clips now; null: its view is gone, nothing is known. */
export function setLiveClips(path: string, ref: string | undefined, ids: ReadonlySet<string> | null): void {
  const k = fileKey(path, ref);
  if (ids === null ? !clips.has(k) : clips.get(k) === ids) return;
  if (ids === null) clips.delete(k);
  else clips.set(k, ids);
  tell();
}

/** Whether clip `id` of that edit is gone: true or false while its tab shows it, undefined otherwise. */
export function clipGone(path: string, ref: string | undefined, id: string): boolean | undefined {
  const ids = clips.get(fileKey(path, ref));
  return ids ? !ids.has(id) : undefined;
}

const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
/** clipGone, re-rendered when that edit's clips change. */
export const useClipGone = (path: string | undefined, ref: string | undefined, id: string | undefined): boolean | undefined =>
  useSyncExternalStore(subscribe, () => (path === undefined || id === undefined ? undefined : clipGone(path, ref, id)));
