import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProvider, providerStateDir } from './provider.ts';
import { envAgentContext, lastSession, saveSession, serverStateDir } from '../state.ts';
import { underState } from '../stateGuard.ts';
import { parseArgs } from '../main.ts';
// @ts-expect-error plain launcher ESM has no declarations
import { parseArgs as launchArgs, serverArgs } from '../../../bin/nota-bene.mjs';

afterEach(() => vi.unstubAllEnvs());

describe('provider identity', () => {
  it('keeps Claude as the default and rejects unknown providers', () => {
    expect(parseProvider(undefined)).toBe('claude');
    expect(parseProvider('codex')).toBe('codex');
    expect(() => parseProvider('../codex')).toThrow(/agent/i);
  });

  it('issue 706: the server\'s state is the state folder whichever agent it started as; an agent\'s is its provider\'s', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-provider-'));
    try {
      vi.stubEnv('NOTA_BENE_HOME', base);
      vi.stubEnv('NOTA_BENE_AGENT', 'claude');
      expect(serverStateDir()).toBe(base);
      saveSession(serverStateDir(), '/project', 'claude-session');
      vi.stubEnv('NOTA_BENE_AGENT', 'codex');
      expect(serverStateDir()).toBe(base);
      const codex = envAgentContext().stateDir;
      expect(codex).toBe(providerStateDir(base, 'codex'));
      expect(lastSession(codex, '/project')).toBeUndefined();
      saveSession(codex, '/project', 'codex-session');
      expect(underState(path.join(base, 'token'))).toBe(true);
      expect(underState(path.join(codex, 'token'))).toBe(true);
      expect(lastSession(serverStateDir(), '/project')).toBe('claude-session');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('passes explicit selection through the launcher, including relaunch', () => {
    const args = launchArgs(['.', '--agent', 'codex']);
    expect(args.agent).toBe('codex');
    expect(serverArgs({ ...args, dir: '/project' }, 4790, false)).toContain('codex');
    expect(serverArgs({ ...args, dir: '/project' }, 4790, true)).toEqual(['/project', '--port', '4790', '--agent', 'codex', '--continue']);
    expect(parseArgs(['--agent', 'codex'], process.cwd()).agent).toBe('codex');
    expect(() => launchArgs(['--agent', 'other'])).toThrow(/agent/i);
    expect(() => parseArgs(['--agent', 'other'], process.cwd())).toThrow(/agent/i);
  });
});
