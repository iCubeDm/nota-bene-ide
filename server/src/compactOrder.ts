// A compaction ordered while the agent works (issue 499): it waits for the next pause, by the pending restart's rule
// (`busy` in server.ts), and needs no open page. Priority, always: restart > compact > messages. While a restart or a
// compaction is pending, the user's sends are held here, not handed to the agent (the SDK would answer them in the
// running turn, with no pause between them); they go, in order, once neither is pending and the compaction's own turn
// is over. The order and the held sends are a small record per session, `<dir>/<sessionId>.json`: a restart that fires
// first (or a crash) does not lose them, and the start that resumes the session goes on with them.
import fs from 'node:fs';
import path from 'node:path';
import type { HeldSend, ImageRef, Voice } from '@nota-bene/shared';

const ID = /^[0-9A-Za-z_-]{1,100}$/;
/** while something is pending or held, the server looks for a pause this often */
const EVERY_MS = 1_000;

/** a send as SessionManager.send takes it, with the time it was held */
export type HeldArgs = { id: string; text: string; ts: number; images?: ImageRef[]; voice?: Voice; lang?: string; detect?: true };
type Record = { compact: boolean; held: HeldArgs[] };

export type CompactOrder = {
  /** a restart or a compaction is pending, or sends wait to go: a new send is held behind them */
  holding(): boolean;
  hold(m: HeldArgs): void;
  /** the compaction runs at the next pause (at once in one); ordering again while pending changes nothing */
  order(): void;
  /** false when none was pending; the held sends go then (unless a restart is still pending) */
  cancel(): boolean;
  /** what the pages show (`compact-pending`) */
  view(): { pending: boolean; held: HeldSend[] };
  /** another session is current (a switch, the start): its own record, if any */
  enter(id: string | null): void;
  /** the current conversation got another id (its first, a /clear the CLI made): the record goes with it */
  moved(): void;
  /** look now (a pending restart went or was cancelled) */
  check(): void;
  stop(): void;
};

export function compactOrder(o: {
  dir: string;
  /** the id the current conversation's records go under (null: none yet) */
  session: () => string | null;
  /** not a pause (server.ts `notPaused`) */
  busy: () => boolean;
  switching: () => boolean;
  restartPending: () => boolean;
  /** the user's /compact */
  compact: () => void;
  send: (m: Omit<HeldArgs, 'ts'>) => void;
  changed: () => void;
  report: (e: unknown) => void;
  everyMs?: number;
}): CompactOrder {
  let rec: Record = { compact: false, held: [] };
  let written: string | null = null; // the session whose file holds the record
  let ran = false; // the compaction went: the held sends wait for its turn to end
  let timer: NodeJS.Timeout | null = null;

  const file = (id: string) => path.join(o.dir, `${id}.json`);
  const empty = () => !rec.compact && rec.held.length === 0;

  function save(): void {
    const id = o.session();
    const want = id && ID.test(id) && !empty() ? id : null;
    try {
      if (written && written !== want) fs.rmSync(file(written), { force: true });
      written = null;
      if (want) {
        fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
        const tmp = `${file(want)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
        fs.renameSync(tmp, file(want));
        written = want;
      }
    } catch (e) {
      o.report(e); // the order still holds in memory; only a restart would lose it
    }
  }

  function arm(): void {
    if (empty()) {
      if (timer) clearInterval(timer);
      timer = null;
      return;
    }
    if (timer) return;
    timer = setInterval(check, o.everyMs ?? EVERY_MS);
    timer.unref();
  }

  function changed(): void {
    save();
    arm();
    o.changed();
  }

  function check(): void {
    if (o.restartPending() || o.switching()) return; // the restart goes first; a switch is no pause
    if (rec.compact) {
      if (o.busy()) return;
      rec.compact = false;
      ran = true;
      changed();
      o.compact();
      return;
    }
    if (rec.held.length === 0 || (ran && o.busy())) return;
    ran = false;
    const out = rec.held;
    rec.held = [];
    changed();
    for (const { ts: _, ...m } of out) o.send(m);
  }

  function read(id: string | null): Record {
    if (!id || !ID.test(id)) return { compact: false, held: [] };
    try {
      const r = JSON.parse(fs.readFileSync(file(id), 'utf8')) as Partial<Record>;
      return { compact: r.compact === true, held: Array.isArray(r.held) ? r.held.filter((m) => typeof m?.id === 'string' && typeof m.text === 'string') : [] };
    } catch {
      return { compact: false, held: [] };
    }
  }

  return {
    holding: () => o.restartPending() || !empty(),
    hold(m) {
      rec.held.push(m);
      changed();
    },
    order() {
      if (rec.compact) return;
      rec.compact = true;
      changed();
      check();
    },
    cancel() {
      if (!rec.compact) return false;
      rec.compact = false;
      changed();
      check();
      return true;
    },
    view: () => ({
      pending: rec.compact,
      held: rec.held.map((m) => ({ id: m.id, text: m.text, ts: m.ts, ...(m.images?.length ? { images: m.images } : {}), ...(m.voice ? { voice: m.voice } : {}) })),
    }),
    enter(id) {
      // the record of the session left stays in its file, for when it is opened again
      const was = !empty();
      rec = read(id);
      written = empty() ? null : id;
      ran = false;
      arm();
      if (was || !empty()) o.changed();
      check();
    },
    moved: () => { if (!empty()) save(); }, // save() writes under the new id and removes the old file
    check,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
