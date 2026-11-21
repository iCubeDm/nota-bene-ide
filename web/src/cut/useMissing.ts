import { useEffect, useState } from 'react';
import { projectFileUrl } from '@/files/kinds.ts';
import { useAppSelector } from '@/sdk';
import { selectRefreshSeq } from '@/files/treeSlice.ts';

/**
 * The edit's sources that are not in the project: one HEAD per source (of the file view's `src`, a worktree or a
 * branch), again after each turn (the agent may have added the file). Only a 404 counts: an error is no verdict.
 */
export function useMissing(srcs: string[], fileSrc: string, active: boolean): ReadonlySet<string> {
  const seq = useAppSelector(selectRefreshSeq);
  const key = [...new Set(srcs)].sort().join('\n');
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!active) return;
    if (!key) return void setMissing(new Set());
    const ac = new AbortController();
    const head = (s: string) =>
      fetch(projectFileUrl(s, fileSrc), { method: 'HEAD', signal: ac.signal }).then((r) => (r.status === 404 ? s : null), () => null);
    void Promise.all(key.split('\n').map(head)).then((r) => {
      if (!ac.signal.aborted) setMissing(new Set(r.filter((s): s is string => s !== null)));
    });
    return () => ac.abort();
  }, [key, fileSrc, active, seq]);
  return missing;
}
