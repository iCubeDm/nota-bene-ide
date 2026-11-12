import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIDDEN, isWindows, killTree, npmSpec, npxSpec, pathKey, pidAlive, realpathNative, renameRetry, resolveBin, samePath, spawnSpec } from './platform.ts';

const win32 = process.platform === 'win32';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-platform-')));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const touch = (p: string, mode = 0o755): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '', { mode });
  return p;
};

it('isWindows', () => {
  expect(isWindows('win32')).toBe(true);
  expect(isWindows('linux')).toBe(false);
  expect(isWindows('darwin')).toBe(false);
  expect(HIDDEN).toEqual({ windowsHide: true });
});

// The win32 branch only joins with the host's path module, so it runs on POSIX temp folders too.
describe('resolveBin on win32', () => {
  const opts = (env: Record<string, string>) => ({ env, platform: 'win32' as const });

  it('finds a shim through PATHEXT, never the extensionless sh script next to it', () => {
    const a = path.join(tmp, 'a');
    touch(path.join(a, 'npm'));
    const cmd = touch(path.join(a, 'npm.cmd'));
    expect(resolveBin('npm', opts({ PATH: a }))).toBe(cmd);
  });

  it('takes PATH order first, then PATHEXT order; Path and PATHEXT keys in any case', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    touch(path.join(a, 'x.cmd'));
    const exe = touch(path.join(b, 'x.exe'));
    const exeA = touch(path.join(a, 'x.exe'));
    expect(resolveBin('x', opts({ Path: `${b};${a}` }))).toBe(exe);
    expect(resolveBin('x', opts({ Path: `"${a}";${b}` }))).toBe(exeA); // .EXE before .CMD in the default PATHEXT
    expect(resolveBin('x', opts({ PATH: a, PathExt: '.CMD;.EXE' }))).toBe(path.join(a, 'x.cmd'));
    expect(resolveBin('x', opts({ PATH: `;;${b}` }))).toBe(exe);
  });

  it('looks a name with a PATHEXT extension or a folder part up as is', () => {
    const a = path.join(tmp, 'a');
    const cmd = touch(path.join(a, 'tool.cmd'));
    touch(path.join(a, 'tool'));
    expect(resolveBin('tool.cmd', opts({ PATH: a }))).toBe(cmd);
    expect(resolveBin(cmd, opts({ PATH: '' }))).toBe(cmd);
    expect(resolveBin(path.join(a, 'tool'), opts({ PATH: '' }))).toBe(cmd); // a path without extension gets PATHEXT
    expect(resolveBin('tool.exe', opts({ PATH: a }))).toBeNull();
    expect(resolveBin('missing', opts({ PATH: a }))).toBeNull();
    expect(resolveBin('', opts({ PATH: a }))).toBeNull();
  });

  it('ignores folders with the name', () => {
    fs.mkdirSync(path.join(tmp, 'd.exe'), { recursive: true });
    expect(resolveBin('d', opts({ PATH: tmp }))).toBeNull();
  });

  // a file symlink needs admin or Developer Mode on Windows
  it.skipIf(win32)('a dangling link is no binary', () => {
    fs.symlinkSync(path.join(tmp, 'gone.exe'), path.join(tmp, 'x.exe'));
    expect(resolveBin('x', opts({ PATH: tmp }))).toBeNull();
  });

  // a Store app's execution alias (pwsh, winget, python): a link that stat cannot follow, which CreateProcess runs
  const apps = win32 && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : '';
  const alias = (() => {
    try {
      return fs.readdirSync(apps).find((f) => /\.exe$/i.test(f) && fs.lstatSync(path.join(apps, f)).isSymbolicLink());
    } catch { return undefined; }
  })();
  it.skipIf(!alias)('finds a Windows app execution alias', () => {
    expect(resolveBin(alias!.replace(/\.exe$/i, ''), opts({ PATH: apps }))).toBe(path.join(apps, alias!));
  });
});

// POSIX PATH uses ':' as its separator, which a Windows temp path (C:\...) contains.
describe.skipIf(win32)('resolveBin on POSIX', () => {
  it('finds the first executable file in PATH', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    touch(path.join(a, 'x'), 0o644); // not executable
    const x = touch(path.join(b, 'x'));
    expect(resolveBin('x', { env: { PATH: `${a}:${b}` }, platform: 'linux' })).toBe(x);
    expect(resolveBin(x, { env: { PATH: '' }, platform: 'linux' })).toBe(x);
    expect(resolveBin(path.join(a, 'x'), { env: { PATH: '' }, platform: 'linux' })).toBeNull();
    expect(resolveBin('x.cmd', { env: { PATH: b }, platform: 'linux' })).toBeNull();
  });
});

describe('spawnSpec', () => {
  it('spawns .exe and extensionless files directly, and everything on POSIX', () => {
    expect(spawnSpec('C:\\n\\node.exe', ['a b'], 'win32')).toEqual({ command: 'C:\\n\\node.exe', args: ['a b'] });
    expect(spawnSpec('/usr/bin/npm.cmd', ['&'], 'linux')).toEqual({ command: '/usr/bin/npm.cmd', args: ['&'] });
  });

  // the line inside `cmd /d /s /c "..."` for C:\b\x.cmd and one argument
  const line = (arg: string, file = 'C:\\b\\x.cmd') => {
    const s = spawnSpec(file, [arg], 'win32');
    expect(s.command).toBe('cmd.exe');
    expect(s.windowsVerbatimArguments).toBe(true);
    expect(s.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const l = s.args[3]!;
    expect(l.startsWith('"') && l.endsWith('"')).toBe(true);
    return l.slice(1, -1);
  };
  const Q = '^^^"'; // a doubly caret-escaped quote
  it.each([
    ['plain', `${Q}plain${Q}`],
    ['a b', `${Q}a b${Q}`],
    ['', `${Q}${Q}`],
    ['x"y', `${Q}x\\${Q}y${Q}`],
    ['a&b', `${Q}a^^^&b${Q}`],
    ['%PATH%', `${Q}^^^%PATH^^^%${Q}`],
    ['^', `${Q}^^^^${Q}`],
    ['!x!', `${Q}^^^!x^^^!${Q}`],
    ['<>|()', `${Q}^^^<^^^>^^^|^^^(^^^)${Q}`],
    ['c:\\x\\', `${Q}c:\\x\\\\${Q}`], // backslashes before the closing quote doubled
    ['a\\"b', `${Q}a\\\\\\${Q}b${Q}`],
  ])('quotes %j for cmd.exe', (arg, quoted) => {
    expect(line(arg)).toBe(`"C:\\b\\x.cmd" ${quoted}`);
  });

  it('quotes the file, a percent in it outside the quotes', () => {
    expect(line('a', 'C:\\Program Files\\a&b%x%\\t.BAT')).toBe(`"C:\\Program Files\\a&b"^%"x"^%"\\t.BAT" ${Q}a${Q}`);
    expect(spawnSpec('C:\\b\\x.cmd', [], 'win32').args[3]).toBe('""C:\\b\\x.cmd""');
  });

  it('refuses a line break or NUL in an argument', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\0b']) expect(() => spawnSpec('C:\\x.cmd', ['ok', bad], 'win32')).toThrow(/line break/);
  });

  // a real batch file that forwards %* to node, like npm.cmd and cmd-shim's shims: every argument arrives intact
  it.runIf(win32)('round-trips arguments through a real .cmd in a folder with cmd metacharacters', () => {
    const dir = path.join(tmp, 'dir a&b(1)%PATH%');
    fs.mkdirSync(dir);
    const cmd = path.join(dir, 'echo.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
    const args = ['a b', 'x"y', 'a"&b', '&', '%PATH%', '^', '', 'c:\\x\\', 'a\\"b', '!x!', '<>|()', 'q " & echo PWNED', '%%',
      ' lead', 'trail\\\\', 'é ü 日本', '%~dp0', '%*', '%1', 'a;b,c=d', '*?', '\\\\srv\\s', 'tab\there'];
    const s = spawnSpec(resolveBin(path.join(dir, 'echo'))!, args);
    const r = spawnSync(s.command, s.args, { ...HIDDEN, windowsVerbatimArguments: s.windowsVerbatimArguments, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual(args);
  });
});

describe('npmSpec / npxSpec', () => {
  it('runs the npm-cli.js next to node.exe on win32', () => {
    const node = touch(path.join(tmp, 'nodejs', 'node.exe'));
    const cli = touch(path.join(tmp, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    const npx = touch(path.join(tmp, 'nodejs', 'node_modules', 'npm', 'bin', 'npx-cli.js'));
    expect(npmSpec(['i', 'a b'], { execPath: node, platform: 'win32', env: {} })).toEqual({ command: node, args: [cli, 'i', 'a b'] });
    expect(npxSpec(['vite'], { execPath: node, platform: 'win32', env: {} })).toEqual({ command: node, args: [npx, 'vite'] });
  });

  it('runs <prefix>/lib/node_modules/npm on POSIX', () => {
    const node = touch(path.join(tmp, 'prefix', 'bin', 'node'));
    const cli = touch(path.join(tmp, 'prefix', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    expect(npmSpec(['-v'], { execPath: node, platform: 'linux', env: {} })).toEqual({ command: node, args: [cli, '-v'] });
  });

  it('falls back to the shim from PATH, through cmd.exe on win32', () => {
    const node = touch(path.join(tmp, 'n', 'node.exe'));
    const shim = touch(path.join(tmp, 'bin', 'npm.cmd'));
    const s = npmSpec(['-v'], { execPath: node, platform: 'win32', env: { Path: path.dirname(shim) } });
    expect(s).toEqual(spawnSpec(shim, ['-v'], 'win32'));
    expect(npmSpec(['-v'], { execPath: node, platform: 'win32', env: {} })).toEqual({ command: 'npm', args: ['-v'] });
  });

  it('finds the real npm of the running Node', () => {
    const s = npmSpec(['--version']);
    const r = spawnSync(s.command, s.args, { ...HIDDEN, windowsVerbatimArguments: s.windowsVerbatimArguments, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('killTree', () => {
  it('ignores a gone process and bad pids', () => {
    const r = spawnSync(process.execPath, ['-e', ''], HIDDEN);
    expect(r.pid).toBeGreaterThan(0);
    expect(() => killTree(r.pid!)).not.toThrow();
    expect(() => killTree(0)).not.toThrow();
    expect(() => killTree(-5)).not.toThrow();
  });

  it('signals the group on POSIX, the process when it leads none', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid < 0) throw Object.assign(new Error('no group'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);
    killTree(1234, 'SIGKILL', 'linux');
    expect(kill.mock.calls).toEqual([[-1234, 'SIGKILL'], [1234, 'SIGKILL']]);
    kill.mockImplementation((() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }) as typeof process.kill);
    expect(() => killTree(1234, 'SIGTERM', 'darwin')).not.toThrow();
    kill.mockImplementation((() => { throw Object.assign(new Error('not yours'), { code: 'EPERM' }); }) as typeof process.kill);
    expect(() => killTree(1234, 'SIGTERM', 'darwin')).toThrow(/not yours/);
  });

  it('kills a real child and its grandchild', async () => {
    // the child starts a grandchild, prints its pid and waits; detached so it leads a group on POSIX
    const script = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      process.stdout.write(String(c.pid) + '\\n'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script], { ...HIDDEN, detached: !win32, stdio: ['ignore', 'pipe', 'ignore'] });
    const grand = await new Promise<number>((resolve) => child.stdout!.once('data', (d: Buffer) => resolve(Number(String(d).trim()))));
    expect(pidAlive(child.pid!)).toBe(true);
    expect(pidAlive(grand)).toBe(true);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    killTree(child.pid!);
    await exited;
    for (let i = 0; i < 50 && pidAlive(grand); i++) await new Promise((r) => setTimeout(r, 100));
    expect(pidAlive(grand)).toBe(false);
  });
});

it('pidAlive', () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(0)).toBe(false);
  expect(pidAlive(1.5)).toBe(false);
  const r = spawnSync(process.execPath, ['-e', ''], HIDDEN);
  expect(pidAlive(r.pid!)).toBe(false);
});

describe('pathKey / samePath', () => {
  it.each([
    ['C:\\Users\\X\\proj', 'c:/users/x/PROJ/'],
    ['C:\\a\\..\\b', 'c:\\b\\'],
    ['C:\\', 'c:/'],
    ['\\\\host\\share\\x', '//HOST/share/x/'],
  ])('win32: %s = %s', (a, b) => {
    expect(samePath(a, b, 'win32')).toBe(true);
  });

  it('win32 keys', () => {
    expect(pathKey('C:/Users/X/', 'win32')).toBe('c:\\users\\x');
    expect(pathKey('c:/', 'win32')).toBe('c:\\');
    expect(pathKey('D:', 'win32')).not.toBe(pathKey('C:', 'win32'));
    expect(samePath('C:\\a', 'D:\\a', 'win32')).toBe(false);
  });

  it('POSIX: case-sensitive, normalized', () => {
    expect(samePath('/a/b/', '/a/./b', 'linux')).toBe(true);
    expect(samePath('/a/B', '/a/b', 'darwin')).toBe(false);
    expect(pathKey('/', 'linux')).toBe('/');
    expect(pathKey('/x//y/', 'linux')).toBe('/x/y');
  });
});

it('realpathNative', () => {
  const f = touch(path.join(tmp, 'Real.txt'));
  expect(realpathNative(f)).toBe(f);
  if (win32) expect(realpathNative(f.toUpperCase())).toBe(f); // the on-disk case
  expect(realpathNative(path.join(tmp, 'nope', '..', 'gone'))).toBe(path.join(tmp, 'gone'));
});

describe('renameRetry', () => {
  it('renames over an existing file', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.writeFileSync(a, 'new');
    fs.writeFileSync(b, 'old');
    renameRetry(a, b);
    expect(fs.readFileSync(b, 'utf8')).toBe('new');
    expect(fs.existsSync(a)).toBe(false);
  });

  it('retries EPERM/EACCES/EBUSY on win32 only, and other errors never', () => {
    let fails = 2;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      if (fails-- > 0) throw Object.assign(new Error('busy'), { code: fails ? 'EPERM' : 'EBUSY' });
    });
    renameRetry('a', 'b', 'win32');
    expect(rename).toHaveBeenCalledTimes(3);

    rename.mockClear();
    fails = 1;
    expect(() => renameRetry('a', 'b', 'linux')).toThrow('busy');
    expect(rename).toHaveBeenCalledTimes(1);

    rename.mockReset().mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    expect(() => renameRetry('a', 'b', 'win32')).toThrow('missing');
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('gives up after about 2 s with the last error', () => {
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('locked'), { code: 'EACCES' }); });
    const t = Date.now();
    expect(() => renameRetry('a', 'b', 'win32')).toThrow('locked');
    const took = Date.now() - t;
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(3500);
    expect(rename.mock.calls.length).toBeGreaterThan(5);
  });
});
