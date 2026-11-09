import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installWhisper, removeWhisper, whisperDir, whisperPhase } from './install.ts';
import { WHISPER_MODEL, WHISPER_PACKAGE, WHISPER_REVISION, WHISPER_VERSION } from './whisper.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-whisper-'));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

type Done = { code: number | null; stdout: string; timedOut: boolean };
const ok: Done = { code: 0, stdout: '', timedOut: false };
/** A fake npm that leaves what the real one would: node_modules in the prefix. */
const npmOk = async (): Promise<Done> => { fs.mkdirSync(path.join(whisperDir(), 'node_modules'), { recursive: true }); return ok; };

describe('installWhisper', () => {
  it('lives under the state base and starts as none', () => {
    expect(whisperDir()).toBe(path.join(home, 'whisper'));
    expect(whisperPhase()).toBe('none');
  });

  it('goes none, installing, ready and writes ready.json', async () => {
    const calls: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = installWhisper({
      npm: '/fake/npm',
      spawn: async (cmd, args) => { calls.push([cmd, ...args]); await gate; return npmOk(); },
      fetchModel: async () => {},
    });
    expect(whisperPhase()).toBe('installing');
    release();
    await p;
    expect(whisperPhase()).toBe('ready');
    expect(calls[0]).toEqual(['/fake/npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', fs.realpathSync(whisperDir())]);
    expect(JSON.parse(fs.readFileSync(path.join(whisperDir(), 'ready.json'), 'utf8'))).toEqual({ version: WHISPER_VERSION, model: WHISPER_MODEL, revision: WHISPER_REVISION });
    expect(fs.existsSync(path.join(whisperDir(), 'install.lock'))).toBe(false);
  });

  it('gives npm the real path when the home is reached through a symlink', async () => {
    // npm ci reads a symlinked prefix as a link root missing from the lockfile (macOS: /tmp is /private/tmp)
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-link-')), 'home');
    fs.symlinkSync(home, link);
    process.env.NOTA_BENE_HOME = link;
    let prefix = '';
    await installWhisper({ npm: '/fake/npm', spawn: async (_cmd, args) => { prefix = args[args.indexOf('--prefix') + 1]; return npmOk(); }, fetchModel: async () => {} });
    expect(prefix).toBe(fs.realpathSync(path.join(home, 'whisper')));
  });

  it('runs fetchModel with the folder after npm succeeded', async () => {
    let seen = '';
    await installWhisper({ npm: '/fake/npm', spawn: npmOk, fetchModel: async (dir) => { seen = dir; } });
    expect(seen).toBe(whisperDir());
  });

  it('fails without ready.json when npm fails', async () => {
    await expect(installWhisper({ npm: '/fake/npm', spawn: async () => ({ ...ok, code: 1 }), fetchModel: async () => {} })).rejects.toThrow(/npm ci exited with 1/);
    expect(whisperPhase()).toBe('failed');
    expect(fs.existsSync(path.join(whisperDir(), 'ready.json'))).toBe(false);
  });

  it('fails when the model download fails, and a retry can succeed', async () => {
    await expect(installWhisper({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
    expect(whisperPhase()).toBe('failed');
    await installWhisper({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} });
    expect(whisperPhase()).toBe('ready');
  });

  it('fails when npm is missing', async () => {
    const prev = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(installWhisper({ spawn: npmOk, fetchModel: async () => {}, npm: null })).rejects.toThrow(/npm not found/);
    } finally { process.env.PATH = prev; }
    expect(whisperPhase()).toBe('failed');
  });

  it('refuses a second install while one runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = installWhisper({ npm: '/fake/npm', spawn: async () => { await gate; return npmOk(); }, fetchModel: async () => {} });
    await expect(installWhisper({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} })).rejects.toThrow(/already installing/);
    release();
    await first;
    expect(whisperPhase()).toBe('ready');
  });

  it('is not ready when ready.json names other pins', () => {
    fs.mkdirSync(whisperDir(), { recursive: true });
    fs.writeFileSync(path.join(whisperDir(), 'ready.json'), JSON.stringify({ version: '0.0.1', model: WHISPER_MODEL, revision: WHISPER_REVISION }));
    expect(whisperPhase()).toBe('none');
  });

  it('reads a lock of a dead process as failed', () => {
    fs.mkdirSync(whisperDir(), { recursive: true });
    fs.writeFileSync(path.join(whisperDir(), 'install.lock'), JSON.stringify({ version: WHISPER_VERSION, pid: 2 ** 22 + 12345 }));
    expect(whisperPhase()).toBe('failed');
  });

  it('reads a lock older than the npm timeout as installing while its pid lives', () => {
    fs.mkdirSync(whisperDir(), { recursive: true });
    const lock = path.join(whisperDir(), 'install.lock');
    fs.writeFileSync(lock, JSON.stringify({ version: WHISPER_VERSION, pid: process.pid }));
    const old = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(lock, old, old);
    expect(whisperPhase()).toBe('installing');
  });

  it('a retry cannot take a live lock however old, and Remove refuses it', async () => {
    fs.mkdirSync(path.join(whisperDir(), 'node_modules'), { recursive: true });
    const lock = path.join(whisperDir(), 'install.lock');
    fs.writeFileSync(lock, JSON.stringify({ version: WHISPER_VERSION, pid: process.pid }));
    const old = new Date(Date.now() - 45 * 60_000);
    fs.utimesSync(lock, old, old);
    await expect(installWhisper({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} })).rejects.toThrow(/already installing/);
    expect(removeWhisper()).toBe(false);
    expect(fs.existsSync(path.join(whisperDir(), 'node_modules'))).toBe(true);
  });

  it('removes a finished install, and a dead-pid lock does not stop it', () => {
    fs.mkdirSync(whisperDir(), { recursive: true });
    fs.writeFileSync(path.join(whisperDir(), 'install.lock'), JSON.stringify({ version: WHISPER_VERSION, pid: 2 ** 22 + 12345 }));
    expect(removeWhisper()).toBe(true);
    expect(fs.existsSync(whisperDir())).toBe(false);
  });

  it('gives the model download its own timeout: it aborts, fails, and a retry works', async () => {
    let aborted = false;
    const hung = (_dir: string, signal?: AbortSignal) => new Promise<void>(() => { signal?.addEventListener('abort', () => { aborted = true; }); });
    await expect(installWhisper({ npm: '/fake/npm', spawn: npmOk, fetchModel: hung, fetchTimeoutMs: 30 })).rejects.toThrow(/timed out/);
    expect(aborted).toBe(true);
    expect(whisperPhase()).toBe('failed');
    await installWhisper({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} });
    expect(whisperPhase()).toBe('ready');
  });

  it('stays installing during a slow model download, however long npm took', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = installWhisper({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => { await gate; } });
    await new Promise((r) => setTimeout(r, 20));
    const lock = path.join(whisperDir(), 'install.lock');
    const old = new Date(Date.now() - 20 * 60_000);
    fs.utimesSync(lock, old, old);
    expect(whisperPhase()).toBe('installing');
    await expect(installWhisper({ npm: '/fake/npm', spawn: npmOk, fetchModel: async () => {} })).rejects.toThrow(/already installing/);
    expect(removeWhisper()).toBe(false);
    release();
    await p;
    expect(whisperPhase()).toBe('ready');
  });

  it('does not write ready.json when the install folder lost node_modules', async () => {
    const gone = async () => { fs.rmSync(path.join(whisperDir(), 'node_modules'), { recursive: true, force: true }); };
    await expect(installWhisper({ npm: '/fake/npm', spawn: npmOk, fetchModel: gone })).rejects.toThrow(/node_modules/);
    expect(fs.existsSync(path.join(whisperDir(), 'ready.json'))).toBe(false);
    expect(whisperPhase()).toBe('failed');
  });

  it('gives npm the pinned package.json and the committed lockfile, and nothing runs scripts', async () => {
    let seen: { pkg: unknown; lock: { packages: Record<string, { dependencies?: Record<string, string> }> } } | undefined;
    await installWhisper({
      npm: '/fake/npm',
      spawn: async () => {
        seen = { pkg: JSON.parse(fs.readFileSync(path.join(whisperDir(), 'package.json'), 'utf8')), lock: JSON.parse(fs.readFileSync(path.join(whisperDir(), 'npm-shrinkwrap.json'), 'utf8')) };
        return npmOk();
      },
      fetchModel: async () => {},
    });
    expect(seen!.pkg).toMatchObject({ dependencies: { [WHISPER_PACKAGE]: WHISPER_VERSION } });
    expect(seen!.lock.packages[''].dependencies).toEqual({ [WHISPER_PACKAGE]: WHISPER_VERSION });
    expect((seen!.pkg as { name: string }).name).toBe((seen!.lock as unknown as { name: string }).name);
  });
});

describe('the committed lockfile', () => {
  const lock = JSON.parse(fs.readFileSync(new URL('./npm-shrinkwrap.json', import.meta.url), 'utf8')) as { packages: Record<string, { version: string; resolved?: string; integrity?: string }> };
  it('pins the package and gives every dependency a registry URL and an integrity hash', () => {
    expect(lock.packages[`node_modules/${WHISPER_PACKAGE}`]?.version).toBe(WHISPER_VERSION);
    for (const [k, v] of Object.entries(lock.packages)) {
      if (!k) continue;
      expect(v.resolved, k).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(v.integrity, k).toMatch(/^sha512-/);
    }
  });
});
