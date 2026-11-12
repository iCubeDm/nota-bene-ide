import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RequestListener } from 'node:http';
import { isSessionId } from '@nota-bene/shared';
import type { ProviderBackend as AgentBackend } from './agent/types.ts';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';
import { wirePath } from './wirePath.ts';
import { readJson } from './system.ts';

type Titled = { customTitle?: string; summary?: string; firstPrompt?: string };

/** The first of customTitle, summary, firstPrompt that is non-empty and not a slash command (prototype titleOf). */
export const titleOf = (x: Titled | null | undefined): string | null =>
  [x?.customTitle, x?.summary, x?.firstPrompt].find((t): t is string => !!t && !t.startsWith('/')) ?? null;

/** The CLI's transcripts: <config>/projects/<project>/<id>.jsonl. */
export function defaultProjectsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
}

const HEAD = 262144;
const CWD_RE = /"cwd":("(?:[^"\\]|\\.)*")/;
const SAFE_ID = /^[\w-]{1,100}$/;
// a session's cwd never changes, so a hit is kept for the process; a miss (no transcript yet, or no cwd in its
// head yet) only for a minute. Keyed by projects dir and id
const MISS_TTL_MS = 60_000;
const cwdCache = new Map<string, { cwd: string | null; at: number }>();

/** The session's working dir, read from the head of its transcript; null when there is none (cached too). */
export function cwdOf(id: string, projectsDir: string = defaultProjectsDir()): string | null {
  const key = `${projectsDir}\0${id}`;
  const hit = cwdCache.get(key);
  if (hit && (hit.cwd !== null || Date.now() - hit.at < MISS_TTL_MS)) return hit.cwd;
  let found: string | null = null;
  if (SAFE_ID.test(id)) {
    let projects: string[] = [];
    try {
      projects = fs.readdirSync(projectsDir);
    } catch {
      // no projects dir: nothing to find
    }
    for (const p of projects) {
      const file = path.join(projectsDir, p, `${id}.jsonl`);
      let fd: number;
      try {
        fd = fs.openSync(file, 'r');
      } catch {
        continue;
      }
      try {
        const buf = Buffer.alloc(HEAD);
        const n = fs.readSync(fd, buf, 0, HEAD, 0);
        const m = CWD_RE.exec(buf.subarray(0, n).toString('utf8'));
        if (m) {
          try {
            const v: unknown = JSON.parse(m[1]!);
            if (typeof v === 'string' && v) found = v;
          } catch {
            // a broken escape: treat as no cwd
          }
        }
      } catch {
        // unreadable: no cwd
      } finally {
        fs.closeSync(fd);
      }
      break;
    }
  }
  cwdCache.set(key, { cwd: found, at: Date.now() });
  return found;
}

/** True when some project holds <id>.jsonl (the id of a session that can still be resumed). */
export function transcriptExists(id: string, projectsDir: string = defaultProjectsDir()): boolean {
  if (!SAFE_ID.test(id)) return false;
  let projects: string[];
  try {
    projects = fs.readdirSync(projectsDir);
  } catch {
    return false;
  }
  return projects.some((p) => fs.existsSync(path.join(projectsDir, p, `${id}.jsonl`)));
}

export type SessionsView = {
  current: string | null;
  root: string;
  sessions: { id: string; title: string; at: number; size: number; cwd: string }[];
};

/** The native realpath (case, firmlinks, symlinks), the raw value when it cannot be resolved. */
function realOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** GET /sessions: every project's sessions; the ones without a cwd are dropped (they cannot be resumed in the right folder). */
export async function listSessionsView(o: {
  backend: Pick<AgentBackend, 'listSessions' | 'nativeSessions'>;
  current: string | null;
  root: string;
  projectsDir?: string;
}): Promise<SessionsView> {
  const list = await o.backend.listSessions();
  const sessions: SessionsView['sessions'] = [];
  for (const x of list) {
    const cwd = x.cwd || (o.backend.nativeSessions ? null : cwdOf(x.sessionId, o.projectsDir));
    if (!cwd) continue;
    sessions.push({ id: x.sessionId, title: titleOf(x) ?? '', at: x.lastModified, size: x.fileSize ?? 0, cwd: wirePath(realOr(cwd)) });
  }
  return { current: o.current, root: wirePath(o.root), sessions };
}

const MAX_TITLE = 200;

/** POST /sessions/rename {id, title}: in the key tier (auth.ts). A title is one line of at most 200 characters. */
export function renameRoute(o: { hub: EventHub; rename: (id: string, title: string) => Promise<void> }): RequestListener {
  return (req, res) => {
    const answer = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    if (req.method !== 'POST') return answer(405, 'method not allowed');
    readJson(req).then(async (b) => {
      const { id, title } = b as { id?: unknown; title?: unknown };
      const t = typeof title === 'string' ? title.trim() : '';
      // eslint-disable-next-line no-control-regex
      if (!isSessionId(id) || !t || t.length > MAX_TITLE || /[\x00-\x1f\x7f]/.test(t)) return answer(400, 'bad id or title');
      await o.rename(id, t);
      answer(200, 'ok');
    }).catch((e: unknown) => {
      if (e instanceof SyntaxError) return answer(400, 'bad json');
      reportError(o.hub, 'sessions/rename', e);
      answer(500, e instanceof Error ? e.message : String(e));
    });
  };
}
