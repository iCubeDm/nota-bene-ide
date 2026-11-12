import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentOutput, agentSpawn, codexVendored } from './bin.ts';

// The Windows branch is plain stat checks and string work, so it runs on any OS with a temp folder standing in for PATH.
const SHIM = '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
const TRIPLE = 'x86_64-pc-windows-msvc';

let dir: string;
const touch = (...parts: string[]) => {
  const f = path.join(dir, ...parts);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');
  return f;
};
const winEnv = () => ({ PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-bin-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('codexVendored', () => {
  it('finds the codex.exe nested in the package, hoisted beside it, or in its own vendor folder', () => {
    fs.writeFileSync(path.join(dir, 'codex.cmd'), SHIM);
    const root = path.join(dir, 'node_modules', '@openai', 'codex');
    expect(codexVendored(path.join(dir, 'codex.cmd'), 'x64')).toBeNull(); // the package has no binary
    const own = touch('node_modules', '@openai', 'codex', 'vendor', TRIPLE, 'bin', 'codex.exe');
    expect(codexVendored(path.join(dir, 'codex.cmd'), 'x64')).toEqual({ exe: own, root, pnpm: false });
    const hoisted = touch('node_modules', '@openai', 'codex-win32-x64', 'vendor', TRIPLE, 'bin', 'codex.exe');
    expect(codexVendored(path.join(dir, 'codex.cmd'), 'x64')?.exe).toBe(hoisted);
    const nested = touch('node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', TRIPLE, 'bin', 'codex.exe');
    expect(codexVendored(path.join(dir, 'codex.cmd'), 'x64')?.exe).toBe(nested);
    expect(codexVendored(path.join(dir, 'codex.cmd'), 'ia32')).toBeNull(); // no such build
  });

  it('another shim or no shim at all is not Codex', () => {
    fs.writeFileSync(path.join(dir, 'other.cmd'), '@"%~dp0\\node_modules\\other\\bin\\other.js" %*\r\n');
    expect(codexVendored(path.join(dir, 'other.cmd'), 'x64')).toBeNull();
    expect(codexVendored(path.join(dir, 'missing.cmd'), 'x64')).toBeNull();
  });
});

describe('agentSpawn', () => {
  it('POSIX: the command as given, nothing resolved', () => {
    expect(agentSpawn('codex', ['app-server'], { platform: 'linux', env: {} })).toEqual({ command: 'codex', args: ['app-server'] });
  });

  it('Windows: the Codex shim becomes its codex.exe, with the env codex.js would set', () => {
    fs.writeFileSync(path.join(dir, 'codex.cmd'), SHIM);
    const exe = touch('node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', TRIPLE, 'bin', 'codex.exe');
    expect(agentSpawn('codex', ['app-server'], { platform: 'win32', arch: 'x64', env: winEnv() })).toEqual({
      command: exe, args: ['app-server'],
      env: { CODEX_MANAGED_PACKAGE_ROOT: path.join(dir, 'node_modules', '@openai', 'codex'), CODEX_MANAGED_BY_NPM: '1' },
    });
  });

  it('Windows: another shim through cmd.exe, a script through this Node, an .exe directly, an unknown name as is', () => {
    fs.writeFileSync(path.join(dir, 'omp.cmd'), '@echo off\r\n');
    expect(agentSpawn('omp', ['acp'], { platform: 'win32', env: winEnv() })).toMatchObject({ command: 'cmd.exe', windowsVerbatimArguments: true });
    const js = touch('agent.mjs');
    expect(agentSpawn(js, ['--acp'], { platform: 'win32', env: winEnv(), execPath: 'node.exe' })).toEqual({ command: 'node.exe', args: [js, '--acp'] });
    const exe = touch('tool.exe');
    expect(agentSpawn('tool', ['-v'], { platform: 'win32', env: winEnv() })).toEqual({ command: exe, args: ['-v'] });
    expect(agentSpawn('nothing-here', ['-v'], { platform: 'win32', env: winEnv() })).toEqual({ command: 'nothing-here', args: ['-v'] });
  });
});

describe('agentOutput', () => {
  it('the stdout of a short call; null for a failure, a missing CLI or one that runs too long', async () => {
    expect(await agentOutput(process.execPath, ['-e', 'console.log("v1.2.3")'], 10_000)).toBe('v1.2.3\n');
    expect(await agentOutput(process.execPath, ['-e', 'process.exit(3)'], 10_000)).toBeNull();
    expect(await agentOutput(path.join(dir, 'nothing-here'), ['--version'], 10_000)).toBeNull();
    const started = Date.now();
    expect(await agentOutput(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
