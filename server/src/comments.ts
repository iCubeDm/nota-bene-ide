import fs from 'node:fs';
import path from 'node:path';
import type { Comment, CommentOp, CommentRefusal } from '@nota-bene/shared';
import { renameRetry } from './platform.ts';

/** a session id that is safe as a file name (the fake backend's ids are no UUIDs) */
export const SAFE_SESSION_ID = /^[0-9a-zA-Z-]{1,100}$/;

function fileFor(dir: string, sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  return path.join(dir, `${sessionId}.json`);
}
/** the v2 file (protocol 19) beside the legacy one, which stays as it was so a downgraded server still reads its set */
const v2For = (dir: string, sessionId: string) => fileFor(dir, sessionId).replace(/\.json$/, '.v2.json');

/** at most this many deleted ids are kept per session: removal is rare and ids are UUIDs */
export const TOMBSTONES = 500;

/** A session's set as stored: `rev` grows with every change, `removed` are the deleted ids (an add cannot bring one back). */
export type CommentState = { rev: number; items: Comment[]; removed: string[] };
export type OpRefusal = { reason: CommentRefusal; id: string };

const isComments = (v: unknown): v is Comment[] => Array.isArray(v);
const valid = (data: unknown[]): Comment[] =>
  data.filter((c): c is Comment => typeof c === 'object' && c !== null && typeof (c as { id?: unknown }).id === 'string');

/** Per-session comment sets, one JSON file per session. The not-yet-identified session (null) lives in memory only. */
export class CommentStore {
  private readonly dir: string;
  private pending: CommentState = { rev: 0, items: [], removed: [] };

  constructor(o: { dir: string }) {
    this.dir = o.dir;
  }

  /** A deleted session: its comments go (none is fine). */
  forget(sessionId: string): void {
    fs.rmSync(v2For(this.dir, sessionId), { force: true });
    fs.rmSync(fileFor(this.dir, sessionId), { force: true });
  }

  get(sessionId: string | null): Comment[] {
    return this.state(sessionId).items;
  }

  /** The set with its revision and deleted ids: the v2 file, else the legacy array (rev 0), else nothing. */
  state(sessionId: string | null): CommentState {
    if (sessionId === null) return { ...this.pending, items: [...this.pending.items], removed: [...this.pending.removed] };
    const v2 = read(v2For(this.dir, sessionId));
    if (v2 !== undefined) {
      const o = (typeof v2 === 'object' && v2 !== null ? v2 : {}) as Partial<Record<keyof CommentState, unknown>>;
      return {
        rev: typeof o.rev === 'number' && Number.isFinite(o.rev) ? o.rev : 0,
        items: isComments(o.items) ? valid(o.items) : [],
        removed: Array.isArray(o.removed) ? o.removed.filter((x): x is string => typeof x === 'string') : [],
      };
    }
    const v1 = read(fileFor(this.dir, sessionId));
    return { rev: 0, items: isComments(v1) ? valid(v1) : [], removed: [] };
  }

  set(sessionId: string | null, items: Comment[]): void {
    this.write(sessionId, items, this.state(sessionId).removed);
  }

  /** A switch away from the id-less session: its unsent set, and what it deleted, stay behind. */
  dropPending(): void {
    this.pending = { rev: next(this.pending.rev), items: [], removed: [] };
  }

  /** Moves the in-memory set under the real id (no-op when there is nothing to move). */
  adopt(sessionId: string): void {
    fileFor(this.dir, sessionId);
    if (this.pending.items.length === 0 && this.pending.removed.length === 0) return;
    // merge by id; on conflict the sent copy wins, otherwise the stored entry (resumed session already has it)
    const stored = this.state(sessionId);
    const mem = new Map(this.pending.items.map((c) => [c.id, c]));
    const merged = stored.items.map((c) => {
      const m = mem.get(c.id);
      return m && m.status === 'sent' && c.status !== 'sent' ? m : c;
    });
    const have = new Set(stored.items.map((c) => c.id));
    this.write(sessionId, [...merged, ...this.pending.items.filter((c) => !have.has(c.id))], [...stored.removed, ...this.pending.removed]);
    this.pending = { rev: 0, items: [], removed: [] };
  }

  /**
   * Stores a full set sent by a client (before protocol 19). Sent comments are server-owned: a stale or racing client cannot
   * turn one back to pending (its copy is replaced by the stored one) or drop it (the UI has no delete for
   * sent comments, so a missing one is re-appended). A deleted id in the set stays deleted; a pending comment the set
   * leaves out counts as deleted. Returns the set as stored.
   */
  merge(sessionId: string | null, incoming: Comment[]): Comment[] {
    const st = this.state(sessionId);
    const gone = new Set(st.removed);
    const sent = new Map(st.items.filter((c) => c.status === 'sent').map((c) => [c.id, c]));
    const next = incoming.filter((c) => !gone.has(c.id)).map((c) => sent.get(c.id) ?? c);
    const seen = new Set(incoming.map((c) => c.id));
    for (const [id, c] of sent) if (!seen.has(id)) next.push(c);
    const dropped = st.items.filter((c) => c.status === 'pending' && !seen.has(c.id)).map((c) => c.id);
    this.write(sessionId, next, [...st.removed, ...dropped]);
    return [...next];
  }

  /**
   * Applies a client's ops (protocol 19), all or none. An add of a stored id changes nothing (a resent op), of a deleted
   * one is refused `gone` unless it is a `restore`; it goes before `before` when that is stored; an edit replaces the comment's text, label, images, recordings and generated-image count, and is
   * refused `gone` for a missing comment and `sent` for a sent one; a remove leaves the id deleted, is a no-op for a
   * missing one and is refused `sent` for a sent one. Returns the refusal, or null when the set is stored.
   */
  apply(sessionId: string | null, ops: CommentOp[]): OpRefusal | null {
    const st = this.state(sessionId);
    const items = [...st.items];
    const removed = [...st.removed];
    for (const o of ops) {
      const id = o.op === 'remove' ? o.id : o.comment.id;
      const at = items.findIndex((c) => c.id === id);
      const cur = items[at];
      if (o.op === 'add') {
        if (cur) continue;
        const dead = removed.indexOf(id);
        if (dead >= 0 && !o.restore) return { reason: 'gone', id };
        if (dead >= 0) removed.splice(dead, 1);
        // a new comment is pending whatever the client says: only a send makes one sent
        const { sentIn: _sentIn, ...fresh } = o.comment;
        const next = o.before === undefined ? -1 : items.findIndex((c) => c.id === o.before);
        items.splice(next < 0 ? items.length : next, 0, { ...fresh, status: 'pending' });
      } else if (o.op === 'edit') {
        if (!cur) return { reason: 'gone', id };
        if (cur.status === 'sent') return { reason: 'sent', id };
        const { text, label, images, voice, genImages } = o.comment;
        const { label: _l, images: _i, voice: _v, genImages: _g, ...base } = cur;
        items[at] = { ...base, text, ...(label === undefined ? {} : { label }), ...(images === undefined ? {} : { images }),
          ...(voice === undefined ? {} : { voice }), ...(genImages === undefined ? {} : { genImages }) };
      } else {
        if (cur?.status === 'sent') return { reason: 'sent', id };
        if (cur) items.splice(at, 1);
        if (!removed.includes(id)) removed.push(id);
      }
    }
    this.write(sessionId, items, removed);
    return null;
  }

  private write(sessionId: string | null, items: Comment[], removed: string[]): void {
    const st: CommentState = { rev: next(this.state(sessionId).rev), items: [...items], removed: [...new Set(removed)].slice(-TOMBSTONES) };
    if (sessionId === null) {
      this.pending = st;
      return;
    }
    const file = v2For(this.dir, sessionId);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, ...st }, null, 2));
    renameRetry(tmp, file);
  }

  /** Marks the given comments as sent in `sentIn`; returns the full updated set. */
  markSent(sessionId: string | null, ids: string[], sentIn: string): Comment[] {
    const want = new Set(ids);
    const next = this.get(sessionId).map((c): Comment => (want.has(c.id) ? { ...c, status: 'sent', sentIn } : c));
    this.set(sessionId, next);
    return [...next];
  }

  /** The send [sentIn] never reached the agent (a voice message without a transcript): its comments are pending again. */
  markPending(sessionId: string | null, sentIn: string): Comment[] {
    const next = this.get(sessionId).map((c): Comment => {
      if (c.sentIn !== sentIn) return c;
      const { sentIn: _gone, ...rest } = c;
      return { ...rest, status: 'pending' };
    });
    this.set(sessionId, next);
    return [...next];
  }
}

/** The next revision: one more, or the clock when it is ahead, so a revision also grows across restarts and sessions. */
const next = (rev: number): number => Math.max(rev + 1, Date.now());

/** The parsed file; undefined when there is none. Only a missing file is "none": EACCES/EIO must not look empty (the next
 * write would overwrite the real file). A file that is not JSON reads as null. */
function read(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
