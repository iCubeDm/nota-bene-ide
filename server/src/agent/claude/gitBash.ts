// Claude Code on Windows runs its Bash tool in Git Bash: CLAUDE_CODE_GIT_BASH_PATH, else the bash.exe of the Git for
// Windows install that `git` on PATH belongs to. Without one the CLI has no Bash tool and runs shell commands through its
// PowerShell tool (code.claude.com/docs/en/setup: Git for Windows is optional, recommended for the Bash tool). A check,
// not a fix: the window still opens, the user gets the recommendation once (the `git-bash` server-error, translated by
// the page).
import fs from 'node:fs';
import path from 'node:path';
import { resolveBin } from '../../platform.ts';

type Env = Record<string, string | undefined>;
const isFile = (p: string): boolean => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

/** The bash.exe Claude Code would use, or null. Not Windows: null too (the CLI uses the system shell). */
export function gitBash({ env = process.env, platform = process.platform, exists = isFile }: { env?: Env; platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {}): string | null {
  if (platform !== 'win32') return null;
  const set = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (set) return exists(set) ? set : null; // the CLI takes the variable as is: a wrong one is not covered by another bash
  const git = resolveBin('git', { env, platform });
  const candidates: string[] = [];
  // <Git>\cmd\git.exe or <Git>\bin\git.exe, and <Git>\mingw64\bin\git.exe (resolveBin gives a path of the host's form)
  if (git) candidates.push(path.join(path.dirname(git), '..', 'bin', 'bash.exe'), path.join(path.dirname(git), '..', '..', 'bin', 'bash.exe'));
  for (const pf of [env.ProgramFiles ?? env.PROGRAMFILES, env['ProgramFiles(x86)']]) if (pf) candidates.push(path.win32.join(pf, 'Git', 'bin', 'bash.exe'));
  return candidates.find(exists) ?? null;
}

/** The recommendation for a Windows machine without Git Bash, or null when there is nothing to say. English: the console and
 *  the toast's fallback; the page shows its own translation of the `git-bash` warning. */
export function gitBashWarning(o: Parameters<typeof gitBash>[0] = {}): { where: 'git-bash'; message: string } | null {
  const platform = o.platform ?? process.platform;
  if (platform !== 'win32' || gitBash(o)) return null;
  const set = (o.env ?? process.env).CLAUDE_CODE_GIT_BASH_PATH;
  return {
    where: 'git-bash',
    message: set
      ? 'CLAUDE_CODE_GIT_BASH_PATH does not name an existing bash.exe: Claude Code cannot use Git Bash for its Bash tool. Point it at the bash.exe of Git for Windows, then restart Nota Bene.'
      : 'Git Bash was not found, so Claude Code runs shell commands in PowerShell, without its Bash tool. For the Bash tool, install Git for Windows (or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe), then restart Nota Bene.',
  };
}
