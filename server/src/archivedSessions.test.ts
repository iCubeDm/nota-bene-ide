import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readArchived, setArchived } from './archivedSessions.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-archived-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = () => path.join(dir, 'archived-sessions.json');

describe('archived sessions', () => {
  it('is empty without a file, and keeps what was set across reads (a restart)', () => {
    expect([...readArchived(dir)]).toEqual([]);
    setArchived(A, true, dir);
    setArchived(B, true, dir);
    expect([...readArchived(dir)]).toEqual([A, B]);
    setArchived(A, false, dir);
    expect([...readArchived(dir)]).toEqual([B]);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual([B]);
  });

  it('archiving twice keeps one entry; restoring an unknown id changes nothing', () => {
    setArchived(A, true, dir);
    setArchived(A, true, dir);
    setArchived(B, false, dir);
    expect([...readArchived(dir)]).toEqual([A]);
  });

  it('a corrupt file or one with junk entries gives the valid ids only', () => {
    fs.writeFileSync(file(), '{');
    expect([...readArchived(dir)]).toEqual([]);
    fs.writeFileSync(file(), JSON.stringify([A, '../x', 3, null, B]));
    expect([...readArchived(dir)]).toEqual([A, B]);
    fs.writeFileSync(file(), JSON.stringify({ ids: [A] }));
    expect([...readArchived(dir)]).toEqual([]);
  });

  it('refuses an id that is not a session id', () => {
    expect(() => setArchived('../x', true, dir)).toThrow();
    expect(fs.existsSync(file())).toBe(false);
  });

  it('stays bounded: the oldest entries go first', () => {
    const ids = Array.from({ length: 5001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    fs.writeFileSync(file(), JSON.stringify(ids.slice(0, 5000)));
    setArchived(ids[5000]!, true, dir);
    const kept = [...readArchived(dir)];
    expect(kept).toHaveLength(5000);
    expect(kept[0]).toBe(ids[1]);
    expect(kept.at(-1)).toBe(ids[5000]);
  });
});
