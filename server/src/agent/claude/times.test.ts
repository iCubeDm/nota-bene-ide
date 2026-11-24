import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptTooLargeError } from '../types.ts';
import { assertReplayable, projectFolder, transcriptTimes } from './times.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const projects = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-times-'));
  dirs.push(d);
  return d;
};
const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';

describe('transcriptTimes', () => {
  it('maps each record uuid to its timestamp, found in any project folder', async () => {
    const dir = projects();
    fs.mkdirSync(path.join(dir, '-other'));
    fs.mkdirSync(path.join(dir, '-proj'));
    fs.writeFileSync(path.join(dir, '-proj', 's1.jsonl'),
      line({ type: 'user', uuid: 'u1', timestamp: '2026-11-15T09:30:00.000Z', message: { role: 'user', content: 'a "uuid":"x" in text' } })
      + line({ type: 'assistant', uuid: 'a1', timestamp: '2026-11-15T09:31:05.500Z', message: { role: 'assistant', content: [] } })
      + 'not json\n'
      + line({ type: 'summary', summary: 'no uuid' })
      + line({ type: 'user', uuid: 'u2', timestamp: 'garbage' }));
    const times = await transcriptTimes(dir, 's1');
    expect(Object.fromEntries(times)).toEqual({ u1: Date.parse('2026-11-15T09:30:00.000Z'), a1: Date.parse('2026-11-15T09:31:05.500Z') });
  });

  it('reads a subagent file next to its session', async () => {
    const dir = projects();
    fs.mkdirSync(path.join(dir, '-proj', 's1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, '-proj', 's1', 'subagents', 'agent-ab12.jsonl'), line({ type: 'user', uuid: 'x1', timestamp: '2026-11-14T22:00:00.000Z' }));
    expect(Object.fromEntries(await transcriptTimes(dir, 's1', { agentId: 'ab12' }))).toEqual({ x1: Date.parse('2026-11-14T22:00:00.000Z') });
  });

  it('no file, no projects folder or an unsafe id: no times, never a throw', async () => {
    const dir = projects();
    expect((await transcriptTimes(dir, 'missing')).size).toBe(0);
    expect((await transcriptTimes(path.join(dir, 'nope'), 's1')).size).toBe(0);
    expect((await transcriptTimes(dir, '../s1')).size).toBe(0);
    expect((await transcriptTimes(dir, 's1', { agentId: '../x' })).size).toBe(0);
  });
});

describe('transcriptTimes on big files', () => {
  afterEach(() => vi.restoreAllMocks());

  it('streams the file: many records and a very long one, never the whole file in one string', async () => {
    const dir = projects();
    fs.mkdirSync(path.join(dir, '-proj'));
    const t0 = Date.parse('2026-11-15T00:00:00.000Z');
    const out = fs.createWriteStream(path.join(dir, '-proj', 'big.jsonl'));
    const n = 20_000;
    for (let i = 0; i < n; i++) out.write(line({ parentUuid: i ? `r${i - 1}` : null, type: 'user', message: { role: 'user', content: `m ${i}` }, uuid: `r${i}`, timestamp: new Date(t0 + i * 1000).toISOString() }));
    // a pasted image: one line of several megabytes before its uuid
    out.write(line({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(8 * 1024 * 1024) } }] }, uuid: 'img', timestamp: '2026-11-16T08:00:00.000Z' }));
    await new Promise((r) => out.end(r));
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const times = await transcriptTimes(dir, 'big');
    expect(readFile).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(times.size).toBe(n + 1);
    expect(times.get('r0')).toBe(t0);
    expect(times.get(`r${n - 1}`)).toBe(t0 + (n - 1) * 1000);
    expect(times.get('img')).toBe(Date.parse('2026-11-16T08:00:00.000Z'));
  });

  it('a record whose keys are in another order, or that names a uuid inside, is still read right (by JSON.parse)', async () => {
    const dir = projects();
    fs.mkdirSync(path.join(dir, '-proj'));
    fs.writeFileSync(path.join(dir, '-proj', 's.jsonl'),
      line({ timestamp: '2026-11-15T01:00:00.000Z', uuid: 'swapped' })
      + line({ type: 'user', toolUseResult: { uuid: 'inner', timestamp: '2020-01-01T00:00:00.000Z' }, uuid: 'outer', timestamp: '2026-11-15T02:00:00.000Z' }));
    expect(Object.fromEntries(await transcriptTimes(dir, 's'))).toEqual({ swapped: Date.parse('2026-11-15T01:00:00.000Z'), outer: Date.parse('2026-11-15T02:00:00.000Z') });
  });
});

describe('the project folder of a cwd', () => {
  it('is the CLI\'s encoding: every character but a letter or digit becomes -', () => {
    expect(projectFolder('/Users/me/my project.v2')).toBe('-Users-me-my-project-v2');
    expect(projectFolder('C:\\work\\app')).toBe('C--work-app');
  });

  it('with the cwd it reads that folder only, not every project folder', async () => {
    const dir = projects();
    const cwd = '/work/app';
    fs.mkdirSync(path.join(dir, projectFolder(cwd)));
    fs.writeFileSync(path.join(dir, projectFolder(cwd), 's1.jsonl'), line({ uuid: 'u', timestamp: '2026-11-15T01:00:00.000Z' }));
    const readdir = vi.spyOn(fs.promises, 'readdir');
    expect((await transcriptTimes(dir, 's1', { cwd })).get('u')).toBe(Date.parse('2026-11-15T01:00:00.000Z'));
    expect(readdir).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('a cwd whose folder does not hold it falls back to the scan', async () => {
    const dir = projects();
    fs.mkdirSync(path.join(dir, '-elsewhere'));
    fs.writeFileSync(path.join(dir, '-elsewhere', 's1.jsonl'), line({ uuid: 'u', timestamp: '2026-11-15T01:00:00.000Z' }));
    expect((await transcriptTimes(dir, 's1', { cwd: '/work/app' })).get('u')).toBe(Date.parse('2026-11-15T01:00:00.000Z'));
  });
});

describe('assertReplayable', () => {
  it('a transcript past the cap is refused with its size; at the cap, missing or unsafe: it passes', async () => {
    const dir = projects();
    fs.mkdirSync(path.join(dir, '-proj'));
    fs.writeFileSync(path.join(dir, '-proj', 's1.jsonl'), 'x'.repeat(10));
    await expect(assertReplayable(dir, 's1', undefined, 9)).rejects.toEqual(new TranscriptTooLargeError(10));
    await expect(assertReplayable(dir, 's1', undefined, 10)).resolves.toBeUndefined();
    await expect(assertReplayable(dir, 'gone', undefined, 0)).resolves.toBeUndefined();
    await expect(assertReplayable(dir, '../s1', undefined, 0)).resolves.toBeUndefined();
  });
});
