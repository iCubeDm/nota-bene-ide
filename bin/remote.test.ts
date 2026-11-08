import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('./nota-bene.mjs', import.meta.url));
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-rbin-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, NOTA_BENE_HOME: home }, encoding: 'utf8', timeout: 10_000 });

describe('nota-bene remote', () => {
  it('is dispatched before the window options are parsed', () => {
    const r = run('remote', 'devices');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/nota-bene remote is not running/);
    expect(r.stderr).not.toMatch(/Usage: nota-bene \[dir\]/);
  });

  it('has its own usage', () => {
    const r = run('remote', '--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/nota-bene remote pair/);
    expect(run('--help').stdout).toMatch(/nota-bene remote \[pair/);
  });
});
