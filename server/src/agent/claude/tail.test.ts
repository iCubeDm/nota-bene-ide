import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { replayStart, tailStore } from './tail.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const write = (records: object[], raw = ''): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-tail-'));
  dirs.push(d);
  const file = path.join(d, 's1.jsonl');
  fs.writeFileSync(file, raw + records.map((r) => JSON.stringify(r) + '\n').join(''));
  return file;
};
const offsetOf = (file: string, uuid: string): number => {
  const text = fs.readFileSync(file, 'utf8');
  return Buffer.byteLength(text.slice(0, text.lastIndexOf('\n', text.indexOf(`"uuid":"${uuid}"`)) + 1));
};

const at = (n: number) => `2026-11-20T10:00:${String(n).padStart(2, '0')}.000Z`;
const SID = '00000000-0000-4000-8000-000000000001'; // the SDK reads a session by a uuid only
const base = { sessionId: SID, isSidechain: false, cwd: '/proj', userType: 'external' };
const user = (uuid: string, parentUuid: string | null, content: string, n: number, extra: object = {}) =>
  ({ ...base, type: 'user', uuid, parentUuid, timestamp: at(n), message: { role: 'user', content }, ...extra });
const assistant = (uuid: string, parentUuid: string, text: string, n: number) =>
  ({ ...base, type: 'assistant', uuid, parentUuid, timestamp: at(n), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const boundary = (uuid: string, tail: string, preserved?: { head: string; anchor: string; uuids: string[] }, n = 30) => ({
  ...base, type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid: tail, timestamp: at(n),
  content: 'Conversation compacted',
  compactMetadata: {
    trigger: 'manual',
    ...(preserved ? {
      preservedSegment: { headUuid: preserved.head, anchorUuid: preserved.anchor, tailUuid: tail },
      preservedMessages: { anchorUuid: preserved.anchor, uuids: preserved.uuids },
    } : {}),
  },
});

/** Two compactions; the last keeps the turn before it (p1, p2), which the SDK splices after the summary. */
const session = () => [
  user('u0', null, 'first question', 1),
  assistant('a0', 'u0', 'first answer', 2),
  boundary('b0', 'a0', undefined, 3),
  user('s0', 'b0', 'summary one', 4, { isCompactSummary: true }),
  user('u1', 's0', 'second question', 5),
  assistant('p1', 'u1', 'kept answer', 6),
  assistant('p2', 'p1', 'kept "compact_boundary" mention', 7),
  boundary('b1', 'p2', { head: 'p1', anchor: 's1x', uuids: ['p1', 'p2'] }),
  user('s1x', 'b1', 'summary two', 31, { isCompactSummary: true }),
  user('u2', 's1x', 'third question', 32),
  assistant('a2', 'u2', 'third answer', 33),
];

describe('replayStart', () => {
  it('no compaction: the whole file', async () => {
    expect(await replayStart(write([user('u0', null, 'q', 1), assistant('a0', 'u0', 'a', 2)]))).toBe(0);
  });

  it('the last boundary, or the earliest message it preserved', async () => {
    const plain = write(session().filter((r) => r.uuid !== 'b1').concat([boundary('b9', 'a2', undefined, 40)]));
    expect(await replayStart(plain)).toBe(offsetOf(plain, 'b9'));
    const kept = write(session());
    expect(await replayStart(kept)).toBe(offsetOf(kept, 'p1'));
  });

  it('a boundary quoted in a message, a torn line or a preserved id not in the file is no start', async () => {
    const quoted = { ...assistant('q1', 'a0', 'x', 9), extra: { subtype: 'compact_boundary' } }; // unescaped, not a system record
    const file = write([user('u0', null, 'q', 1), assistant('a0', 'u0', 'a', 2), boundary('b0', 'a0', { head: 'gone', anchor: 's0', uuids: ['gone'] }), quoted], '{"torn":');
    expect(await replayStart(file)).toBe(offsetOf(file, 'b0'));
    expect(await replayStart(write([quoted]))).toBe(0);
  });

  it('a missing file: the whole file (the SDK reports it)', async () => {
    expect(await replayStart(path.join(os.tmpdir(), 'nb-tail-none', 'x.jsonl'))).toBe(0);
  });
});

describe('tailStore', () => {
  it('replays the same conversation as the whole transcript, from its start only', async () => {
    const file = write(session());
    const from = await replayStart(file);
    const whole = await getSessionMessages(SID, { sessionStore: tailStore(file, 0) });
    const tail = await getSessionMessages(SID, { sessionStore: tailStore(file, from) });
    expect(tail.map((m) => m.uuid)).toContain('p1');
    expect(tail).toEqual(whole);
  });

  it('skips a torn line', async () => {
    const file = write([user('u0', null, 'q', 1)], 'not json\n');
    expect(await tailStore(file, 0).load({ projectKey: 'p', sessionId: SID })).toEqual([user('u0', null, 'q', 1)]);
  });
});
