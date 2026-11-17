// Issue 457: which Claude Code plugin version opened this window. The /nb skill (plugin/skills/nb/open.mjs) installs the
// package of its own version into <plugin data>/<version>/node_modules/nota-bene-ide and stamps <plugin data>/<version>/.nb-installed.
// A launcher run from such an install says so to its window (NOTA_BENE_PLUGIN_VERSION, bin/nota-bene.mjs); after an in-app update the
// window runs a newer version than that plugin, which Claude Code does not update by itself, and the page says how to update it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isWindows } from './platform.ts';
import { RELEASE } from './update.ts';

const PKG = 'nota-bene-ide';
const LAUNCHER = /[\\/]node_modules[\\/]nota-bene-ide[\\/]bin[\\/]nota-bene\.mjs/g;

/** The plugin version that installed the package at `root` (its <prefix>/.nb-installed), or null: not a plugin's install. */
export function pluginInstallVersion(root: string): string | null {
  const modules = path.dirname(root);
  if (path.basename(root) !== PKG || path.basename(modules) !== 'node_modules') return null;
  let stamp: string;
  try {
    stamp = fs.readFileSync(path.join(path.dirname(modules), '.nb-installed'), 'utf8').trim();
  } catch {
    return null;
  }
  return RELEASE.test(stamp) ? stamp : null;
}

/**
 * The package root of the launcher a process command line runs (`node <root>/bin/nota-bene.mjs <dir> ...`), or null. A path
 * may hold spaces, so each start after a space is tried until one names an existing package.
 */
export function launcherInCommandLine(line: string): string | null {
  for (const m of line.matchAll(LAUNCHER)) {
    const head = line.slice(0, m.index);
    const starts = [0, ...[...head.matchAll(/ /g)].map((s) => s.index + 1)];
    for (const i of starts) {
      const dir = head.slice(i);
      const root = path.join(dir, 'node_modules', PKG);
      if (path.isAbsolute(dir) && fs.existsSync(path.join(root, 'bin', 'nota-bene.mjs'))) return root;
    }
  }
  return null;
}

/** A /proc/<pid>/cmdline (its arguments, each ended by a NUL) as one line, the arguments joined with spaces like `ps` shows them. */
export function procCmdline(raw: string): string {
  return raw.split('\0').filter((a) => a !== '').join(' ');
}

/**
 * A process's command line: /proc/<pid>/cmdline on Linux, else `ps` (-ww: never cut to the terminal's width; a UTF-8 locale: in
 * the C locale macOS `ps` prints a non-ASCII path as M-PM^T…), or null.
 */
function commandLine(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      return procCmdline(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
    } catch {
      // no procfs mounted: ask ps
    }
  }
  const env = process.platform === 'darwin' ? { ...process.env, LC_ALL: 'en_US.UTF-8' } : process.env;
  const r = spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env });
  return r.status === 0 && r.stdout ? r.stdout.trim() : null;
}

/**
 * The plugin version of the outer launcher that handed this window over (our parent, `pid`), when that launcher is older
 * than this change and so does not pass NOTA_BENE_PLUGIN_VERSION on. Read from its command line; not on Windows (null).
 */
export function parentPluginVersion(pid: number): string | null {
  if (isWindows() || !Number.isInteger(pid) || pid <= 1) return null;
  const line = commandLine(pid);
  const root = line ? launcherInCommandLine(line) : null;
  return root ? pluginInstallVersion(root) : null;
}
