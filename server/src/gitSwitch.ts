import { execFile } from 'node:child_process';
import type { GitSwitchError } from '@nota-bene/shared';
import { gitEnv } from './files.ts';
import { forgetRepo, repo } from './git.ts';
import { holders } from './vcs.ts';

/**
 * The window's one git write (#285): this checkout switches to another local branch when the user asks. The name must
 * be one of git's own local branches (never a ref, `-` or `@{-1}` from the page); it goes after `--` with `--no-guess`
 * and nothing forces it, so git itself refuses local changes it would overwrite and a branch another worktree has.
 * Refused while an agent of a Nota Bene window works in this checkout: the switch would change files under its turn.
 */

const TIMEOUT = 5_000;
const LINES = 12;

/** status: what the route answers; code: what the page translates; detail: git's own words for 'git'. */
export class SwitchRefused extends Error {
  readonly status: 400 | 404 | 409 | 503;
  readonly code: GitSwitchError;
  readonly detail?: string;
  constructor(status: 400 | 404 | 409 | 503, code: GitSwitchError, detail?: string) {
    super(detail ?? code);
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** git's refusal without its noise: no hints, no "Aborting", no blank lines; at most 12 lines. */
export function gitWords(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() && !/^hint:/.test(l) && l.trim() !== 'Aborting');
  return lines.slice(0, LINES).join('\n');
}

function run(cwd: string, branch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['switch', '--no-guess', '--', branch], { cwd, env: gitEnv(), timeout: TIMEOUT, encoding: 'utf8', windowsHide: true }, (err, _out, stderr) => {
      if (!err) return resolve();
      if (err.killed) return reject(new SwitchRefused(503, 'timeout'));
      reject(new SwitchRefused(409, 'git', gitWords(stderr) || err.message));
    });
  });
}

/**
 * Switches `root`'s checkout to the local branch `branch`. `working`: the roots of the busy Nota Bene windows;
 * `selfBusy`: this window's agent. Answers the branch it left (null: detached) and the new one; SwitchRefused otherwise.
 */
export async function switchBranch(
  root: string,
  branch: string,
  o: { selfBusy: () => boolean; working: () => Promise<string[]> },
): Promise<{ from: string | null; branch: string }> {
  forgetRepo(root); // the list the name is checked against is git's of now, not of 5 s ago
  const { top, sources, checkouts } = await repo(root);
  if (!top) throw new SwitchRefused(404, 'not-a-repo');
  const here = sources[0]!;
  const local = sources.filter((s) => s.id.startsWith('ref:')).map((s) => s.ref);
  if (here.ref) local.push(here.ref);
  if (!local.includes(branch)) throw new SwitchRefused(404, 'unknown-branch');
  const from = here.ref || null;
  if (branch === from) return { from, branch };
  // the deepest checkout holding each busy window: an agent in a worktree inside the project does not hold this one
  if (o.selfBusy() || holders(checkouts, await o.working().catch(() => [])).has(checkouts[0]!)) throw new SwitchRefused(409, 'busy');
  try {
    await run(root, branch);
  } finally {
    forgetRepo(root);
  }
  return { from, branch };
}
