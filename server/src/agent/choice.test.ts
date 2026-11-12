import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultChoice, detectAgents, lastAgent, menu, parseChoice, rememberAgent, type Probe } from './choice.ts';

const probeOf = (out: Record<string, string>): Probe => async (cmd) => out[cmd] ?? null;
const none = () => false;

describe('detectAgents', () => {
  it('finds each agent by its executable and version, oldest-supported checked', async () => {
    const found = await detectAgents({}, probeOf({ claude: '2.1.319 (Claude Code)', codex: 'codex-cli 0.166.0', omp: 'omp 18.20.1' }), none, '/home/u');
    expect(found).toEqual([
      { agent: 'claude', version: '2.1.319' },
      { agent: 'codex', version: '0.166.0' },
      { agent: 'omp', version: '18.20.1' },
    ]);
  });

  it('marks a CLI below the minimum as too old instead of usable', async () => {
    const found = await detectAgents({}, probeOf({ codex: 'codex-cli 0.150.2', omp: 'omp 18.9.0' }), none, '/home/u');
    expect(found).toEqual([
      { agent: 'codex', version: '0.150.2', tooOld: '0.166.0' },
      { agent: 'omp', version: '18.9.0', tooOld: '18.16.0' },
    ]);
  });

  it('counts Claude Code by its config folder when `claude` is not on PATH', async () => {
    const seen: string[] = [];
    const found = await detectAgents({}, probeOf({}), (p) => (seen.push(p), p === path.join('/home/u', '.claude')), '/home/u');
    expect(found).toEqual([{ agent: 'claude' }]);
    expect(seen).toEqual([path.join('/home/u', '.claude')]);
  });

  it('asks the executables NOTA_BENE_CODEX, NOTA_BENE_OMP and CLAUDE_CONFIG_DIR name', async () => {
    const asked: string[] = [];
    const probe: Probe = async (cmd, args) => (asked.push(`${cmd} ${args.join(' ')}`), null);
    await detectAgents({ NOTA_BENE_CODEX: '/opt/codex', NOTA_BENE_OMP: '/opt/omp', CLAUDE_CONFIG_DIR: '/cfg' }, probe, none, '/home/u');
    expect(asked.sort()).toEqual(['/opt/codex --version', '/opt/omp --version', 'claude --version']);
  });

  it('an unreadable version still counts the agent (the server checks it again)', async () => {
    expect(await detectAgents({}, probeOf({ omp: 'omp (dev build)' }), none, '/home/u')).toEqual([{ agent: 'omp' }]);
  });
});

describe('defaultChoice and parseChoice', () => {
  it('defaults to the agent last used in the folder, else Claude, else the first found', () => {
    expect(defaultChoice(['claude', 'codex'], 'codex')).toBe('codex');
    expect(defaultChoice(['claude', 'codex'], 'omp')).toBe('claude');
    expect(defaultChoice(['codex', 'omp'], undefined)).toBe('codex');
  });

  it('takes Enter, a number or a name; anything else is no answer', () => {
    const usable = ['claude', 'codex', 'omp'] as const;
    expect(parseChoice('', [...usable], 'codex')).toBe('codex');
    expect(parseChoice(' 3 ', [...usable], 'claude')).toBe('omp');
    expect(parseChoice('Codex', [...usable], 'claude')).toBe('codex');
    expect(parseChoice('4', [...usable], 'claude')).toBeNull();
    expect(parseChoice('gemini', [...usable], 'claude')).toBeNull();
  });
});

describe('menu', () => {
  it('numbers the usable agents, marks the default and says why one is left out', () => {
    const text = menu([
      { agent: 'claude', version: '2.1.319' },
      { agent: 'codex', version: '0.166.0' },
      { agent: 'omp', version: '18.9.0', tooOld: '18.16.0' },
    ], 'codex', 'codex');
    expect(text).toBe([
      'Which agent for this folder?',
      '  1) Claude Code 2.1.319',
      '  2) Codex 0.166.0  (last used here)',
      '  omp 18.9.0 is too old: Nota Bene needs 18.16.0 or newer.',
      '',
    ].join('\n'));
  });
});

describe('lastAgent and rememberAgent', () => {
  let base = '';
  afterEach(() => base && fs.rmSync(base, { recursive: true, force: true }));

  it('remembers the agent per folder, in a private file', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-choice-'));
    expect(lastAgent(base, '/p/a')).toBeUndefined();
    rememberAgent(base, '/p/a', 'codex');
    rememberAgent(base, '/p/b', 'omp');
    rememberAgent(base, '/p/a', 'claude');
    expect(lastAgent(base, '/p/a')).toBe('claude');
    expect(lastAgent(base, '/p/b')).toBe('omp');
    // Windows has no POSIX modes (a file reads back as 0o666 whatever was asked)
    if (process.platform !== 'win32') expect(fs.statSync(path.join(base, 'agent-choice.json')).mode & 0o777).toBe(0o600);
  });

  it('ignores a damaged file and an unknown agent in it', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-choice-'));
    fs.writeFileSync(path.join(base, 'agent-choice.json'), '{not json');
    expect(lastAgent(base, '/p/a')).toBeUndefined();
    fs.writeFileSync(path.join(base, 'agent-choice.json'), JSON.stringify({ '/p/a': 'gemini' }));
    expect(lastAgent(base, '/p/a')).toBeUndefined();
    rememberAgent(base, '/p/a', 'codex');
    expect(lastAgent(base, '/p/a')).toBe('codex');
  });
});
