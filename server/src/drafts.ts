// The composer's draft of each session (issue 174): every client of a window shows it, the last write wins. One file per
// session, as comments: the servers of a provider share its folder, so one file of all drafts would need a merge on
// every write.
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_TYPES, type DraftImage } from '@nota-bene/shared';
import { writeJsonAtomic } from './atomicFile.ts';
import { SAFE_SESSION_ID } from './comments.ts';

export type Draft = { text: string; images: DraftImage[] };

/** a draft is written this long after its last change; a switch and the close write it at once */
export const DRAFT_DELAY_MS = 1000;

const EMPTY: Draft = { text: '', images: [] };
const empty = (d: Draft) => d.text === '' && d.images.length === 0;

/**
 * `<dir>/<sessionId>.json` `{v: 1, text, images}`; an empty draft has no file. A value not written yet is held in
 * memory; otherwise `get` reads the file, so another server of the same session is seen. The session without an id yet
 * (null) lives in memory only, until `adopt` or `dropPending`.
 */
export class DraftStore {
  private readonly dir: string;
  private readonly delayMs: number;
  private readonly report: (e: unknown) => void;
  private pending: Draft = EMPTY;
  private readonly unwritten = new Map<string, Draft>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `report`: a debounced write that failed (the value stays in memory, for the next write) */
  constructor(o: { dir: string; delayMs?: number; report?: (e: unknown) => void }) {
    this.dir = o.dir;
    this.delayMs = o.delayMs ?? DRAFT_DELAY_MS;
    this.report = o.report ?? (() => {});
  }

  get(sessionId: string | null): Draft {
    if (sessionId === null) return this.pending;
    return this.unwritten.get(sessionId) ?? read(this.file(sessionId));
  }

  set(sessionId: string | null, d: Draft): void {
    if (sessionId === null) return void (this.pending = d);
    this.file(sessionId); // an unsafe id is refused now, not at the write
    this.unwritten.set(sessionId, d);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try { this.flush(); } catch (e) { this.report(e); }
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** The id-less session got its id: its draft, if any, is that session's now. */
  adopt(sessionId: string): void {
    if (!empty(this.pending)) this.set(sessionId, this.pending);
    this.pending = EMPTY;
  }

  /** A switch away from the id-less session: its draft stays behind. */
  dropPending(): void {
    this.pending = EMPTY;
  }

  /** A deleted session: its draft goes. */
  forget(sessionId: string): void {
    this.unwritten.delete(sessionId);
    fs.rmSync(this.file(sessionId), { force: true });
  }

  /** Writes every value not written yet; one that fails stays in memory and the error is thrown. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const [id, d] of this.unwritten) {
      const f = this.file(id);
      if (empty(d)) fs.rmSync(f, { force: true });
      else {
        fs.mkdirSync(this.dir, { recursive: true });
        writeJsonAtomic(f, { v: 1, ...d }, { mode: 0o600 });
      }
      this.unwritten.delete(id);
    }
  }

  private file(sessionId: string): string {
    if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
    return path.join(this.dir, `${sessionId}.json`);
  }
}

/** A missing or unreadable file is no draft: a draft is the user's last words, not a record to protect. */
function read(file: string): Draft {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Record<keyof Draft, unknown>>;
    const images = Array.isArray(o.images) ? o.images.filter((i): i is DraftImage => typeof i?.id === 'string' && IMAGE_TYPES.includes(i.mediaType)) : [];
    return { text: typeof o.text === 'string' ? o.text : '', images };
  } catch {
    return EMPTY;
  }
}
