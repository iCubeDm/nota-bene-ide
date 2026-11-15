import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { markSeen, readSeen, SEEN_MAX } from './seen.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-seen-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('a missing or corrupt file is nothing seen', () => {
  expect(readSeen(dir)).toEqual({});
  fs.writeFileSync(path.join(dir, 'seen-sessions.json'), '{oops');
  expect(readSeen(dir)).toEqual({});
});

it('marks keep only a later time, per session', () => {
  markSeen(A, 100, dir);
  markSeen(B, 50, dir);
  markSeen(A, 90, dir);
  expect(readSeen(dir)).toEqual({ [A]: 100, [B]: 50 });
  markSeen(A, 120, dir);
  expect(readSeen(dir)[A]).toBe(120);
});

it('an id that is not a session id is refused, and dropped when read', () => {
  expect(() => markSeen('../x', 1, dir)).toThrow();
  fs.writeFileSync(path.join(dir, 'seen-sessions.json'), JSON.stringify({ [A]: 5, bad: 7, [B]: 'x' }));
  expect(readSeen(dir)).toEqual({ [A]: 5 });
});

it('at most SEEN_MAX sessions are kept, the oldest marks go first', () => {
  const ids = Array.from({ length: SEEN_MAX + 2 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`);
  const data = Object.fromEntries(ids.slice(0, SEEN_MAX + 1).map((id, i) => [id, i + 1]));
  fs.writeFileSync(path.join(dir, 'seen-sessions.json'), JSON.stringify(data));
  markSeen(ids[SEEN_MAX + 1]!, 10_000, dir);
  const kept = readSeen(dir);
  expect(Object.keys(kept)).toHaveLength(SEEN_MAX);
  expect(kept[ids[0]!]).toBeUndefined();
  expect(kept[ids[1]!]).toBeUndefined();
  expect(kept[ids[SEEN_MAX + 1]!]).toBe(10_000);
});
