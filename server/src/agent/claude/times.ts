import fs from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[\w-]{1,100}$/;

/** A record's ISO `timestamp` as epoch ms; 0 when it has none or it does not parse. */
export const recordTime = (v: unknown): number => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};

/**
 * When each record of a Claude transcript was written, by its uuid. The SDK's `SessionMessage` drops the CLI's
 * `timestamp`, so a replay reads it from the file itself: `<projects>/<folder>/<sessionId>.jsonl`, or with `agentId`
 * a subagent's `<sessionId>/subagents/agent-<agentId>.jsonl`. Any folder may hold it (a session id is unique). A
 * missing or unreadable file, or a line that does not parse, gives no times: those events stay at 0 (no time shown).
 */
export async function transcriptTimes(projectsDir: string, sessionId: string, agentId?: string): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  if (!SAFE_ID.test(sessionId) || (agentId !== undefined && !SAFE_ID.test(agentId))) return times;
  const rel = agentId === undefined ? `${sessionId}.jsonl` : path.join(sessionId, 'subagents', `agent-${agentId}.jsonl`);
  let folders: string[];
  try { folders = await fs.promises.readdir(projectsDir); } catch { return times; }
  for (const f of folders) {
    let text: string;
    try { text = await fs.promises.readFile(path.join(projectsDir, f, rel), 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) {
      if (!l.includes('"timestamp"')) continue;
      try {
        const r = JSON.parse(l) as { uuid?: unknown; timestamp?: unknown };
        const ms = recordTime(r.timestamp);
        if (typeof r.uuid === 'string' && ms) times.set(r.uuid, ms);
      } catch { /* a torn or foreign line: no time for it */ }
    }
    break;
  }
  return times;
}
