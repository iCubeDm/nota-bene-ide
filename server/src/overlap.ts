// Epic 383 2e (spec M7): two agents may work on one working tree. When both edit the same file in turns that overlap and
// the file still has uncommitted changes, each feed gets one line naming the file and the other agent. The server holds
// every agent, so it sees every edit and every turn; a file is the same file by its absolute path (another worktree is
// another path).
import path from 'node:path';
import type { AgentEvent } from '@nota-bene/shared';
import { git } from './git.ts';

/** Claude's writing tools; Codex's file change is `apply_patch`; an ACP agent's edit has toolKind `file` and a writing name */
const WRITES = /^(edit|multiedit|write|notebookedit|apply_patch|str_replace\w*|create|delete|move)$/i;

/** The files a main-thread tool call writes, absolute against the agent's folder; none for anything else. */
export function editedFiles(e: AgentEvent, cwd: string): string[] {
  if (e.t !== 'tool-call' || e.sub || !WRITES.test(e.name)) return [];
  const i = e.input;
  const named = [i.file_path, i.notebook_path, i.path, ...(Array.isArray(i.changes) ? i.changes.map((c) => (c as { path?: unknown } | null)?.path) : [])];
  return [...new Set(named.filter((p): p is string => typeof p === 'string' && p !== '').map((p) => path.resolve(cwd, p)))];
}

/** `agents`: the one that just edited the file, then the one that edited it before in an overlapping turn */
export type Overlap = { file: string; agents: [string, string] };

type Turn = { start: number; end: number | null; files: Set<string>; /** `<other agent>\n<file>` already said in this turn */ said: Set<string> };

/** Whether git has uncommitted changes of the file (one outside a repository counts as uncommitted). */
export async function uncommitted(file: string): Promise<boolean> {
  try {
    return (await git(path.dirname(file), ['status', '--porcelain', '--', path.basename(file)])).length > 0;
  } catch {
    return true;
  }
}

export function overlapWatch(o: { found: (x: Overlap) => void; dirty?: (file: string) => Promise<boolean>; now?: () => number }) {
  const now = o.now ?? Date.now;
  const dirty = o.dirty ?? uncommitted;
  // each agent's running turn and its last one: an edit overlaps a turn still running or one that ended after its own began
  const agents = new Map<string, { cur: Turn | null; last: Turn | null }>();
  const of = (id: string) => agents.get(id) ?? agents.set(id, { cur: null, last: null }).get(id)!;
  const open = (id: string): Turn => (of(id).cur ??= { start: now(), end: null, files: new Set(), said: new Set() });
  return {
    /** the agent's turn began (`true`) or ended */
    turn(id: string, running: boolean): void {
      const a = of(id);
      if (running) open(id);
      else if (a.cur) {
        a.cur.end = now();
        a.last = a.cur;
        a.cur = null;
      }
    },
    async event(id: string, cwd: string, e: AgentEvent): Promise<void> {
      const files = editedFiles(e, cwd);
      if (files.length === 0) return;
      const mine = open(id); // an edit outside a turn the server saw begin starts one
      for (const f of files) {
        mine.files.add(f);
        for (const [other, a] of agents) {
          if (other === id) continue;
          const theirs = [a.cur, a.last].find((t) => t && t.files.has(f) && (t.end === null || t.end >= mine.start));
          if (!theirs || mine.said.has(`${other}\n${f}`) || theirs.said.has(`${id}\n${f}`)) continue;
          mine.said.add(`${other}\n${f}`);
          theirs.said.add(`${id}\n${f}`);
          if (await dirty(f)) o.found({ file: f, agents: [id, other] });
        }
      }
    },
    /** a closed agent: its edits no longer warn */
    forget(id: string): void {
      agents.delete(id);
    },
  };
}
