import fs from 'node:fs';
import type { RequestListener, ServerResponse } from 'node:http';
import path from 'node:path';
import { PROMPT_MAX, PROMPT_SRCS, type PromptEntry, type PromptSrc } from '@nota-bene/shared';
import { readCapped, refuseTooLarge } from './attachments.ts';
import { SAFE_SESSION_ID } from './comments.ts';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';

/** what GET answers: the newest of a long history */
const LIST_CAP = 1000;
/** a 32000-char prompt escaped as JSON can reach ~6 bytes a char: the body cap leaves room for that */
const BODY_CAP = PROMPT_MAX * 6 + 1024;

function fileFor(dir: string, sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  return path.join(dir, `${sessionId}.jsonl`);
}

function parse(line: string): PromptEntry | null {
  try {
    const v = JSON.parse(line) as Partial<PromptEntry> | null;
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !v.id || typeof v.text !== 'string' || !v.text) return null;
    if (typeof v.ts !== 'number' || !PROMPT_SRCS.includes(v.src as PromptSrc)) return null;
    return { id: v.id, ts: v.ts, text: v.text, src: v.src as PromptSrc };
  } catch {
    return null;
  }
}

/**
 * The prompts a window sent, per session: `<dir>/<sessionId>.jsonl`, one `{v:1,id,ts,text,src}` line each, append-only.
 * They cannot be rebuilt from the transcript (comment batches, `! cmd` and command tags are rewritten there), so the
 * web client reports each one once the server has taken it. The not-yet-identified session (null) lives in memory.
 * A line that does not parse is skipped and reported once per session.
 */
export class PromptStore {
  private readonly dir: string;
  private readonly report: (e: Error) => void;
  private readonly reported = new Set<string>();
  private pending: PromptEntry[] = [];

  constructor(o: { dir: string; report?: (e: Error) => void }) {
    this.dir = o.dir;
    this.report = o.report ?? (() => {});
  }

  /** a repeat of a stored id is ignored (a retry, or the same send seen by two tabs) */
  append(sessionId: string | null, e: PromptEntry): void {
    if (sessionId === null) {
      if (!this.pending.some((x) => x.id === e.id)) this.pending.push(e);
      return;
    }
    const { entries, torn } = this.read(sessionId);
    if (entries.some((x) => x.id === e.id)) return;
    this.write(sessionId, [e], torn);
  }

  list(sessionId: string | null): PromptEntry[] {
    if (sessionId === null) return [...this.pending];
    return this.read(sessionId).entries.slice(-LIST_CAP);
  }

  /** Moves the in-memory prompts under the real id (merged by id; the stored ones stay). */
  adopt(sessionId: string): void {
    fileFor(this.dir, sessionId);
    if (this.pending.length === 0) return;
    const { entries, torn } = this.read(sessionId);
    const have = new Set(entries.map((x) => x.id));
    const fresh = this.pending.filter((x) => !have.has(x.id));
    if (fresh.length) this.write(sessionId, fresh, torn);
    this.pending = [];
  }

  /** The history follows a /clear or a fork: copies `from`'s file to `to` unless `to` already has one. */
  carry(from: string, to: string): void {
    const src = fileFor(this.dir, from);
    const dst = fileFor(this.dir, to);
    if (from === to || fs.existsSync(dst)) return;
    try {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EEXIST') throw e;
    }
  }

  /** The in-memory ones of a session that never got an id: another session must not adopt them. */
  dropPending(): void {
    this.pending = [];
  }

  private write(sessionId: string, items: PromptEntry[], torn: boolean): void {
    const file = fileFor(this.dir, sessionId);
    fs.mkdirSync(this.dir, { recursive: true });
    // a torn last line (a crash mid-write) must not swallow the next entry
    fs.appendFileSync(file, (torn ? '\n' : '') + items.map((x) => `${JSON.stringify({ v: 1, ...x })}\n`).join(''));
  }

  private read(sessionId: string): { entries: PromptEntry[]; torn: boolean } {
    const file = fileFor(this.dir, sessionId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      // only a missing file is "no prompts"; EACCES/EIO must not look empty
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], torn: false };
      throw e;
    }
    const entries: PromptEntry[] = [];
    let bad = 0;
    for (const l of raw.split('\n')) {
      if (l.trim() === '') continue;
      const v = parse(l);
      if (v) entries.push(v);
      else bad++;
    }
    if (bad && !this.reported.has(sessionId)) {
      this.reported.add(sessionId);
      this.report(new Error(`prompts/${sessionId}.jsonl: ${bad} corrupt line(s) skipped`));
    }
    return { entries, torn: raw.length > 0 && !raw.endsWith('\n') };
  }
}

function plain(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * `/prompts`, key tier like every route (HTTP only, no protocol bump).
 * GET `?session=<id>`: `{session, prompts}` of the current conversation (the in-memory ones while it has no id yet), 409 when
 * `session` is not the current one (a page from before a switch). POST `{session|null, id, text, src}`: null = the current
 * conversation (in memory when it has no id), another valid id is written there (a switch was in flight). 204 / 400.
 */
export function promptRoutes(o: { store: PromptStore; current: () => string | null; hub: EventHub }): Record<string, RequestListener> {
  const fail = (res: ServerResponse, e: unknown) => {
    reportError(o.hub, 'prompts', e);
    if (!res.headersSent) plain(res, 500, 'internal error');
    else res.destroy();
  };
  return {
    '/prompts': (req, res) => {
      if (req.method === 'GET') {
        const session = new URL(req.url ?? '/', 'http://x').searchParams.get('session');
        const cur = o.current();
        if (session !== null && !SAFE_SESSION_ID.test(session)) return plain(res, 400, 'bad request');
        if (session !== null && session !== cur) return plain(res, 409, 'not the current session');
        try {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ session: cur, prompts: o.store.list(cur) }));
        } catch (e) {
          fail(res, e);
        }
        return;
      }
      if (req.method !== 'POST') return plain(res, 405, 'method not allowed', { allow: 'GET, POST' });
      void (async () => {
        try {
          const raw = await readCapped(req, BODY_CAP);
          if (raw === null) return refuseTooLarge(req, res, 'prompt too large');
          let b: Record<string, unknown>;
          try {
            const v: unknown = JSON.parse(raw.toString('utf8'));
            if (!v || typeof v !== 'object' || Array.isArray(v)) return plain(res, 400, 'bad request');
            b = v as Record<string, unknown>;
          } catch {
            return plain(res, 400, 'bad request');
          }
          const { session, id, text, src } = b;
          const ok = (session === null || (typeof session === 'string' && SAFE_SESSION_ID.test(session)))
            && typeof id === 'string' && id.length > 0 && id.length <= 100
            && typeof text === 'string' && text.length > 0 && text.length <= PROMPT_MAX
            && PROMPT_SRCS.includes(src as PromptSrc);
          if (!ok) return plain(res, 400, 'bad request');
          o.store.append(session === null ? o.current() : (session as string), { id, ts: Date.now(), text, src: src as PromptSrc });
          res.writeHead(204);
          res.end();
        } catch (e) {
          fail(res, e);
        }
      })();
    },
  };
}
