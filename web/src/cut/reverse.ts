// A reversed clip's copy (issue 492): the server makes it once with ffmpeg (`GET /cut/reverse`, server/src/cut/reverse.ts)
// and answers 202 while it does. An edit's view keeps one of these: on each committed change of the edit it asks again for
// every reversed part (a copy already made answers at once, and the server keeps it as recently used; one removed since is
// made again, under a new URL only when its source changed), and polls a part every second while it is made, only as
// long as the edit still wants it. The preview plays the copy, the timeline marks a clip whose copy is not there.
import { isPhotoSrc, type Cut } from '@nota-bene/shared/cut';
import { projectFileUrl } from '@/files/kinds.ts';
import { connections } from '@/sdk';

/** The copy's URL; still being made; refused (no ffmpeg, a failed copy); too long to hold in memory; or an edit of another branch or worktree, whose copies the server does not make. */
export type Reversed = { url: string } | 'making' | 'failed' | 'too-long' | 'elsewhere';
/** A reversed clip's used part, and whether only its sound is played (a video on an audio track). */
export type Part = { src: string; in?: number; out?: number; sound: boolean };

type Deps = {
  /** `GET /cut/reverse?path=&in=&out=[&sound=1]` */
  fetch: (p: Part) => Promise<Response>;
  wait: (ms: number) => Promise<void>;
};

export const POLL_MS = 1000;
// a part as the server keys it: without float noise (0.1 + 0.2 is 0.3)
const num = (n: number): number => Math.round(n * 1e6) / 1e6;
const keyOf = (p: Part): string => `${p.src}\n${num(p.in ?? 0)}\n${num(p.out ?? 0)}${p.sound ? '\nsound' : ''}`;

/** The edit's reversed clips as parts. */
export const reversedParts = (cut: Cut): Part[] => cut.clips.flatMap((c) => (c.reverse && !isPhotoSrc(c.src)
  ? [{ src: c.src, in: c.in, out: c.out, sound: cut.tracks.find((t) => t.id === c.track)?.kind === 'audio' }] : []));

/** One edit view's copies. */
export function reversedCopies(d: Deps) {
  const states = new Map<string, Reversed>();
  const parts = new Map<string, Part>(); // the wanted ones
  const asking = new Set<string>();
  const subs = new Set<() => void>();
  let version = 0;
  const set = (key: string, v: Reversed) => {
    const had = states.get(key);
    if (had === v || (typeof had === 'object' && typeof v === 'object' && had.url === v.url)) return;
    states.set(key, v);
    version++;
    for (const f of subs) f();
  };
  const ask = async (key: string) => {
    if (asking.has(key)) return;
    asking.add(key);
    try {
      while (parts.has(key)) {
        const r = await d.fetch(parts.get(key)!).catch(() => null);
        if (r?.status === 200) {
          const body = (await r.json().catch(() => null)) as { path?: unknown } | null;
          return set(key, typeof body?.path === 'string' ? { url: projectFileUrl(body.path) } : 'failed');
        }
        if (r && r.status !== 202) {
          const body = (await r.json().catch(() => null)) as { error?: unknown } | null;
          return set(key, body?.error === 'too-long' ? 'too-long' : 'failed');
        }
        // being made (again: a copy removed since plays no more), or the server unreachable for now (a restart)
        if (r) set(key, 'making');
        await d.wait(POLL_MS);
      }
    } finally {
      asking.delete(key);
    }
  };
  return {
    /** The edit's reversed parts now (of the edit seen from `fileSrc`): each is asked for again, the rest no more. */
    want(list: Part[], fileSrc: string): void {
      parts.clear();
      for (const p of list) {
        const key = keyOf(p);
        // the server makes copies of the session's project only
        if (fileSrc && fileSrc !== 'here') {
          set(key, 'elsewhere');
          continue;
        }
        parts.set(key, p);
        if (!states.has(key)) set(key, 'making');
        void ask(key);
      }
    },
    /** What is known of a part's copy; null for a part not asked for (one being dragged). */
    of: (p: Part): Reversed | null => states.get(keyOf(p)) ?? null,
    /** A copy that failed to load (removed under the page): being made again until the server says so. false: no copy of ours. */
    failed(url: string): boolean {
      let ours = false;
      for (const [key, v] of states) {
        if (typeof v !== 'object' || v.url !== url || !parts.has(key)) continue;
        ours = true;
        set(key, 'making');
        void ask(key);
      }
      return ours;
    },
    /** The view is gone: nothing is asked any more (until it wants parts again). */
    close: (): void => parts.clear(),
    subscribe(f: () => void): () => void {
      subs.add(f);
      return () => void subs.delete(f);
    },
    version: () => version,
  };
}

/** The app's way to ask: the session's server. */
export const askServer: Deps = {
  fetch: (p) => connections.current().fetch(`/cut/reverse?path=${encodeURIComponent(p.src)}&in=${num(p.in ?? 0)}&out=${num(p.out ?? 0)}${p.sound ? '&sound=1' : ''}`),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};
