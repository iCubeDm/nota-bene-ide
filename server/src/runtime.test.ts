import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installRelease, installing, launcherOf, pruneRuntime, readCurrent, readUpdateState, runtimeDir, writeCurrent } from './runtime.ts';
import { registerWindow } from './windows.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-runtime-'));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  delete process.env.FAKE_NPM_FAIL;
  delete process.env.FAKE_BIN_VERSION;
  fs.rmSync(home, { recursive: true, force: true });
});

// a fake npm: parses --prefix and nota-bene-ide@<v>, lays out the package like npm would
function fakeNpm(): string {
  const f = path.join(home, 'fake-npm.mjs');
  fs.writeFileSync(f, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
console.log('fake npm ' + a.join(' '));
if (process.env.FAKE_NPM_FAIL === '1') { console.error('boom'); process.exit(1); }
const prefix = a[a.indexOf('--prefix') + 1];
const v = a.find((x) => x.startsWith('nota-bene-ide@')).slice('nota-bene-ide@'.length);
const pkg = path.join(prefix, 'node_modules', 'nota-bene-ide');
fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'nota-bene-ide', version: v }));
fs.writeFileSync(path.join(pkg, 'bin', 'nota-bene.mjs'), 'console.log(process.env.FAKE_BIN_VERSION ?? ' + JSON.stringify(v) + ');');
`, { mode: 0o755 });
  return f;
}
const deadPid = () => spawnSync('true').pid!;
const install = (v: string, npm = fakeNpm(), extra: { npmTimeoutMs?: number } = {}) => installRelease(v, { npm, node: process.execPath, ...extra });
const lockFile = () => path.join(runtimeDir(), 'update.lock');
function fakeInstalled(v: string) {
  const l = launcherOf(v);
  fs.mkdirSync(path.dirname(l), { recursive: true });
  fs.writeFileSync(l, '');
}

describe('runtime store', () => {
  it('installs, checks and points current at it', async () => {
    expect(await install('1.7.0')).toBe('installed');
    expect(readCurrent()).toBe('1.7.0');
    expect(fs.readFileSync(path.join(runtimeDir(), 'update.log'), 'utf8')).toContain('fake npm install --prefix');
    expect(installing()).toBeNull();
  });

  it('a second install while one runs answers running', async () => {
    fs.mkdirSync(runtimeDir(), { recursive: true });
    fs.writeFileSync(lockFile(), JSON.stringify({ version: '1.7.0', pid: process.pid }));
    expect(installing()).toEqual({ version: '1.7.0', pid: process.pid });
    expect(await install('1.7.0')).toBe('running');
    expect(fs.existsSync(path.join(runtimeDir(), '1.7.0'))).toBe(false);
  });

  it('a stale lock is taken over', async () => {
    fs.mkdirSync(runtimeDir(), { recursive: true });
    fs.writeFileSync(lockFile(), JSON.stringify({ version: '1.6.5', pid: deadPid() }));
    expect(installing()).toBeNull();
    expect(await install('1.7.0')).toBe('installed');
  });

  it('a failed npm keeps current and records why', async () => {
    fakeInstalled('1.6.0');
    writeCurrent('1.6.0');
    process.env.FAKE_NPM_FAIL = '1';
    const r = await install('1.7.0');
    expect(r).toMatchObject({ failed: expect.any(String) });
    expect(readCurrent()).toBe('1.6.0');
    expect(readUpdateState().failed?.version).toBe('1.7.0');
    expect(fs.existsSync(path.join(runtimeDir(), '1.7.0'))).toBe(false);
    expect(installing()).toBeNull();
  });

  it('a version check that disagrees fails the install', async () => {
    process.env.FAKE_BIN_VERSION = '1.6.9';
    const r = await install('1.7.0');
    expect(r).toMatchObject({ failed: expect.stringContaining('1.6.9') });
    expect(readCurrent()).toBeNull();
    expect(fs.existsSync(path.join(runtimeDir(), '1.7.0'))).toBe(false);
  });

  it('current names a missing folder: readCurrent is null', () => {
    fs.mkdirSync(runtimeDir(), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir(), 'current'), '1.7.0');
    expect(readCurrent()).toBeNull();
  });

  it('writeCurrent with expect refuses when another wrote meanwhile', () => {
    fakeInstalled('1.6.0'); fakeInstalled('1.7.0'); fakeInstalled('1.8.0');
    expect(writeCurrent('1.7.0')).toBe(true);
    expect(writeCurrent('1.6.0', '1.8.0')).toBe(false);
    expect(readCurrent()).toBe('1.7.0');
    expect(writeCurrent('1.6.0', '1.7.0')).toBe(true);
    expect(readCurrent()).toBe('1.6.0');
  });

  it('prune keeps current, previous and versions live windows run', () => {
    for (const v of ['1.1.0', '1.2.0', '1.3.0', '1.4.0']) fakeInstalled(v);
    writeCurrent('1.2.0'); writeCurrent('1.3.0'); writeCurrent('1.4.0'); // previous = 1.3.0
    registerWindow(4791, '/p', process.pid, undefined, '1.1.0');
    pruneRuntime();
    const left = fs.readdirSync(runtimeDir()).filter((n) => /^\d/.test(n)).sort();
    expect(left).toEqual(['1.1.0', '1.3.0', '1.4.0']);
  });

  it('installing the current version never touches its folder, even if npm would fail', async () => {
    expect(await install('1.7.0')).toBe('installed');
    process.env.FAKE_NPM_FAIL = '1';
    expect(await install('1.7.0')).toBe('installed');
    expect(readCurrent()).toBe('1.7.0');
    expect(fs.existsSync(launcherOf('1.7.0'))).toBe(true);
  });

  it('a failed install of a version a live window runs keeps its folder', async () => {
    fakeInstalled('1.6.0'); // its bin is empty: the version check fails
    registerWindow(4791, '/p', process.pid, undefined, '1.6.0');
    expect(await install('1.6.0')).toMatchObject({ failed: expect.any(String) });
    expect(fs.existsSync(launcherOf('1.6.0'))).toBe(true);
  });

  it('a lock just created and still empty reads as installing and is not removed', async () => {
    fs.mkdirSync(runtimeDir(), { recursive: true });
    fs.writeFileSync(lockFile(), '');
    expect(installing()).not.toBeNull();
    expect(await install('1.7.0')).toBe('running');
    expect(fs.existsSync(lockFile())).toBe(true);
  });

  it('a hung npm is killed after the timeout and the install fails', async () => {
    const f = path.join(home, 'slow-npm.mjs');
    fs.writeFileSync(f, `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`, { mode: 0o755 });
    const r = await install('1.7.0', f, { npmTimeoutMs: 200 });
    expect(r).toEqual({ failed: 'npm timed out' });
    expect(installing()).toBeNull();
    expect(fs.existsSync(path.join(runtimeDir(), '1.7.0'))).toBe(false);
  });
});
