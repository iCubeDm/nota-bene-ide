import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findFfmpeg } from './ffmpeg.ts';
import { CutReverse, ReverseError } from './reverse.ts';

let root: string;
const made: CutReverse[] = [];
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-cut-reverse-'))); });
afterEach(() => {
  while (made.length) made.pop()!.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
const make = (o: Partial<ConstructorParameters<typeof CutReverse>[0]> = {}) => {
  const r = new CutReverse({ root: () => root, ffmpeg: () => findFfmpeg(), ...o });
  made.push(r);
  return r;
};
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ReverseError) return [e.status, e.code];
    throw e;
  }
  throw new Error('not refused');
};
const until = async <T,>(f: () => Promise<T | null>, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== null) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// a stand-in ffmpeg: asked for a file's streams (no output) it names them by the file's text (AV, A); making a copy it
// logs the call and writes its arguments as the copy, or hangs (HANG) or fails (FAIL)
const FAKE = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
const body = fs.readFileSync(a[a.indexOf('-i') + 1], 'utf8');
if (!a.includes('-f')) {
  process.stderr.write((body.includes('V') ? '  Stream #0:0: Video: h264\\n' : '') + (body.includes('A') ? '  Stream #0:1: Audio: aac\\n' : ''));
  process.exit(1);
}
fs.appendFileSync(path.join(__dirname, 'copies.log'), process.pid + '\\n');
if (body.startsWith('HANG')) setInterval(() => {}, 1000);
else if (body.startsWith('FAIL')) process.exit(1);
else fs.writeFileSync(a[a.length - 1], JSON.stringify(a));
`;

describe('CutReverse', () => {
  it('refuses a bad part, a path outside the project, a file that is not video or sound, a missing one; nothing runs without ffmpeg', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(root, 'a.mp4'), 'x');
    const r = make();
    expect(await refused(r.get('a.mp4', 2, 1))).toEqual([400, 'bad-part']);
    expect(await refused(r.get('a.mp4', -1, 1))).toEqual([400, 'bad-part']);
    expect(await refused(r.get('../x.mp4', 0, 1))).toEqual([403, 'outside-project']);
    expect(await refused(r.get('a.txt', 0, 1))).toEqual([400, 'not-media']);
    expect(await refused(r.get('gone.mp4', 0, 1))).toEqual([404, 'not-found']);
    expect(await refused(make({ ffmpeg: () => null }).get('a.mp4', 0, 1))).toEqual([501, 'no-ffmpeg']);
    expect(fs.existsSync(path.join(root, '.nota-bene'))).toBe(false);
  });

  describe('with a stand-in ffmpeg', () => {
    let bin: string;
    const copies = () => { try { return fs.readFileSync(path.join(path.dirname(bin), 'copies.log'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
    const media = (name: string, body: string) => fs.writeFileSync(path.join(root, name), body);
    beforeEach(() => {
      bin = path.join(root, 'bin', 'ffmpeg');
      fs.mkdirSync(path.dirname(bin));
      fs.writeFileSync(bin, FAKE, { mode: 0o755 });
    });

    it('makes a copy once per source version and part, into the project\'s .nota-bene kept out of git', async () => {
      media('a.mp4', 'AV');
      const r = make({ ffmpeg: () => bin });
      expect(await r.get('a.mp4', 1, 3)).toBeNull(); // started
      expect(await r.get('a.mp4', 1, 3)).toBeNull(); // still making: no second copy
      const out = await until(() => r.get('a.mp4', 1, 3));
      expect(out).toMatch(/^\.nota-bene\/reverse\/[0-9a-f]{32}\.mp4$/);
      expect(fs.readFileSync(path.join(root, '.nota-bene', '.gitignore'), 'utf8')).toBe('*\n');
      const args = JSON.parse(fs.readFileSync(path.join(root, out), 'utf8')) as string[];
      expect(args.slice(args.indexOf('-ss'), args.indexOf('-i') + 2)).toEqual(['-ss', '1', '-t', '2', '-i', path.join(root, 'a.mp4')]);
      expect(args[args.indexOf('-vf') + 1]).toMatch(/^reverse,/);
      expect(args[args.indexOf('-af') + 1]).toBe('areverse');
      expect(await r.get('a.mp4', 1, 3)).toBe(out);
      expect(copies()).toBe(1);
      // a server started again finds it on disk
      expect(await make({ ffmpeg: () => bin }).get('a.mp4', 1, 3)).toBe(out);
      expect(copies()).toBe(1);
      // another part, or the source changed: another copy
      const other = await until(() => r.get('a.mp4', 0, 3));
      expect(other).not.toBe(out);
      const t = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(root, 'a.mp4'), t, t);
      expect(await until(() => r.get('a.mp4', 1, 3))).not.toBe(out);
      expect(copies()).toBe(3);
    });

    it('a sound gets an m4a without picture; a failed copy is remembered for that source version; the newest `keep` stay', async () => {
      media('s.wav', 'A');
      media('bad.mp4', 'FAIL AV');
      const r = make({ ffmpeg: () => bin, keep: 2 });
      const s = await until(() => r.get('s.wav', 0, 1));
      expect(s).toMatch(/\.m4a$/);
      const args = JSON.parse(fs.readFileSync(path.join(root, s), 'utf8')) as string[];
      expect(args).toContain('-vn');
      expect(args).not.toContain('-ss'); // from 0
      await r.get('bad.mp4', 0, 1);
      expect(await until(() => refused(r.get('bad.mp4', 0, 1)).catch(() => null))).toEqual([422, 'failed']);
      expect(await refused(r.get('bad.mp4', 0, 1))).toEqual([422, 'failed']);
      expect(copies()).toBe(2);
      await until(() => r.get('s.wav', 0, 2));
      await until(() => r.get('s.wav', 0, 3));
      expect(fs.readdirSync(path.join(root, '.nota-bene', 'reverse')).filter((n) => !n.startsWith('.'))).toHaveLength(2);
      expect(fs.existsSync(path.join(root, s))).toBe(false); // the oldest
    });

    it('one copy at a time; a copy that takes too long is stopped and answers timeout', async () => {
      media('slow.mp4', 'HANG AV');
      media('b.mp4', 'AV');
      const r = make({ ffmpeg: () => bin, timeoutMs: 300 });
      await r.get('slow.mp4', 0, 1);
      await r.get('b.mp4', 0, 1);
      await new Promise((res) => setTimeout(res, 150));
      expect(copies()).toBe(1); // b waits
      expect(await until(() => refused(r.get('slow.mp4', 0, 1)).catch(() => null))).toEqual([504, 'timeout']);
      expect(await until(() => r.get('b.mp4', 0, 1))).toMatch(/\.mp4$/);
    });
  });

  const real = findFfmpeg();
  it.skipIf(!real)('the copy runs the part backwards, picture and sound', async () => {
    const ff = (...args: string[]) => execFileSync(real!, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    // 1 s red then 1 s blue, with a tone that is quiet then loud
    ff('-f', 'lavfi', '-i', 'color=c=red:size=32x32:rate=10:duration=1', '-f', 'lavfi', '-i', 'color=c=blue:size=32x32:rate=10:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v];[2]volume=0.05[q];[3]volume=0.9[l];[q][l]concat=n=2:v=0:a=1[a]',
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, 'rb.mp4'));
    const r = make();
    const out = path.join(root, await until(() => r.get('rb.mp4', 0, 2), 60_000));
    const firstPixel = execFileSync(real!, ['-hide_banner', '-loglevel', 'error', '-i', out, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    expect(firstPixel[2]!).toBeGreaterThan(firstPixel[0]!); // blue first
    // loud first now
    const peak = (...at: string[]) => {
      const pcm = execFileSync(real!, ['-hide_banner', '-loglevel', 'error', ...at, '-i', out, '-t', '0.5', '-ac', '1', '-f', 's16le', 'pipe:1']);
      let max = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
      return max;
    };
    expect(peak()).toBeGreaterThan(5 * peak('-ss', '1.4'));
  }, 60_000);
});
