// The app icon (epic 383, "start by click"): `nota-bene shortcut` and the tab's Add install one that runs `nota-bene --app`
// (the home page). macOS: an app bundle in ~/Applications; Windows: a Start menu shortcut; Linux: a .desktop file.
// It runs the launcher that installed it, the one a later update hands over from, so it keeps working across updates.
// "Nota Bene" is the published package's; a checkout's is "Nota Bene Dev", beside it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from './atomicFile.ts';
import { stateBaseDir } from './state.ts';

export type ShortcutHost = {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** where an icon file the shortcut points at is kept (Linux, Windows) */
  state: string;
  node: string;
  launcher: string;
  /** a 512 px PNG */
  icon: string;
  /** the launcher is a checkout's: Nota Bene Dev */
  dev: boolean;
};

type Run = (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; windowsHide: boolean }) => { status: number | null };

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * This computer. `root`: the package (this file's, for the server; the launcher passes its own, as the published one is
 * a single bundled file in bin/). `launcher`: the one that started this window (its outer part, NOTA_BENE_LAUNCHER).
 */
export const hostNow = (o: { root?: string; launcher?: string } = {}): ShortcutHost => {
  const root = o.root ?? ROOT;
  const launcher = o.launcher ?? (process.env.NOTA_BENE_LAUNCHER || path.join(root, 'bin', 'nota-bene.mjs'));
  return {
    platform: process.platform, home: os.homedir(), env: process.env, state: stateBaseDir(), node: process.execPath, launcher,
    dev: fs.existsSync(path.join(launcher, '..', '..', '.git')),
    // the package ships web/dist; a checkout not built yet has the source
    icon: ['dist', 'public'].map((d) => path.join(root, 'web', d, 'icon-512.png')).find((f) => fs.existsSync(f)) ?? path.join(root, 'web', 'dist', 'icon-512.png'),
  };
};

const appName = (h: ShortcutHost) => (h.dev ? 'Nota Bene Dev' : 'Nota Bene');

/** Where the icon goes, or null on a platform without one. */
export function shortcutPath(h: ShortcutHost = hostNow()): string | null {
  if (h.platform === 'darwin') return path.join(h.home, 'Applications', `${appName(h)}.app`);
  if (h.platform === 'linux') {
    return path.join(h.env.XDG_DATA_HOME || path.join(h.home, '.local', 'share'), 'applications', h.dev ? 'nota-bene-dev.desktop' : 'nota-bene.desktop');
  }
  if (h.platform === 'win32') {
    return path.join(h.env.APPDATA || path.join(h.home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${appName(h)}.lnk`);
  }
  return null;
}

/** A bundle counts once its Info.plist, written last, is there. */
export const shortcutInstalled = (h: ShortcutHost = hostNow()): boolean => {
  const p = shortcutPath(h);
  return p !== null && fs.existsSync(h.platform === 'darwin' ? path.join(p, 'Contents', 'Info.plist') : p);
};

/** writeAtomic into a folder made first */
function put(file: string, data: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, data, mode);
}

const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** An .icns of one 512 px PNG ('ic09'): macOS scales it for the smaller sizes. */
function icns(png: Buffer): Buffer {
  const head = Buffer.alloc(16);
  head.write('icns', 0);
  head.writeUInt32BE(16 + png.length, 4);
  head.write('ic09', 8);
  head.writeUInt32BE(8 + png.length, 12);
  return Buffer.concat([head, png]);
}

/** An .ico of one PNG (Vista and later read PNG entries; 0 in the size bytes means 256 or more). */
function ico(png: Buffer): Buffer {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

const plist = (h: ShortcutHost) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${appName(h)}</string>
<key>CFBundleIdentifier</key><string>dev.notabene.launcher${h.dev ? '.dev' : ''}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleExecutable</key><string>nota-bene</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>LSUIElement</key><true/>
</dict></plist>
`;

/** Installs (or replaces) the icon; returns its path. Throws on a platform without one or when it cannot be written. */
export function installShortcut(h: ShortcutHost = hostNow(), run: Run = spawnSync): string {
  const at = shortcutPath(h);
  if (at === null) throw new Error(`no app icon on ${h.platform}`);
  const png = fs.readFileSync(h.icon);
  if (h.platform === 'darwin') {
    // a login shell: an app gets launchd's bare PATH, and the agent's CLI is on the user's
    put(path.join(at, 'Contents', 'MacOS', 'nota-bene'),
      `#!/bin/zsh -li\nn=${sh(h.node)}\n[ -x "$n" ] || n=node\nexec "$n" ${sh(h.launcher)} --app\n`, 0o755);
    put(path.join(at, 'Contents', 'Resources', 'icon.icns'), icns(png));
    put(path.join(at, 'Contents', 'Info.plist'), plist(h)); // last: the bundle counts as installed once it is complete
    return at;
  }
  if (h.platform === 'linux') {
    const icon = path.join(h.state, 'icon.png');
    put(icon, png);
    // Exec's quoting (a backslash before " ` $ \\), then the file's own escaping of a backslash, and %% for a %
    const q = (s: string) => `"${s.replace(/["`$\\]/g, '\\$&')}"`.replaceAll('\\', '\\\\').replaceAll('%', '%%');
    put(at, `[Desktop Entry]\nType=Application\nName=${appName(h)}\nExec=${q(h.node)} ${q(h.launcher)} --app\nIcon=${icon}\nTerminal=false\nCategories=Development;\n`);
    return at;
  }
  const icon = path.join(h.state, 'icon.ico');
  put(icon, ico(png));
  fs.mkdirSync(path.dirname(at), { recursive: true }); // PowerShell's Save() makes no folder
  // the paths reach PowerShell through its environment, never through its command line's quoting
  const script = '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:NB_LNK); $s.TargetPath = $env:NB_NODE; '
    + '$s.Arguments = $env:NB_ARGS; $s.IconLocation = $env:NB_ICON; $s.WindowStyle = 7; $s.Save()';
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...h.env, NB_LNK: at, NB_NODE: h.node, NB_ARGS: `"${h.launcher}" --app`, NB_ICON: icon }, windowsHide: true,
  });
  if (r.status !== 0) throw new Error('PowerShell could not create the Start menu shortcut');
  return at;
}
