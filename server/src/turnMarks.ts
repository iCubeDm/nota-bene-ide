// "A turn was cut" across a restart (gh-422). While the agent works (a turn, a waiting question or approval, a running
// task of the agent) the server keeps a mark `<dir>/<sessionId>`; when the work ends it removes it. A server that exits
// in a pause leaves none; a forced restart, a stop during a turn or a crash leaves it, and the next start that resumes
// that session reads it (take) and shows "The server restarted during a turn". A file per session, written at the
// start of the work, not at the exit: a crash runs no exit code.
import fs from 'node:fs';
import path from 'node:path';

const ID = /^[0-9A-Za-z_-]{1,100}$/;
/** how long after the last event the work state is looked at again (tasksRunning reads the whole history) */
const SETTLE_MS = 300;

export class TurnMarks {
  private written: string | null = null;
  private frozen = false;
  private timer: NodeJS.Timeout | null = null;

  private o: { dir: string; working: () => boolean; session: () => string | null };
  constructor(o: { dir: string; working: () => boolean; session: () => string | null }) {
    this.o = o;
  }

  private file(id: string): string | null {
    return ID.test(id) ? path.join(this.o.dir, id) : null;
  }

  /** a mark an earlier process left for `id`: read once (removed), so a later resume does not say it again */
  take(id: string): boolean {
    const f = this.file(id);
    if (!f) return false;
    try {
      fs.unlinkSync(f);
      return true;
    } catch {
      return false;
    }
  }

  /** look at the work state now: write the mark of the current session while it works, remove ours when it ends */
  check(): void {
    if (this.frozen) return;
    const id = this.o.session();
    const want = this.o.working() && id !== null && this.file(id) ? id : null;
    if (want === this.written) return;
    if (this.written) {
      try { fs.unlinkSync(this.file(this.written)!); } catch { /* gone already */ }
    }
    this.written = null;
    if (want) {
      try {
        fs.mkdirSync(this.o.dir, { recursive: true });
        fs.writeFileSync(this.file(want)!, JSON.stringify({ at: Date.now(), pid: process.pid }));
        this.written = want;
      } catch { /* best effort: no note after a crash */ }
    }
  }

  /** check soon (after a burst of events settles) */
  schedule(): void {
    if (this.frozen || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.check(); }, SETTLE_MS);
    this.timer.unref();
  }

  /** the server is going down: what it is doing now stays marked (the close itself ends turns and must not remove it) */
  freeze(): void {
    this.check();
    this.frozen = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
