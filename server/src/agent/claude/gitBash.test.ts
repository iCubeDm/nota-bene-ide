import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitBash, gitBashWarning } from './gitBash.ts';

// `exists` stands in for the disk; `git` is found by resolveBin, so a temp folder stands in for PATH.
const W = path.win32;
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-gitbash-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('gitBash', () => {
  it('not Windows: nothing to find, nothing to warn about', () => {
    expect(gitBash({ platform: 'linux', env: {} })).toBeNull();
    expect(gitBashWarning({ platform: 'darwin', env: {} })).toBeNull();
  });

  it('CLAUDE_CODE_GIT_BASH_PATH as is, and a wrong one is not covered by another bash', () => {
    const set = W.join('D:', 'Tools', 'Git', 'bin', 'bash.exe');
    expect(gitBash({ platform: 'win32', env: { CLAUDE_CODE_GIT_BASH_PATH: set }, exists: (p) => p === set })).toBe(set);
    const other = W.join('C:', 'Program Files', 'Git', 'bin', 'bash.exe');
    const env = { CLAUDE_CODE_GIT_BASH_PATH: set, ProgramFiles: W.join('C:', 'Program Files') };
    expect(gitBash({ platform: 'win32', env, exists: (p) => p === other })).toBeNull();
    expect(gitBashWarning({ platform: 'win32', env, exists: (p) => p === other })?.message).toMatch(/CLAUDE_CODE_GIT_BASH_PATH/);
  });

  it('the bash.exe of the Git that `git` on PATH belongs to, else the one in Program Files', () => {
    const cmd = path.join(dir, 'Git', 'cmd');
    fs.mkdirSync(cmd, { recursive: true });
    fs.writeFileSync(path.join(cmd, 'git.exe'), '');
    const env = { PATH: cmd, PATHEXT: '.EXE', ProgramFiles: W.join('C:', 'Program Files') };
    const bash = path.join(dir, 'Git', 'bin', 'bash.exe');
    expect(gitBash({ platform: 'win32', env, exists: (p) => p === bash })).toBe(bash);
    const pf = W.join('C:', 'Program Files', 'Git', 'bin', 'bash.exe');
    expect(gitBash({ platform: 'win32', env, exists: (p) => p === pf })).toBe(pf);
  });

  it('none at all: a warning that says what to install', () => {
    const w = gitBashWarning({ platform: 'win32', env: { PATH: dir }, exists: () => false });
    expect(w).toMatchObject({ where: 'git-bash' });
    expect(w?.message).toMatch(/Git for Windows/);
  });
});
