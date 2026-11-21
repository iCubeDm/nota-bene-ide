import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { breakLock, LOCK, updateJson, withLock, writeJsonAtomic } from './atomicFile.ts';

let dir: string;
const times = { ...LOCK };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-atomic-')); });
afterEach(() => { Object.assign(LOCK, times); fs.rmSync(dir, { recursive: true, force: true }); });

const N = 150;
const self = new URL('./atomicFile.ts', import.meta.url).href;

/** A separate process adding `N` entries named `tag` to the list in `file`, one locked update each. */
const adder = (file: string, tag: string) => new Promise<number | null>((resolve) => {
  const code = `import { updateJson } from ${JSON.stringify(self)};
for (let i = 0; i < ${N}; i++) updateJson(${JSON.stringify(file)}, (d) => [...(Array.isArray(d) ? d : []), ${JSON.stringify(tag)} + i]);`;
  spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' }).on('exit', resolve);
});

it('two processes updating one file lose none of each other\'s entries', async () => {
  const file = path.join(dir, 'list.json');
  expect(await Promise.all([adder(file, 'a'), adder(file, 'b')])).toEqual([0, 0]);
  const got = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
  expect(got).toHaveLength(2 * N);
  expect(new Set(got).size).toBe(2 * N);
  expect(fs.readdirSync(dir)).toEqual(['list.json']); // no lock or tmp file left behind
}, 60_000);

it('a lock left by a dead holder, or held too long, is taken over', async () => {
  const file = path.join(dir, 'x.json');
  const dead = await new Promise<number>((resolve) => {
    const c = spawn(process.execPath, ['-e', '']);
    c.on('exit', () => resolve(c.pid!));
  });
  fs.writeFileSync(`${file}.lock`, `${dead} t0`);
  updateJson(file, () => ({ n: 1 }));
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ n: 1 });

  fs.writeFileSync(`${file}.lock`, `${process.ppid} t1`); // alive, but its lock is a minute old
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.lock`, old, old);
  updateJson(file, (d) => ({ n: (d as { n: number }).n + 1 }));
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ n: 2 });
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

it('update reads a missing or corrupt file as undefined, writes nothing for undefined, and releases on a throw', () => {
  const file = path.join(dir, 'p.json');
  const seen: unknown[] = [];
  updateJson(file, (d) => void seen.push(d));
  expect(fs.existsSync(file)).toBe(false);
  fs.writeFileSync(file, '{oops');
  updateJson(file, (d) => { seen.push(d); return { a: 1 }; }, { space: 2 });
  expect(seen).toEqual([undefined, undefined]);
  expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "a": 1\n}');
  expect(() => updateJson(file, () => { throw new Error('no'); })).toThrow('no');
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

it('writeJsonAtomic keeps the format asked for and leaves no tmp file', () => {
  const file = path.join(dir, 'w.json');
  writeJsonAtomic(file, [1], { space: 2, newline: true, mode: 0o600 });
  expect(fs.readFileSync(file, 'utf8')).toBe('[\n  1\n]\n');
  if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(dir)).toEqual(['w.json']);
});

it('a lock with an mtime in the future counts as stale', () => {
  const file = path.join(dir, 'f.json');
  fs.writeFileSync(`${file}.lock`, `${process.ppid} t2`);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(`${file}.lock`, later, later);
  updateJson(file, () => 1);
  expect(fs.readFileSync(file, 'utf8')).toBe('1');
});

it('a release leaves a lock that is no longer its own', () => {
  const file = path.join(dir, 'o.json');
  withLock(file, () => fs.writeFileSync(`${file}.lock`, `${process.ppid} theirs`)); // taken over meanwhile
  expect(fs.readFileSync(`${file}.lock`, 'utf8')).toBe(`${process.ppid} theirs`);
});

it('breaking a stale lock never touches the live one that replaced it', () => {
  const lock = path.join(dir, 'b.json.lock');
  fs.writeFileSync(lock, `${process.ppid} live`);
  const ino = fs.statSync(lock).ino;
  breakLock(lock, '999999 judged-stale');
  expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.ppid} live`);
  expect(fs.statSync(lock).ino).toBe(ino); // not even moved aside and back
  expect(fs.readdirSync(dir)).toEqual(['b.json.lock']);
  breakLock(lock, `${process.ppid} live`);
  expect(fs.existsSync(lock)).toBe(false);
});

it('a wait is bounded: a lock that stays live past the cap is an error, not a hang', () => {
  Object.assign(LOCK, { waitMs: 200 });
  const file = path.join(dir, 'w.json');
  fs.writeFileSync(`${file}.lock`, `${process.ppid} busy`);
  const t = Date.now();
  expect(() => updateJson(file, () => 1)).toThrow(/lock/);
  expect(Date.now() - t).toBeLessThan(2000);
  expect(fs.existsSync(file)).toBe(false);
});
