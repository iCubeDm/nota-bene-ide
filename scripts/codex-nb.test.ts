import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { parseInvocation, launchArgs } from '../codex/skills/nb/open.mjs';
it('binds the invoking vendor, supports CLI/Desktop and never guesses a fork source', () => {
  expect(launchArgs(parseInvocation(['new', '--host', 'desktop'], {}))).toEqual(['--agent', 'codex', '--detach', '--new']);
  expect(launchArgs(parseInvocation([], {}))).toEqual(['--agent', 'codex', '--detach']);
  const id = '12345678-0000-4000-8000-000000000000';
  expect(launchArgs(parseInvocation(['fork', '--host', 'cli'], { CODEX_THREAD_ID: id }))).toEqual(['--agent', 'codex', '--resume', id, '--fork']);
  expect(() => parseInvocation(['fork'], {})).toThrow(/source thread/i);
  expect(() => parseInvocation(['bad'], {})).toThrow();
});
it('the installed symlink entry point executes rather than silently exiting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-link-'));
  fs.symlinkSync(path.resolve('codex/skills/nb/open.mjs'), path.join(dir, 'open.mjs'));
  try {
    const r = spawnSync(process.execPath, [path.join(dir, 'open.mjs'), 'fork'], { env: { ...process.env, CODEX_THREAD_ID: '' }, encoding: 'utf8' });
    expect(r.status).toBe(1); expect(r.stderr).toContain('source thread');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
it('every release pin follows package.json', () => {
  const read = (f: string) => fs.readFileSync(f, 'utf8');
  const { version } = JSON.parse(read('package.json')) as { version: string };
  expect((JSON.parse(read('codex/plugin.json')) as { version: string }).version).toBe(version);
  expect((JSON.parse(read('plugin/.claude-plugin/plugin.json')) as { version: string }).version).toBe(version);
  expect((JSON.parse(read('package-lock.json')) as { version: string }).version).toBe(version);
  expect(read('codex/skills/nb/SKILL.md')).toContain(`--package=nota-bene-ide@${version} `);
  for (const pin of read('README.md').match(/nota-bene-ide@\d+\.\d+\.\d+/g) ?? []) expect(pin).toBe(`nota-bene-ide@${version}`);
});
