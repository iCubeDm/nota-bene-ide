import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { packageRoot, packageVersion } from './version.ts';

const root = path.resolve(import.meta.dirname, '../..');

it('packageVersion is the root package.json version', () => {
  expect(packageVersion()).toBe((JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version);
});

it('packageRoot finds the nota-bene package from any depth, past a workspace package.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-ver-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'nota-bene-ide', version: '9.8.7', bin: { 'nota-bene': 'bin/nota-bene.mjs' } }));
    fs.mkdirSync(path.join(dir, 'server/src/remote'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server/package.json'), JSON.stringify({ name: '@nota-bene/server', version: '0.0.0' }));
    expect(packageRoot(path.join(dir, 'server/src/remote'))).toBe(dir);
    expect(packageRoot(path.join(dir, 'server'))).toBe(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
