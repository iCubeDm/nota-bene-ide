import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installWhisper, whisperDir, whisperPhase } from './install.ts';
import { WHISPER_MODEL, WHISPER_REVISION, WHISPER_VERSION } from './whisper.ts';

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
      spawn: async (cmd, args) => { calls.push([cmd, ...args]); await gate; return ok; },
      fetchModel: async () => {},
    });
    expect(whisperPhase()).toBe('installing');
    release();
    await p;
    expect(whisperPhase()).toBe('ready');
    expect(calls[0]).toEqual(['/fake/npm', 'install', '--prefix', whisperDir(), `@huggingface/transformers@${WHISPER_VERSION}`, '--no-audit', '--no-fund']);
    expect(JSON.parse(fs.readFileSync(path.join(whisperDir(), 'ready.json'), 'utf8'))).toEqual({ version: WHISPER_VERSION, model: WHISPER_MODEL, revision: WHISPER_REVISION });
    expect(fs.existsSync(path.join(whisperDir(), 'install.lock'))).toBe(false);
  });

  it('runs fetchModel with the folder after npm succeeded', async () => {
    let seen = '';
    await installWhisper({ npm: '/fake/npm', spawn: async () => ok, fetchModel: async (dir) => { seen = dir; } });
    expect(seen).toBe(whisperDir());
  });

  it('fails without ready.json when npm fails', async () => {
    await expect(installWhisper({ npm: '/fake/npm', spawn: async () => ({ ...ok, code: 1 }), fetchModel: async () => {} })).rejects.toThrow(/npm install exited with 1/);
    expect(whisperPhase()).toBe('failed');
    expect(fs.existsSync(path.join(whisperDir(), 'ready.json'))).toBe(false);
  });

  it('fails when the model download fails, and a retry can succeed', async () => {
    await expect(installWhisper({ npm: '/fake/npm', spawn: async () => ok, fetchModel: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
    expect(whisperPhase()).toBe('failed');
    await installWhisper({ npm: '/fake/npm', spawn: async () => ok, fetchModel: async () => {} });
    expect(whisperPhase()).toBe('ready');
  });

  it('fails when npm is missing', async () => {
    const prev = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(installWhisper({ spawn: async () => ok, fetchModel: async () => {}, npm: null })).rejects.toThrow(/npm not found/);
    } finally { process.env.PATH = prev; }
    expect(whisperPhase()).toBe('failed');
  });

  it('refuses a second install while one runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = installWhisper({ npm: '/fake/npm', spawn: async () => { await gate; return ok; }, fetchModel: async () => {} });
    await expect(installWhisper({ npm: '/fake/npm', spawn: async () => ok, fetchModel: async () => {} })).rejects.toThrow(/already installing/);
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

  it('reads a lock older than the timeout as failed even if its pid lives', () => {
    fs.mkdirSync(whisperDir(), { recursive: true });
    const lock = path.join(whisperDir(), 'install.lock');
    fs.writeFileSync(lock, JSON.stringify({ version: WHISPER_VERSION, pid: process.pid }));
    const old = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(lock, old, old);
    expect(whisperPhase()).toBe('failed');
  });
});
