import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { transcriptTimes } from './times.ts';

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
    expect(Object.fromEntries(await transcriptTimes(dir, 's1', 'ab12'))).toEqual({ x1: Date.parse('2026-11-14T22:00:00.000Z') });
  });

  it('no file, no projects folder or an unsafe id: no times, never a throw', async () => {
    const dir = projects();
    expect((await transcriptTimes(dir, 'missing')).size).toBe(0);
    expect((await transcriptTimes(path.join(dir, 'nope'), 's1')).size).toBe(0);
    expect((await transcriptTimes(dir, '../s1')).size).toBe(0);
    expect((await transcriptTimes(dir, 's1', '../x')).size).toBe(0);
  });
});
