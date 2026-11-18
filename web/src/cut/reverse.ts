// A reversed clip's copy (issue 492): the server makes it once with ffmpeg (`GET /cut/reverse`, server/src/cut/reverse.ts)
// and answers 202 while it does; this asks again every second until the copy is there or refused. The preview plays the
// copy, the timeline marks a clip whose copy is being made or could not be.
import { useSyncExternalStore } from 'react';
import type { CutClip } from '@nota-bene/shared/cut';
import { projectFileUrl } from '@/files/kinds.ts';
import { apiFetch } from '@/net/auth.ts';

/** The copy's URL; still being made; or none (no ffmpeg, a source of another branch or worktree, a failed copy). */
export type Reversed = { url: string } | 'making' | 'failed';

type Deps = {
  /** `GET /cut/reverse?path=&in=&out=` */
  fetch: (src: string, from: number, to: number) => Promise<Response>;
  wait: (ms: number) => Promise<void>;
};

export const POLL_MS = 1000;
// a part as the server keys it: without float noise (0.1 + 0.2 is 0.3)
const num = (n: number): number => Math.round(n * 1e6) / 1e6;

/** The copies by source and part, and their subscribers (each change of any of them tells them all). */
export function reversedStore(d: Deps) {
  const states = new Map<string, Reversed>();
  const subs = new Set<() => void>();
  let version = 0;
  const set = (key: string, v: Reversed) => {
    states.set(key, v);
    version++;
    for (const f of subs) f();
  };
  const ask = async (key: string, src: string, from: number, to: number) => {
    for (;;) {
      const r = await d.fetch(src, from, to).catch(() => null);
      // an unreachable server (a restart) is asked again, as a copy still being made is
      if (r?.status === 200) {
        const body = (await r.json().catch(() => null)) as { path?: unknown } | null;
        return set(key, typeof body?.path === 'string' ? { url: projectFileUrl(body.path) } : 'failed');
      }
      if (r && r.status !== 202) return set(key, 'failed');
      await d.wait(POLL_MS);
    }
  };
  return {
    /** The copy of clip `c`'s used part (of the edit seen from `fileSrc`); the first ask for a part starts it. */
    of(c: Pick<CutClip, 'src' | 'in' | 'out'>, fileSrc: string): Reversed {
      // the server makes copies of the session's project only
      if (fileSrc && fileSrc !== 'here') return 'failed';
      const from = num(c.in ?? 0), to = num(c.out ?? 0);
      const key = `${c.src}\n${from}\n${to}`;
      const had = states.get(key);
      if (had) return had;
      states.set(key, 'making');
      void ask(key, c.src, from, to);
      return 'making';
    },
    subscribe(f: () => void): () => void {
      subs.add(f);
      return () => void subs.delete(f);
    },
    version: () => version,
  };
}

/** The app's copies. */
export const reversed = reversedStore({
  fetch: (src, from, to) => apiFetch(`/cut/reverse?path=${encodeURIComponent(src)}&in=${from}&out=${to}`),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/** A number that changes whenever any copy does: a render that reads `reversed.of` again. */
export const useReversedVersion = (): number => useSyncExternalStore(reversed.subscribe, reversed.version);
