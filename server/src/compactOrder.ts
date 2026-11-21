// A compaction ordered while the agent works (issue 499): it waits for the next pause, by the pending restart's rule
// (`busy` in server.ts), and needs no open page. Priority, always: restart > compact > messages. While a restart or a
// compaction is pending, or the ordered compaction runs, the user's sends are held here, not handed to the agent (the SDK
// would answer them in the running turn, with no pause between them); they go, in order, once neither is pending and
// the compaction's own turn is over. The order and the held sends are a small record per session,
// `<dir>/<sessionId>.json`: a restart that fires first (or a crash) does not lose them, and the start that resumes the
// session goes on with them; a switch leaves it in its file until the session is opened again.
import fs from 'node:fs';
import path from 'node:path';
import type { HeldSend } from '@nota-bene/shared';
import { writeJsonAtomic } from './atomicFile.ts';

const ID = /^[0-9A-Za-z_-]{1,100}$/;
/** while something is pending, held or the compaction runs, the server looks for a pause this often */
const EVERY_MS = 1_000;

/** a send as SessionManager.send takes it, with the time it was held */
export type HeldArgs = HeldSend & { lang?: string; detect?: true };
/** `compact`: the text the compaction runs with (`/compact`, or a typed one with its instructions), false for none */
type Record = { compact: string | false; held: HeldArgs[] };

export type CompactOrder = {
  /** a restart or a compaction is pending, the ordered compaction runs, or sends wait to go: a new send is held behind them */
  holding(): boolean;
  hold(m: HeldArgs): void;
  /** the compaction (`text`: `/compact` and its instructions) runs at the next pause, at once in one; ordering again while one is pending or running changes nothing */
  order(text: string): void;
  /** false when none was pending; the held sends go then (unless a restart is still pending) */
  cancel(): boolean;
  /** what the pages show (`compact-pending`) */
  view(): { pending: boolean; held: HeldSend[] };
  /** another session is current (a switch, the start): its own record, if any */
  enter(id: string | null): void;
  /** the current conversation got another id (its first, a /clear the CLI made): the record goes with it */
  moved(): void;
  /** a deleted session's record goes */
  forget(id: string): void;
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
  /** the user's /compact, with its instructions if any */
  compact: (text: string) => void;
  send: (m: Omit<HeldArgs, 'ts'>) => void;
  changed: () => void;
  report: (e: unknown) => void;
  everyMs?: number;
}): CompactOrder {
  let rec: Record = { compact: false, held: [] };
  let written: string | null = null; // the session whose file holds the record
  let ran = false; // the compaction went: the sends wait for its turn to end
  let timer: NodeJS.Timeout | null = null;

  const file = (id: string) => path.join(o.dir, `${id}.json`);
  const empty = () => rec.compact === false && rec.held.length === 0;
  const running = () => ran && o.busy();

  function save(): void {
    const id = o.session();
    const want = id && ID.test(id) && !empty() ? id : null;
    try {
      if (written && written !== want) fs.rmSync(file(written), { force: true });
      written = null;
      if (want) {
        fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
        writeJsonAtomic(file(want), rec, { mode: 0o600 });
        written = want;
      }
    } catch (e) {
      o.report(e); // the order still holds in memory; only a restart would lose it
    }
  }

  function arm(): void {
    if (empty() && !ran) {
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
    if (rec.compact !== false) {
      if (o.busy()) return;
      const text = rec.compact;
      rec.compact = false;
      ran = true;
      changed();
      o.compact(text);
      return;
    }
    if (running()) return;
    ran = false;
    if (rec.held.length === 0) return arm();
    const out = rec.held;
    rec.held = [];
    changed();
    for (const { ts: _, ...m } of out) {
      try { o.send(m); } catch (e) { o.report(e); } // one that fails must not take the others with it
    }
  }

  function read(id: string | null): Record {
    if (!id || !ID.test(id)) return { compact: false, held: [] };
    let r: Partial<{ compact: unknown; held: unknown }>;
    try {
      r = JSON.parse(fs.readFileSync(file(id), 'utf8')) as typeof r;
    } catch (e) {
      // none, or one that cannot be read: dropped rather than tried at every start
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') fs.rmSync(file(id), { force: true });
      return { compact: false, held: [] };
    }
    const held = Array.isArray(r.held) ? (r.held as HeldArgs[]).filter((m) => typeof m?.id === 'string' && typeof m.text === 'string') : [];
    return { compact: typeof r.compact === 'string' ? r.compact : false, held };
  }

  return {
    holding: () => o.restartPending() || !empty() || running(),
    hold(m) {
      rec.held.push(m);
      changed();
    },
    order(text) {
      if (rec.compact !== false || running()) return;
      rec.compact = text;
      changed();
      check();
    },
    cancel() {
      if (rec.compact === false) return false;
      rec.compact = false;
      changed();
      check();
      return true;
    },
    view: () => ({ pending: rec.compact !== false, held: rec.held }),
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
    forget(id) {
      if (!ID.test(id)) return;
      if (id === written) {
        rec = { compact: false, held: [] };
        written = null;
        arm();
        o.changed();
      }
      try { fs.rmSync(file(id), { force: true }); } catch (e) { o.report(e); }
    },
    check,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
