// The feed replays a session from its last compaction (issue 671). The CLI's transcript keeps every compacted part (one
// was 2.1 GB, 4.5 MB of it after the last of 202 compactions), and the SDK's `getSessionMessages` reads it all to return
// that tail. It is handed the tail instead, as a session store; the CLI's file is only read.
import fs from 'node:fs';
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';

const CHUNK = 1 << 20;
const NL = 10;
const BOUNDARY = Buffer.from('"subtype":"compact_boundary"');

async function lineStart(fd: fs.promises.FileHandle, at: number): Promise<number> {
  for (let p = at; p > 0;) {
    const len = Math.min(CHUNK, p);
    const c = Buffer.alloc(len);
    await fd.read(c, 0, len, p - len);
    const nl = c.lastIndexOf(NL);
    if (nl !== -1) return p - len + nl + 1;
    p -= len;
  }
  return 0;
}

/** The start of the line holding the last `needle` before `before`, scanning back; -1 when there is none. */
async function lastLine(fd: fs.promises.FileHandle, needle: Buffer, before: number): Promise<number> {
  for (let end = before; end > 0;) {
    const start = Math.max(0, end - CHUNK);
    const buf = Buffer.alloc(end - start + needle.length - 1); // a needle across the chunk's end
    const n = (await fd.read(buf, 0, buf.length, start)).bytesRead;
    const i = buf.subarray(0, n).lastIndexOf(needle);
    if (i !== -1) return lineStart(fd, start + i);
    end = start;
  }
  return -1;
}

async function lineAt(fd: fs.promises.FileHandle, from: number): Promise<string> {
  const parts: Buffer[] = [];
  for (let q = from; ;) {
    const c = Buffer.alloc(CHUNK);
    const n = (await fd.read(c, 0, CHUNK, q)).bytesRead;
    if (!n) break;
    const nl = c.subarray(0, n).indexOf(NL);
    if (nl !== -1) { parts.push(c.subarray(0, nl)); break; }
    parts.push(c.subarray(0, n));
    q += n;
  }
  return Buffer.concat(parts).toString('utf8');
}

type Boundary = { type?: unknown; subtype?: unknown; compactMetadata?: { preservedSegment?: { headUuid?: unknown }; preservedMessages?: { uuids?: unknown } } };

/**
 * Where the replay starts: the line of the last compaction's boundary, or of the earliest message that compaction kept
 * (the SDK splices them in after the summary); 0 with no compaction or no readable file. A kept id the file does not
 * hold is skipped, as the SDK skips it. Read backwards, so the cost is the tail's, not the file's.
 */
export async function replayStart(file: string): Promise<number> {
  let fd: fs.promises.FileHandle;
  try { fd = await fs.promises.open(file, 'r'); } catch { return 0; }
  try {
    for (let before = (await fd.stat()).size; ;) {
      const at = await lastLine(fd, BOUNDARY, before);
      if (at === -1) return 0;
      let r: Boundary | null = null;
      try { r = JSON.parse(await lineAt(fd, at)) as Boundary; } catch { /* torn: not a boundary */ }
      if (r?.type !== 'system' || r.subtype !== 'compact_boundary') { before = at; continue; } // the words in some record
      const m = r.compactMetadata;
      const kept = [m?.preservedSegment?.headUuid, ...(Array.isArray(m?.preservedMessages?.uuids) ? m.preservedMessages.uuids : [])];
      let start = at;
      for (const id of new Set(kept)) {
        if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) continue;
        const p = await lastLine(fd, Buffer.from(`"uuid":"${id}"`), at);
        if (p !== -1) start = Math.min(start, p);
      }
      return start;
    }
  } finally {
    await fd.close().catch(() => {});
  }
}

/** The transcript from `from` as the SDK's session store, for `getSessionMessages` alone (nothing is appended). */
export function tailStore(file: string, from: number): SessionStore {
  return {
    append: async () => {},
    load: async () => {
      const fd = await fs.promises.open(file, 'r');
      let text: string;
      try {
        const buf = Buffer.alloc(Math.max(0, (await fd.stat()).size - from));
        const n = (await fd.read(buf, 0, buf.length, from)).bytesRead;
        text = buf.subarray(0, n).toString('utf8');
      } finally {
        await fd.close().catch(() => {});
      }
      const out: { type: string }[] = [];
      for (const l of text.split('\n')) {
        if (!l) continue;
        try { out.push(JSON.parse(l) as { type: string }); } catch { /* a torn line: the SDK skips it too */ }
      }
      return out;
    },
  };
}
