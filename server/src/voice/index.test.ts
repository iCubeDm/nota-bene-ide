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
});
