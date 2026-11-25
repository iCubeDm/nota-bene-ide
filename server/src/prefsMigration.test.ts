import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migratePrefs } from './prefsMigration.ts';

let home: string;
const prev = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-prefs-move-'));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prev;
  fs.rmSync(home, { recursive: true, force: true });
});

const own = () => path.join(home, 'prefs.json');
const of = (p: string) => path.join(home, 'providers', p, 'prefs.json');
const put = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
const read = () => JSON.parse(fs.readFileSync(own(), 'utf8')) as Record<string, unknown>;

it('issue 706: a provider folder\'s prefs come into the one file: its folders become that provider\'s, what the file has wins', () => {
  put(own(), { lang: 'ru', modes: { 'claude:/a': 'plan' }, models: { 'claude:/a': { model: 'opus' } } });
  put(of('codex'), { lang: 'en', theme: 'dark', future: 1, modes: { '/a': 'default', 'codex:/b': 'auto' }, idleCompact: { '/a': false }, models: { 'codex:/a': { model: 'gpt-x' }, '/old': { model: 'y' } } });
  migratePrefs();
  expect(read()).toEqual({
    lang: 'ru', theme: 'dark', future: 1,
    modes: { 'claude:/a': 'plan', 'codex:/a': 'default', 'codex:/b': 'auto' },
    idleCompact: { 'codex:/a': false },
    models: { 'claude:/a': { model: 'opus' }, 'codex:/a': { model: 'gpt-x' } },
  });
  expect(fs.existsSync(of('codex'))).toBe(false);
  expect(fs.existsSync(`${of('codex')}.moved`)).toBe(true);
});

it('issue 706: a mode or idle compaction kept for a folder alone becomes every provider\'s, unless that provider has its own', () => {
  put(own(), { modes: { '/a': 'plan', 'omp:/a': 'default' }, idleCompact: { 'C:\\w': false }, models: { '/a': { model: 'x' } } });
  put(of('codex'), { modes: { '/a': 'auto' } });
  migratePrefs();
  expect(read()).toEqual({
    modes: { 'claude:/a': 'plan', 'codex:/a': 'auto', 'omp:/a': 'default' },
    idleCompact: { 'claude:C:\\w': false, 'codex:C:\\w': false, 'omp:C:\\w': false },
    models: { '/a': { model: 'x' } },
  });
});

it('nothing to move: the file is not written; a second run changes nothing', () => {
  migratePrefs();
  expect(fs.existsSync(own())).toBe(false);
  put(own(), '{"modes":{"claude:/a":"plan"}}');
  migratePrefs();
  expect(fs.readFileSync(own(), 'utf8')).toBe('{"modes":{"claude:/a":"plan"}}');
  put(of('omp'), { lang: 'de' });
  migratePrefs();
  const once = fs.readFileSync(own(), 'utf8');
  migratePrefs();
  expect(fs.readFileSync(own(), 'utf8')).toBe(once);
  expect(read().lang).toBe('de');
});

it('a provider file that is not an object stays where it is', () => {
  put(of('codex'), '{');
  migratePrefs();
  expect(fs.existsSync(of('codex'))).toBe(true);
  expect(fs.existsSync(own())).toBe(false);
});
