// The edits open in a tab now (issue 430), by file: what tells a comment's card and the batch that its clip is no longer
// in the edit, or that a trim cut its moment out. Known only while the edit's tab shows it: a closed tab makes no claim.
import { useSyncExternalStore } from 'react';
import type { CutAnchor } from '@nota-bene/shared';
import type { Cut } from '@nota-bene/shared/cut';
import { cutState } from './pin.ts';
import { fileKey } from '@/sdk';

const cuts = new Map<string, Cut>();
const subs = new Set<() => void>();
const tell = () => { for (const f of subs) f(); };

/** The edit at `path` (`ref`: of another branch) is `cut` now; null: its view is gone, nothing is known. */
export function setLiveCut(path: string, ref: string | undefined, cut: Cut | null): void {
  const k = fileKey(path, ref);
  if (cut === null ? !cuts.has(k) : cuts.get(k) === cut) return;
  if (cut === null) cuts.delete(k);
  else cuts.set(k, cut);
  tell();
}

/** How a cut comment stands in its edit as its tab shows it (pin.ts, cutState); undefined while no tab shows it. */
export function liveCutState(a: CutAnchor): 'ok' | 'trimmed' | 'gone' | undefined {
  const cut = cuts.get(fileKey(a.source.path, a.source.ref));
  return cut ? cutState(a, cut) : undefined;
}

const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
/** liveCutState, re-rendered when that edit changes; undefined for no anchor. */
export const useCutState = (a: CutAnchor | null | undefined): 'ok' | 'trimmed' | 'gone' | undefined =>
  useSyncExternalStore(subscribe, () => (a ? liveCutState(a) : undefined));
