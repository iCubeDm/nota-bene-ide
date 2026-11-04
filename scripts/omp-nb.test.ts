import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { parseInvocation, launchArgs, publicOutput } from '../omp/skills/nb/open.mjs';

it('binds omp, always detaches and forks only the invoking session', () => {
  expect(launchArgs(parseInvocation([], {}))).toEqual(['--agent', 'omp', '--detach']);
  expect(launchArgs(parseInvocation(['new'], {}))).toEqual(['--agent', 'omp', '--detach', '--new']);
  const id = '12345678-0000-7000-8000-000000000000';
  expect(launchArgs(parseInvocation(['fork'], { PI_SESSION_ID: id }))).toEqual(['--agent', 'omp', '--detach', '--resume', id, '--fork']);
  expect(launchArgs(parseInvocation(['fork', '--source', id], {}))).toEqual(['--agent', 'omp', '--detach', '--resume', id, '--fork']);
  expect(() => parseInvocation(['fork'], {})).toThrow(/source session/i);
  expect(() => parseInvocation(['--host', 'cli'], {})).toThrow();
});
it('never prints browser credentials to the calling agent', () => {
  expect(publicOutput('opened http://127.0.0.1:4790/#t=abcdef123456\n')).toBe('opened http://127.0.0.1:4790/\n');
});
it('passes paths with spaces as single arguments and sanitizes launcher output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-omp skill-'));
  const fake = path.join(dir, 'launcher.mjs');
  fs.writeFileSync(fake, 'console.log(JSON.stringify(process.argv.slice(2))); console.log("opened http://127.0.0.1:4790/#t=abcdef123456");');
  try {
    const p = spawnSync(process.execPath, [path.resolve('omp/skills/nb/open.mjs'), '--dir', dir], { env: { ...process.env, NOTA_BENE_BIN: fake }, encoding: 'utf8' });
    expect(p.status).toBe(0); expect(p.stdout).toContain(JSON.stringify(dir)); expect(p.stdout).not.toContain('abcdef123456'); expect(p.stdout).toContain('"--agent","omp"');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
