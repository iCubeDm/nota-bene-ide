import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { forgetRecent, readHidden, RECENT_MAX, readRecent, recordRecent } from './recent.ts';

let base: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-recent-')); });
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

it('records newest first and moves a reopened folder to the front', () => {
  recordRecent(base, '/p/a', 'claude', 1);
  recordRecent(base, '/p/b', 'codex', 2);
  recordRecent(base, '/p/a', 'claude', 3);
  expect(readRecent(base)).toEqual([{ root: '/p/a', provider: 'claude', at: 3 }, { root: '/p/b', provider: 'codex', at: 2 }]);
});

it('keeps one entry per folder and provider', () => {
  recordRecent(base, '/p/a', 'claude', 1);
  recordRecent(base, '/p/a', 'codex', 2);
  expect(readRecent(base)).toHaveLength(2);
});

it('caps at RECENT_MAX', () => {
  for (let i = 0; i < RECENT_MAX + 5; i++) recordRecent(base, `/p/${i}`, 'claude', i);
  const r = readRecent(base);
  expect(r).toHaveLength(RECENT_MAX);
  expect(r.at(-1)!.root).toBe('/p/5');
});

it('seeds from agent-choice.json', () => {
  fs.writeFileSync(path.join(base, 'agent-choice.json'), JSON.stringify({ '/p/c': 'omp', '/p/a': 'claude' }));
  recordRecent(base, '/p/a', 'claude', 7);
  expect(readRecent(base)).toEqual([{ root: '/p/a', provider: 'claude', at: 7 }, { root: '/p/c', provider: 'omp', at: 0 }]);
});

it('unreadable files read as empty', () => {
  fs.writeFileSync(path.join(base, 'recent.json'), '{not json');
  expect(readRecent(base)).toEqual([]);
  fs.writeFileSync(path.join(base, 'recent.json'), JSON.stringify([{ root: '/p/a', provider: 'gpt', at: 1 }, { root: '/p/b', provider: 'codex', at: 2 }]));
  expect(readRecent(base)).toEqual([{ root: '/p/b', provider: 'codex', at: 2 }]);
});

it('a forgotten folder leaves the list for every provider, seeded ones too, until it is opened again', () => {
  fs.writeFileSync(path.join(base, 'agent-choice.json'), JSON.stringify({ '/p/c': 'omp' }));
  recordRecent(base, '/p/a', 'claude', 1);
  recordRecent(base, '/p/a', 'codex', 2);
  recordRecent(base, '/p/b', 'claude', 3);
  forgetRecent(base, '/p/a');
  forgetRecent(base, '/p/c');
  expect(readRecent(base)).toEqual([{ root: '/p/b', provider: 'claude', at: 3 }]);
  expect(readHidden(base)).toEqual(['/p/c', '/p/a']);
  recordRecent(base, '/p/a', 'codex', 4);
  expect(readRecent(base).map((e) => e.root)).toEqual(['/p/a', '/p/b']);
  expect(readHidden(base)).toEqual(['/p/c']);
});
