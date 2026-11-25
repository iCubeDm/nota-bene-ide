import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const SAFE_ID = /^[\w-]{1,100}$/;
/** the CLI cuts a longer folder name and appends a hash of the path: such a cwd is found by the scan */
const FOLDER_MAX = 200;

/** A record's ISO `timestamp` as epoch ms; 0 when it has none or it does not parse. */
export const recordTime = (v: unknown): number => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};

/** The CLI's (and SDK's) folder under `projects/` for a cwd: every character but a letter or digit becomes `-`. */
export const projectFolder = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

// A record is written `{…,"message":…,"uuid":"…","timestamp":"…",…}`. Inside a JSON string a quote is escaped, so an
// unescaped `"uuid":"…","timestamp":"…"` pair is a key pair of some object: one such pair on the line is the record's
// own; none or several (a nested object with the same keys) and the line is parsed whole.
const PAIR = /[{,]"uuid":"([^"\\]+)","timestamp":"([^"\\]+)"/g;

function lineTime(l: string): [string, number] | null {
  if (!l.includes('"timestamp"')) return null;
  const pairs = [...l.matchAll(PAIR)];
  if (pairs.length === 1) {
    const ms = recordTime(pairs[0]![2]);
    return ms ? [pairs[0]![1]!, ms] : null;
  }
  try {
    const r = JSON.parse(l) as { uuid?: unknown; timestamp?: unknown };
    const ms = recordTime(r.timestamp);
    return typeof r.uuid === 'string' && ms ? [r.uuid, ms] : null;
  } catch { return null; } // a torn or foreign line: no time for it
}

/** Reads `file` line by line from byte `from` (a transcript can be gigabytes); null when it cannot be opened. */
async function readTimes(file: string, from = 0): Promise<Map<string, number> | null> {
  let fd: fs.promises.FileHandle;
  try { fd = await fs.promises.open(file, 'r'); } catch { return null; }
  const times = new Map<string, number>();
  const lines = readline.createInterface({ input: fd.createReadStream({ encoding: 'utf8', start: from }), crlfDelay: Infinity });
  try {
    for await (const l of lines) {
      const hit = lineTime(l);
      if (hit) times.set(hit[0], hit[1]);
    }
  } catch { /* a read error, or a line too long for a string: the times so far */ } finally {
    lines.close();
    await fd.close().catch(() => {});
  }
  return times;
}

/** The folders that may hold the session: the cwd's own (as given and resolved), then every project folder. */
async function* folders(projectsDir: string, cwd: string | undefined): AsyncGenerator<string> {
  const tried = new Set<string>();
  if (cwd) {
    let real = cwd;
    try { real = await fs.promises.realpath(cwd); } catch { /* gone: the path as given */ }
    for (const c of [cwd, real]) {
      const f = projectFolder(c);
      if (f.length <= FOLDER_MAX && !tried.has(f)) { tried.add(f); yield f; }
    }
  }
  let all: string[];
  try { all = await fs.promises.readdir(projectsDir); } catch { return; }
  for (const f of all) if (!tried.has(f)) yield f;
}

/**
 * Past V8's string limit (~512 MiB) the SDK's `getSessionMessages` stalls the event loop for minutes and takes gigabytes
 * (issue 669: 6 GB and 90 s+ on a 2.1 GB transcript), freezing every agent of the server. It gets only the part since
 * the last compaction (tail.ts); this caps that part.
 */
export const HISTORY_MAX_BYTES = 512 * 2 ** 20;

/** The session's transcript: the cwd's folder when it holds it, else any project's; null when none does. */
export async function transcriptFile(projectsDir: string, sessionId: string, cwd?: string): Promise<string | null> {
  if (!SAFE_ID.test(sessionId)) return null;
  for await (const f of folders(projectsDir, cwd)) {
    const file = path.join(projectsDir, f, `${sessionId}.jsonl`);
    try { if ((await fs.promises.stat(file)).isFile()) return file; } catch { /* not in this folder */ }
  }
  return null;
}

/** The record times of `file` from byte `from` on (see transcriptTimes). */
export async function fileTimes(file: string, from = 0): Promise<Map<string, number>> {
  return (await readTimes(file, from)) ?? new Map();
}

/**
 * When each record of a subagent's transcript was written, by its uuid. The SDK's `SessionMessage` drops the CLI's
 * `timestamp`, so a replay reads it from the file itself: `<projects>/<folder>/<sessionId>/subagents/agent-<agentId>.jsonl`
 * (the session's own times come from `fileTimes`). The folder is the cwd's when it holds the file, else any (a session
 * id is unique). A missing or unreadable file, or a line that does not parse, gives no times: those events stay at 0
 * (no time shown).
 */
export async function transcriptTimes(projectsDir: string, sessionId: string, o: { agentId: string; cwd?: string }): Promise<Map<string, number>> {
  if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(o.agentId)) return new Map();
  const rel = path.join(sessionId, 'subagents', `agent-${o.agentId}.jsonl`);
  for await (const f of folders(projectsDir, o.cwd)) {
    const times = await readTimes(path.join(projectsDir, f, rel));
    if (times) return times;
  }
  return new Map();
}
