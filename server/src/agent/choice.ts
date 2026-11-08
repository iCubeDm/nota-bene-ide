// Which agent a bare `nota-bene` starts: the launcher asks in an interactive terminal when more than one can start here.
// Agents are found by their executable and its `--version`, never by reading their login files. No imports beyond node and
// versions.ts: the launcher runs this before any agent (and so any state folder) is chosen.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentProvider } from './provider.ts';
import { CODEX_MIN_VERSION, OMP_MIN_VERSION } from './versions.ts';

/** An agent found on this machine; `tooOld` is the minimum its CLI is below, so it is not offered. */
export interface Found { agent: AgentProvider; version?: string; tooOld?: string }
/** Runs `cmd args`, resolving to its stdout, or null when it cannot run or fails. */
export type Probe = (cmd: string, args: string[]) => Promise<string | null>;

const LABEL: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex', omp: 'omp' };
const ORDER: AgentProvider[] = ['claude', 'codex', 'omp'];
const PROBE_MS = 5000;
const FILE = 'agent-choice.json';

const runVersion: Probe = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: PROBE_MS }, (error, stdout) => resolve(error ? null : stdout));
});

const versionIn = (text: string): string | undefined => /(\d+\.\d+\.\d+)/.exec(text)?.[1];

const below = (v: string, min: string): boolean => {
  const [a, b] = [v, min].map((x) => x.split('.').map(Number)) as [number[], number[]];
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i]! < b[i]!;
};

async function cli(agent: AgentProvider, cmd: string, min: string, probe: Probe): Promise<Found | null> {
  const out = await probe(cmd, ['--version']);
  if (out === null) return null;
  const version = versionIn(out);
  if (!version) return { agent };
  return below(version, min) ? { agent, version, tooOld: min } : { agent, version };
}

/** The agents that can start here, in the order Claude, Codex, omp. Claude counts by `claude` on PATH or its config folder. */
export async function detectAgents(env: NodeJS.ProcessEnv, probe: Probe = runVersion, exists: (p: string) => boolean = fs.existsSync,
  home: string = os.homedir()): Promise<Found[]> {
  const claude = async (): Promise<Found | null> => {
    const out = await probe('claude', ['--version']);
    if (out !== null) {
      const version = versionIn(out);
      return version ? { agent: 'claude', version } : { agent: 'claude' };
    }
    return exists(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude')) ? { agent: 'claude' } : null;
  };
  const found = await Promise.all([
    claude(),
    cli('codex', env.NOTA_BENE_CODEX ?? env.CODEX_CLI_PATH ?? 'codex', CODEX_MIN_VERSION, probe),
    cli('omp', env.NOTA_BENE_OMP ?? 'omp', OMP_MIN_VERSION, probe),
  ]);
  return found.filter((f): f is Found => f !== null);
}

/** The agent Enter takes: the one last used in the folder, else Claude, else the first found. */
export function defaultChoice(usable: AgentProvider[], last: AgentProvider | undefined): AgentProvider {
  if (last && usable.includes(last)) return last;
  return usable.includes('claude') ? 'claude' : usable[0]!;
}

/** An answer to the menu: empty (the default), a number from the menu or an agent's name; null for anything else. */
export function parseChoice(answer: string, usable: AgentProvider[], fallback: AgentProvider): AgentProvider | null {
  const a = answer.trim().toLowerCase();
  if (a === '') return fallback;
  if (/^\d+$/.test(a)) return usable[Number(a) - 1] ?? null;
  return usable.find((u) => u === a || LABEL[u].toLowerCase() === a) ?? null;
}

/** The menu's text: the usable agents numbered, the last used one marked, and why a found one is left out. */
export function menu(found: Found[], fallback: AgentProvider, last: AgentProvider | undefined): string {
  const name = (f: Found) => `${LABEL[f.agent]}${f.version ? ` ${f.version}` : ''}`;
  const usable = found.filter((f) => !f.tooOld).sort((a, b) => ORDER.indexOf(a.agent) - ORDER.indexOf(b.agent));
  const lines = ['Which agent for this folder?'];
  usable.forEach((f, i) => lines.push(`  ${i + 1}) ${name(f)}${f.agent === last && f.agent === fallback ? '  (last used here)' : ''}`));
  for (const f of found) if (f.tooOld) lines.push(`  ${name(f)} is too old: Nota Bene needs ${f.tooOld} or newer.`);
  return `${lines.join('\n')}\n`;
}

function read(base: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(path.join(base, FILE), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The agent last opened on `dir` (a real path), from the state root's agent-choice.json. */
export function lastAgent(base: string, dir: string): AgentProvider | undefined {
  const a = read(base)[dir];
  return typeof a === 'string' && (ORDER as string[]).includes(a) ? (a as AgentProvider) : undefined;
}

/** Records the agent opened on `dir`. Best effort: a launch never fails on it. */
export function rememberAgent(base: string, dir: string, agent: AgentProvider): void {
  try {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const file = path.join(base, FILE), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ...read(base), [dir]: agent }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* the choice is only a default for next time */ }
}
