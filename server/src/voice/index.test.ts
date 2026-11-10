import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VoiceIndex } from './index.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-vindex-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const v = (ms: number) => ({ id: 'a'.repeat(64), ms, wave: Array(48).fill(1) });

describe('VoiceIndex', () => {
  it('remembers a message\'s voice across instances', () => {
    const file = path.join(dir, 'voice.jsonl');
    new VoiceIndex({ file }).put('u1', v(100));
    new VoiceIndex({ file }).put('u2', v(200));
    const again = new VoiceIndex({ file });
    expect(again.get('u1')).toEqual(v(100));
    expect(again.get('u2')).toEqual(v(200));
    expect(again.get('u3')).toBeUndefined();
  });
  it('skips a broken line and a line that is not a voice', () => {
    const file = path.join(dir, 'voice.jsonl');
    fs.writeFileSync(file, `{"id":"u1","voice":${JSON.stringify(v(100))}}\n{broken\n{"id":"u2","voice":{"id":"x"}}\n`);
    const i = new VoiceIndex({ file });
    expect(i.get('u1')).toEqual(v(100));
    expect(i.get('u2')).toBeUndefined();
  });
  it('no file yet: nothing, and the first put makes it', () => {
    const file = path.join(dir, 'sub', 'voice.jsonl');
    const i = new VoiceIndex({ file });
    expect(i.get('u1')).toBeUndefined();
    i.put('u1', v(1));
    expect(fs.existsSync(file)).toBe(true);
  });
  describe('resolve', () => {
    const file = () => path.join(dir, 'voice.jsonl');
    const made = () => {
      const i = new VoiceIndex({ file: file() });
      i.put('a', v(1)); i.putText('a', 'run the tests');
      i.put('b', v(2)); i.putText('b', 'run the tests');
      i.put('c', v(3)); i.putText('c', '/clear the cache');
      return new VoiceIndex({ file: file() }); // read back from disk
    };
    it('matches by id first', () => {
      expect(made().resolve([{ id: 'b', text: 'whatever' }, { id: 'zz', text: 'typed' }])).toEqual([v(2), undefined]);
    });
    it('matches by text when the id is unknown: oldest first, each entry once', () => {
      const r = made().resolve([{ id: 'x1', text: ' run the tests ' }, { id: 'x2', text: 'run the tests' }, { id: 'x3', text: 'run the tests' }]);
      expect(r).toEqual([v(1), v(2), undefined]);
    });
    it('an entry matched by id is not given to a text match, even earlier in the replay', () => {
      expect(made().resolve([{ id: 'x1', text: 'run the tests' }, { id: 'a', text: 'run the tests' }])).toEqual([v(2), v(1)]);
    });
    it('ignores the zero-width guard before a slash', () => {
      expect(made().resolve([{ id: 'x1', text: '\u200b/clear the cache' }])).toEqual([v(3)]);
    });
    it('an empty text and an entry without a transcript match nothing', () => {
      const i = new VoiceIndex({ file: file() });
      i.put('a', v(1));
      expect(i.resolve([{ id: 'x', text: '' }, { id: 'y', text: 'anything' }])).toEqual([undefined, undefined]);
    });
    it('old lines (voice only) stay readable, and a text line without its voice is no entry', () => {
      fs.writeFileSync(file(), `{"id":"u1","voice":${JSON.stringify(v(1))}}\n{"id":"u2","text":"lost"}\n`);
      const i = new VoiceIndex({ file: file() });
      expect(i.get('u1')).toEqual(v(1));
      expect(i.resolve([{ id: 'n', text: 'lost' }])).toEqual([undefined]);
    });
    it('stays linear: thousands of messages resolve at once', () => {
      const i = new VoiceIndex({ file: file() });
      for (let n = 0; n < 3000; n++) { i.put(`a${n}`, v(n + 1)); i.putText(`a${n}`, `said ${n}`); }
      const t = Date.now();
      const r = i.resolve(Array.from({ length: 3000 }, (_, n) => ({ id: `n${n}`, text: `said ${n}` })));
      expect(r[2999]).toEqual(v(3000));
      expect(Date.now() - t).toBeLessThan(500);
    });
  });
});
