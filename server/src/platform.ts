// The one place for what differs between Windows and POSIX: finding and spawning binaries (PATHEXT, `.cmd` shims, npm
// without its shim), killing a process tree, comparing paths and renaming over a file another process holds open.
// Plain TS without dependencies: the launcher (bin/nota-bene.mjs) imports it too. Every function takes the platform
// (and env) as an optional argument, so both branches are unit-testable on any OS. Callers do not spawn a bare shim
// name (`npm`, `npx`, `codex`), signal a group with `process.kill(-pid)` or compare paths with `===`: they use these.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type Platform = NodeJS.Platform;
type Env = Record<string, string | undefined>;

/** How to spawn a command: `spawn(s.command, s.args, { ...opts, windowsVerbatimArguments: s.windowsVerbatimArguments })`. */
export type SpawnSpec = { command: string; args: string[]; windowsVerbatimArguments?: boolean };

/** Spread into spawn options: no console window flashes up for a child on Windows (ignored elsewhere). */
export const HIDDEN = { windowsHide: true } as const;

export const isWindows = (platform: Platform = process.platform): boolean => platform === 'win32';

/** An env variable by name, ignoring case on Windows (`Path` there is the usual spelling of PATH). */
function envGet(env: Env, name: string, platform: Platform): string | undefined {
  if (!isWindows(platform)) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

const isFile = (p: string): boolean => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};
// A Windows app execution alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` of a Store install): a reparse point that
// lstat calls a link and stat cannot follow (EACCES), though CreateProcess runs it. A dangling link (ENOENT) is no binary.
const isAppAlias = (p: string): boolean => {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return false;
  } catch { return false; }
  try { fs.statSync(p); return false; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT'; }
};
const isExecutable = (p: string): boolean => {
  if (!isFile(p)) return false;
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
};

/**
 * The full path of the binary `name` would run, or null. Pure stat checks, nothing is spawned.
 * Windows: every PATH folder × PATHEXT (default `.COM;.EXE;.BAT;.CMD`), so `npm` finds `npm.cmd`, never the extensionless
 * sh script next to it; a Store app's execution alias counts as a file. A name that already ends in a PATHEXT extension is looked up as is; a name with a folder part is
 * not searched in PATH (with PATHEXT appended when it has no such extension). The current folder is never searched.
 * POSIX: the first executable regular file named `name` in PATH; a name containing `/` is checked as is.
 */
export function resolveBin(name: string, { env = process.env, platform = process.platform }: { env?: Env; platform?: Platform } = {}): string | null {
  if (!name) return null;
  if (!isWindows(platform)) {
    if (name.includes('/')) return isExecutable(name) ? name : null;
    for (const dir of (env.PATH ?? '').split(':')) {
      const p = dir && path.join(dir, name);
      if (p && isExecutable(p)) return p;
    }
    return null;
  }
  const exts = (envGet(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const ext = path.win32.extname(name).toLowerCase();
  const candidates = ext && exts.includes(ext) ? [name] : exts.map((e) => name + e);
  const dirs = /[\\/]/.test(name) ? [''] : (envGet(env, 'PATH', platform) ?? '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of dirs) {
    for (const c of candidates) {
      // the host's join: on a real Windows host this is path.win32; tests of this branch on POSIX use POSIX temp folders
      const p = dir ? path.join(dir, c) : c;
      if (isFile(p) || isAppAlias(p)) return p;
    }
  }
  return null;
}

// cmd.exe metacharacters. A caret before any of them makes it literal in cmd's parsing (phase 2); `%` and `!` are
// covered too, because `^%` breaks a `%name%` lookup (an undefined name is left alone on a command line, see below).
const CMD_META = /([()%!^"<>&|])/g;

/** One argument as the C runtime (CommandLineToArgvW, node.exe, every MSVC program) parses it: in double quotes, a run of
 *  backslashes doubled before a `"` (escaped as `\"`) and before the closing quote. */
const msvcrtQuote = (arg: string): string => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;

/**
 * How to spawn the binary `file` (a resolved path, see `resolveBin`) with `args`, safely.
 * Windows `.cmd`/`.bat`: Node refuses them without a shell (EINVAL since the CVE-2024-27980 fix), and `shell: true` would
 * hand the args to cmd.exe unquoted. So the line is built here: `cmd.exe /d /s /c "<line>"` with
 * `windowsVerbatimArguments` (/d skips AutoRun, /s strips exactly the outer quotes). The rules:
 * - each arg is quoted for the C runtime (`msvcrtQuote`), then every cmd metacharacter in it, quotes included, is
 *   caret-escaped TWICE (`^^^&`). A batch shim (npm.cmd, cmd-shim's codex.cmd) forwards `%*` into a second command line
 *   that cmd parses again: the first pass leaves `^&`, the second a literal `&`. Escaping the quotes keeps cmd out of
 *   quote mode in both passes, so an arg's own `"` cannot expose a later `&`. `%*`/`%1` inside an arg stay literal:
 *   a `%*` expansion is not rescanned. Aimed at batch files that forward `%*`; one that reads `%~1` itself sees carets.
 * - the file path is quoted as is (paths cannot contain `"`); a `%` in it becomes `"^%"` (close the quote, an escaped
 *   percent, reopen), since percent expansion ignores quotes.
 * - an arg with a newline, CR or NUL throws: cmd ends the command there.
 * - delayed expansion (`!x!`) is off in a /c shell unless the registry enables it; then a `!` arg is not safe.
 * Other files (`.exe`, `.com`, no extension) are spawned directly; Node quotes their args. POSIX: unchanged.
 */
export function spawnSpec(file: string, args: readonly string[], platform: Platform = process.platform): SpawnSpec {
  const ext = path.win32.extname(file).toLowerCase();
  if (!isWindows(platform) || (ext !== '.cmd' && ext !== '.bat')) return { command: file, args: [...args] };
  for (const a of args) if (/[\r\n\0]/.test(a)) throw new Error(`an argument for ${path.win32.basename(file)} contains a line break or NUL`);
  const line = [
    `"${file.replace(/%/g, '"^%"')}"`,
    ...args.map((a) => msvcrtQuote(a).replace(CMD_META, '^$1').replace(CMD_META, '^$1')),
  ].join(' ');
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/** Windows: `node <cli.js>` for npm's bundled CLI next to `execPath`, else the shim from PATH through `spawnSpec`.
 *  POSIX: the bare name, spawned as before (npm/npx from PATH are plain executables there). */
function npmCliSpec(cli: string, bin: string, args: readonly string[], execPath: string, env: Env, platform: Platform): SpawnSpec {
  if (!isWindows(platform)) return { command: bin, args: [...args] };
  // the Windows installer: node.exe and node_modules\npm side by side
  const js = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', cli);
  if (isFile(js)) return { command: execPath, args: [js, ...args] };
  const found = resolveBin(bin, { env, platform });
  return found ? spawnSpec(found, args, platform) : { command: bin, args: [...args] };
}

type NpmOpts = { execPath?: string; env?: Env; platform?: Platform };

/** How to run npm. Windows, without its shell shim: `process.execPath` + npm-cli.js of the running Node when it has one,
 *  else `npm` resolved from PATH (a `.cmd` through cmd.exe, see `spawnSpec`), else bare `npm` (the spawn fails with
 *  ENOENT). POSIX: bare `npm`, looked up in PATH by spawn. */
export const npmSpec = (args: readonly string[], { execPath = process.execPath, env = process.env, platform = process.platform }: NpmOpts = {}): SpawnSpec =>
  npmCliSpec('npm-cli.js', 'npm', args, execPath, env, platform);

/** `npmSpec` for npx (npx-cli.js). */
export const npxSpec = (args: readonly string[], { execPath = process.execPath, env = process.env, platform = process.platform }: NpmOpts = {}): SpawnSpec =>
  npmCliSpec('npx-cli.js', 'npx', args, execPath, env, platform);

/**
 * Stops `pid` and its descendants; never throws for a process that is already gone.
 * POSIX: `signal` to the process group `-pid` (a child spawned with `detached: true` leads one), falling back to the
 * process alone when it leads no group. Windows has no signals or groups: `taskkill /PID <pid> /T /F` kills the tree
 * hard whatever `signal` says, so the processes get no chance to clean up.
 */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM', platform: Platform = process.platform): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isWindows(platform)) {
    // exit 128 = not found: nothing to do. Its output is not interesting either way.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { ...HIDDEN, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  }
}

/** Whether a process with this pid exists (EPERM: it does, owned by someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A path in a form fit for `===` and Map keys. Windows: `path.win32.normalize` (`/` becomes `\`, `.`/`..` resolved),
 * no trailing separator except on a root (`C:\`, `\\host\share\`), lower case: NTFS names are case-insensitive.
 * POSIX: `path.posix.normalize` without a trailing `/` (except `/`), case kept.
 */
export function pathKey(p: string, platform: Platform = process.platform): string {
  const lib = isWindows(platform) ? path.win32 : path.posix;
  let n = lib.normalize(p);
  if (n.length > lib.parse(n).root.length) n = n.replace(isWindows(platform) ? /[\\/]+$/ : /\/+$/, '');
  return isWindows(platform) ? n.toLowerCase() : n;
}

/** Whether two paths name the same location, lexically (see `pathKey`); symlinks are not resolved. */
export const samePath = (a: string, b: string, platform: Platform = process.platform): boolean => pathKey(a, platform) === pathKey(b, platform);

/** The real path with the OS's own spelling (`realpathSync.native`: on Windows the on-disk case and long names, which the
 *  JS `realpathSync` does not give); `path.resolve(p)` for a path that does not exist. */
export function realpathNative(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(p);
    throw e;
  }
}

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_FOR_MS = 2000;
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * `fs.renameSync`, the atomic replace of a written temp file. On Windows a rename over a file another process has open
 * (a virus scanner, the indexer, a reader in another window) fails with EPERM/EACCES/EBUSY for a moment: retried with a
 * growing pause for about 2 s in all, then the last error is thrown. Blocks the thread while it waits. POSIX: one attempt.
 */
export function renameRetry(from: string, to: string, platform: Platform = process.platform): void {
  if (!isWindows(platform)) return fs.renameSync(from, to);
  const start = Date.now();
  for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      const left = RETRY_FOR_MS - (Date.now() - start);
      if (!RETRY_CODES.has((e as NodeJS.ErrnoException).code ?? '') || left <= 0) throw e;
      sleepSync(Math.min(delay, left));
    }
  }
}
