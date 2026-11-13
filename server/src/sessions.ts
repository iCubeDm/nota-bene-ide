import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RequestListener } from 'node:http';
import { isSessionId } from '@nota-bene/shared';
import { SessionNotFoundError, type ProviderBackend as AgentBackend } from './agent/types.ts';
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
  /** `archived`: hidden by the menu's archive (archivedSessions.ts) */
  sessions: { id: string; title: string; at: number; size: number; cwd: string; archived?: true }[];
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
  archived?: ReadonlySet<string>;
}): Promise<SessionsView> {
  const list = await o.backend.listSessions();
  const sessions: SessionsView['sessions'] = [];
  for (const x of list) {
    const cwd = x.cwd || (o.backend.nativeSessions ? null : cwdOf(x.sessionId, o.projectsDir));
    if (!cwd) continue;
    sessions.push({
      id: x.sessionId, title: titleOf(x) ?? '', at: x.lastModified, size: x.fileSize ?? 0, cwd: wirePath(realOr(cwd)),
      ...(o.archived?.has(x.sessionId) ? { archived: true as const } : {}),
    });
  }
  return { current: o.current, root: wirePath(o.root), sessions };
}

type Answer = [status: number, body: string];

/** A JSON POST route of the Sessions menu (key tier, auth.ts): `handle` answers; a throw is a 500 with its message. */
function postRoute(hub: EventHub, where: string, handle: (body: Record<string, unknown>) => Promise<Answer> | Answer): RequestListener {
  return (req, res) => {
    const answer = ([status, body]: Answer) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    if (req.method !== 'POST') return answer([405, 'method not allowed']);
    readJson(req).then(async (b) => answer(await handle((b ?? {}) as Record<string, unknown>))).catch((e: unknown) => {
      if (e instanceof SyntaxError) return answer([400, 'bad json']);
      reportError(hub, where, e);
      answer([500, e instanceof Error ? e.message : String(e)]);
    });
  };
}

const MAX_TITLE = 200;

/** POST /sessions/rename {id, title}: a title is one line of at most 200 characters. */
export function renameRoute(o: { hub: EventHub; rename: (id: string, title: string) => Promise<void> }): RequestListener {
  return postRoute(o.hub, 'sessions/rename', async ({ id, title }) => {
    const t = typeof title === 'string' ? title.trim() : '';
    // eslint-disable-next-line no-control-regex
    if (!isSessionId(id) || !t || t.length > MAX_TITLE || /[\x00-\x1f\x7f]/.test(t)) return [400, 'bad id or title'];
    await o.rename(id, t);
    return [200, 'ok'];
  });
}

/** POST /sessions/archive {id, archived}: hides or restores a session in the menu; the open one cannot be archived. */
export function archiveRoute(o: { hub: EventHub; current: () => string | null; set: (id: string, on: boolean) => void }): RequestListener {
  return postRoute(o.hub, 'sessions/archive', ({ id, archived }) => {
    if (!isSessionId(id) || typeof archived !== 'boolean') return [400, 'bad id or flag'];
    if (archived && id === o.current()) return [409, 'the open session cannot be archived'];
    o.set(id, archived);
    return [200, 'ok'];
  });
}

/**
 * POST /sessions/delete {id}: the agent deletes a stored session for good (`remove`; none: the agent cannot, 404). Never the
 * open session, nor any while a switch runs (its target may be the one asked for), nor one another live window has open.
 * Then `forget` drops Nota Bene's own data of it, also when the agent had it no more (404, nothing reported).
 */
export function deleteRoute(o: {
  hub: EventHub; current: () => string | null; switching: () => boolean; openElsewhere: (id: string) => Promise<boolean>;
  remove: ((id: string) => Promise<void>) | undefined; forget: (id: string) => void;
}): RequestListener {
  return postRoute(o.hub, 'sessions/delete', async ({ id }) => {
    if (!o.remove) return [404, 'this agent cannot delete sessions'];
    if (!isSessionId(id)) return [400, 'bad id'];
    if (id === o.current() || o.switching()) return [409, 'the open session cannot be deleted'];
    if (await o.openElsewhere(id)) return [409, 'the session is open in another window'];
    let gone = false;
    try {
      await o.remove(id);
    } catch (e) {
      if (!(e instanceof SessionNotFoundError)) throw e;
      gone = true;
    }
    o.forget(id);
    return gone ? [404, 'no such session'] : [200, 'ok'];
  });
}
