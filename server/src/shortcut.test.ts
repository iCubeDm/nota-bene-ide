import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installShortcut, shortcutInstalled, shortcutPath, type ShortcutHost } from './shortcut.ts';

// the smallest PNG: what the installer copies or wraps is opaque to it
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
let dir: string;
let host: (platform: NodeJS.Platform, env?: NodeJS.ProcessEnv) => ShortcutHost;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-shortcut-'));
  fs.writeFileSync(path.join(dir, 'icon.png'), PNG);
  host = (platform, env = {}) => ({ platform, env, home: path.join(dir, 'home'), state: path.join(dir, 'state'),
    node: '/opt/node/bin/node', launcher: '/opt/nb dir/bin/nota-bene.mjs', icon: path.join(dir, 'icon.png') });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('shortcut', () => {
  it('macOS: an app bundle in ~/Applications that runs the launcher with --app from a login shell', () => {
    const h = host('darwin');
    expect(shortcutInstalled(h)).toBe(false);
    const app = installShortcut(h);
    expect(app).toBe(path.join(dir, 'home/Applications/Nota Bene.app'));
    expect(shortcutInstalled(h)).toBe(true);
    const plist = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
    expect(plist).toContain('<key>CFBundleExecutable</key><string>nota-bene</string>');
    expect(plist).toContain('<key>CFBundleIconFile</key><string>icon</string>');
    const script = path.join(app, 'Contents/MacOS/nota-bene');
    expect(fs.statSync(script).mode & 0o111).toBeTruthy();
    const body = fs.readFileSync(script, 'utf8');
    expect(body).toMatch(/^#!\/bin\/zsh -li\n/);
    expect(body).toContain(`'/opt/node/bin/node'`);
    expect(body).toContain(`'/opt/nb dir/bin/nota-bene.mjs' --app`);
    const icns = fs.readFileSync(path.join(app, 'Contents/Resources/icon.icns'));
    expect(icns.subarray(0, 4).toString()).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(icns.subarray(8, 12).toString()).toBe('ic09');
    expect(icns.subarray(16).equals(PNG)).toBe(true);
  });

  it('macOS: a node that is gone (upgraded) falls back to the one on PATH', () => {
    const body = fs.readFileSync(path.join(installShortcut(host('darwin')), 'Contents/MacOS/nota-bene'), 'utf8');
    expect(body).toContain('[ -x "$n" ] || n=node');
  });

  it('Linux: a .desktop file under XDG_DATA_HOME with the icon kept in the state dir', () => {
    const h = host('linux', { XDG_DATA_HOME: path.join(dir, 'data') });
    const file = installShortcut(h);
    expect(file).toBe(path.join(dir, 'data/applications/nota-bene.desktop'));
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('Exec="/opt/node/bin/node" "/opt/nb dir/bin/nota-bene.mjs" --app\n');
    expect(text).toContain(`Icon=${path.join(dir, 'state/icon.png')}\n`);
    expect(fs.readFileSync(path.join(dir, 'state/icon.png')).equals(PNG)).toBe(true);
    expect(shortcutPath(host('linux'))).toBe(path.join(dir, 'home/.local/share/applications/nota-bene.desktop'));
  });

  it('Windows: a Start menu shortcut made by PowerShell, the paths in its environment, the icon an .ico', () => {
    const h = host('win32', { APPDATA: path.join(dir, 'roaming') });
    const run = vi.fn(() => ({ status: 0 }));
    const lnk = installShortcut(h, run);
    expect(lnk).toBe(path.join(dir, 'roaming/Microsoft/Windows/Start Menu/Programs/Nota Bene.lnk'));
    const [cmd, args, opts] = run.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(cmd).toBe('powershell.exe');
    expect(args.join(' ')).toContain('CreateShortcut($env:NB_LNK)');
    expect(opts.env).toMatchObject({ NB_LNK: lnk, NB_NODE: '/opt/node/bin/node', NB_ARGS: '"/opt/nb dir/bin/nota-bene.mjs" --app' });
    const ico = fs.readFileSync(opts.env.NB_ICON!);
    expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 1, 0]);
    expect(ico.subarray(22).equals(PNG)).toBe(true);
  });

  it('Windows: a PowerShell failure is an error', () => {
    expect(() => installShortcut(host('win32', { APPDATA: dir }), () => ({ status: 1 }))).toThrow(/shortcut/);
  });

  it('another platform has none', () => {
    expect(shortcutPath(host('aix'))).toBeNull();
    expect(shortcutInstalled(host('aix'))).toBe(false);
    expect(() => installShortcut(host('aix'))).toThrow(/aix/);
  });
});
