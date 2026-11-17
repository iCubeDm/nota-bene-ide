// issue 457: a window opened by /nb knows the Claude Code plugin version it came from
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launcherInCommandLine, parentPluginVersion, pluginInstallVersion, procCmdline } from './pluginOrigin.ts';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-plugin origin-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** the plugin's install of the package: <data>/<ver>/node_modules/nota-bene-ide with <data>/<ver>/.nb-installed (plugin/skills/nb/open.mjs) */
function pluginInstall(ver: string, stamp = `${ver}\n`, base = tmp): string {
  const prefix = path.join(base, 'plugins', 'data', 'nota-bene-nota-bene', ver);
  const root = path.join(prefix, 'node_modules', 'nota-bene-ide');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'nota-bene.mjs'), '');
  if (stamp !== '') fs.writeFileSync(path.join(prefix, '.nb-installed'), stamp);
  return root;
}

describe('pluginInstallVersion', () => {
  it('reads the version of a package the plugin installed', () => {
    expect(pluginInstallVersion(pluginInstall('1.7.1'))).toBe('1.7.1');
  });
  it('null for a package without the plugin stamp (npm -g, the runtime folder)', () => {
    expect(pluginInstallVersion(pluginInstall('1.7.1', ''))).toBeNull();
    const plain = path.join(tmp, 'lib', 'node_modules', 'nota-bene-ide');
    fs.mkdirSync(plain, { recursive: true });
    expect(pluginInstallVersion(plain)).toBeNull();
  });
  it('null for a package root not under node_modules (a checkout)', () => {
    fs.writeFileSync(path.join(tmp, '.nb-installed'), '1.0.0\n');
    fs.mkdirSync(path.join(tmp, 'a', 'b'), { recursive: true });
    expect(pluginInstallVersion(path.join(tmp, 'a', 'b'))).toBeNull();
  });
  it('null for a stamp that is not a release', () => {
    expect(pluginInstallVersion(pluginInstall('1.7.1', 'junk\n'))).toBeNull();
  });
});

describe('launcherInCommandLine', () => {
  it('finds the package root of the launcher a command line runs, spaces in the path included', () => {
    const root = pluginInstall('1.7.1');
    const line = `/usr/local/bin/node ${path.join(root, 'bin', 'nota-bene.mjs')} /some/dir --agent claude`;
    expect(launcherInCommandLine(line)).toBe(root);
  });
  it('null when no launcher of an existing package is in it', () => {
    expect(launcherInCommandLine('/usr/local/bin/node /nowhere/node_modules/nota-bene-ide/bin/nota-bene.mjs /dir')).toBeNull();
    expect(launcherInCommandLine('zsh -c ls')).toBeNull();
    expect(launcherInCommandLine('')).toBeNull();
  });
});

describe('procCmdline', () => {
  it('joins the NUL-separated arguments of /proc/<pid>/cmdline with spaces', () => {
    expect(procCmdline('/usr/bin/node\0/a b/node_modules/nota-bene-ide/bin/nota-bene.mjs\0/dir\0')).toBe('/usr/bin/node /a b/node_modules/nota-bene-ide/bin/nota-bene.mjs /dir');
    expect(procCmdline('')).toBe('');
  });
});

describe('parentPluginVersion', () => {
  it.skipIf(process.platform === 'win32')('reads the plugin version of a live launcher process by its pid', async () => {
    const root = pluginInstall('1.7.1');
    const bin = path.join(root, 'bin', 'nota-bene.mjs');
    fs.writeFileSync(bin, 'setTimeout(() => {}, 10000);\n');
    const c = spawn(process.execPath, [bin, tmp, '--agent', 'claude'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(parentPluginVersion(c.pid!)).toBe('1.7.1');
    } finally {
      c.kill();
    }
    expect(parentPluginVersion(process.pid)).toBeNull(); // vitest itself is no launcher
  });
  // `ps` in the C locale prints a non-ASCII path as M-PM^T…: the lookup asks for UTF-8 itself
  it.skipIf(process.platform !== 'darwin')('reads a path with non-ASCII letters under the C locale', async () => {
    const base = path.join(tmp, 'Проект');
    const root = pluginInstall('1.7.1', '1.7.1\n', base);
    const bin = path.join(root, 'bin', 'nota-bene.mjs');
    fs.writeFileSync(bin, 'setTimeout(() => {}, 10000);\n');
    const c = spawn(process.execPath, [bin, tmp], { stdio: 'ignore' });
    const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE };
    try {
      await new Promise((r) => setTimeout(r, 200));
      process.env.LC_ALL = 'C';
      process.env.LANG = 'C';
      delete process.env.LC_CTYPE;
      expect(parentPluginVersion(c.pid!)).toBe('1.7.1');
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      c.kill();
    }
  });
});
