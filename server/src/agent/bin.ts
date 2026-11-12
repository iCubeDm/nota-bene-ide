// How an agent CLI (codex, omp, an ACP agent) is spawned. POSIX: the name as given, exactly as before (spawn's own PATH
// lookup, a script runs by its shebang). Windows: resolved through PATHEXT (`codex` is `codex.cmd`), a `.cmd` shim through
// cmd.exe (platform.ts spawnSpec), a `.js`/`.mjs`/`.cjs` script through this Node, and the Codex npm shim replaced by the
// native codex.exe it would start anyway. Plain TS on node and platform.ts only: the launcher imports choice.ts, which uses it.
import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HIDDEN, killTree, resolveBin, spawnSpec, type SpawnSpec } from '../platform.ts';

type Env = Record<string, string | undefined>;
type Opts = { env?: Env; platform?: NodeJS.Platform; arch?: string; execPath?: string };

/** `spawn(s.command, s.args, { env: { ...env, ...s.env }, windowsVerbatimArguments: s.windowsVerbatimArguments })` */
export type AgentSpawn = SpawnSpec & { env?: Record<string, string> };

const TRIPLE: Record<string, string> = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };
const isFile = (p: string): boolean => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

/**
 * The native codex.exe behind the npm shim `shim` (`codex.cmd`), or null when the shim does not start @openai/codex.
 * The shim runs `node …\@openai\codex\bin\codex.js`, which only finds and spawns
 * `@openai/codex-win32-<arch>/vendor/<triple>/bin/codex.exe` (nested in the package or hoisted beside it; older
 * releases: the package's own `vendor/`). Spawning the .exe directly skips cmd.exe and a Node process in between, so
 * a tree kill and stdio reach codex itself. `root`: the package folder, for the env codex.js would set.
 */
export function codexVendored(shim: string, arch: string = process.arch): { exe: string; root: string; pnpm: boolean } | null {
  const triple = TRIPLE[arch];
  if (!triple) return null;
  let text: string;
  try { text = fs.readFileSync(shim, 'utf8'); } catch { return null; }
  const m = /"%(?:~dp0|dp0)%?\\?([^"%]*?@openai\\codex)\\bin\\codex\.js"/i.exec(text);
  if (!m) return null;
  const root = path.join(path.dirname(shim), ...m[1]!.split('\\'));
  const pkg = `codex-win32-${arch}`;
  for (const vendor of [
    path.join(root, 'node_modules', '@openai', pkg, 'vendor'),
    path.join(root, '..', pkg, 'vendor'), // hoisted: node_modules/@openai/codex-win32-<arch>
    path.join(root, 'vendor'),
  ]) {
    const exe = path.join(vendor, triple, 'bin', 'codex.exe');
    if (isFile(exe)) return { exe: path.normalize(exe), root: path.normalize(root), pnpm: m[1]!.includes('.pnpm') };
  }
  return null;
}

/** How to spawn the agent CLI `cmd` (a name on PATH or a path) with `args`; see the header. An unresolvable name stays
 *  as given, so the spawn fails with ENOENT and the caller's install hint. */
export function agentSpawn(cmd: string, args: readonly string[], { env = process.env, platform = process.platform, arch = process.arch, execPath = process.execPath }: Opts = {}): AgentSpawn {
  if (platform !== 'win32') return { command: cmd, args: [...args] };
  const file = resolveBin(cmd, { env, platform }) ?? (isFile(cmd) ? cmd : null);
  if (!file) return { command: cmd, args: [...args] };
  const ext = path.win32.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { command: execPath, args: [file, ...args] };
  if (ext === '.cmd' || ext === '.bat') {
    const codex = codexVendored(file, arch);
    // what codex.js sets for the binary (its update hint names the package manager)
    if (codex) return { command: codex.exe, args: [...args], env: { CODEX_MANAGED_PACKAGE_ROOT: codex.root, [codex.pnpm ? 'CODEX_MANAGED_BY_PNPM' : 'CODEX_MANAGED_BY_NPM']: '1' } };
  }
  return spawnSpec(file, args, platform);
}

/**
 * The stdout of a short agent CLI call (`--version`, `session lease`), or null when it cannot start, fails or runs past
 * `timeoutMs`. POSIX: execFile's own timeout (SIGTERM to the CLI). Windows: the tree is killed, since the CLI may sit
 * behind cmd.exe and a Node shim that a kill of the direct child would leave running.
 */
export function agentOutput(cmd: string, args: readonly string[], timeoutMs: number, opts: Opts = {}): Promise<string | null> {
  const win = (opts.platform ?? process.platform) === 'win32';
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess;
    try {
      const run = agentSpawn(cmd, args, opts);
      const env = opts.env ?? process.env;
      child = execFile(run.command, run.args, {
        timeout: win ? 0 : timeoutMs, windowsVerbatimArguments: run.windowsVerbatimArguments, ...HIDDEN, env: run.env ? { ...env, ...run.env } : env,
      }, (error, stdout) => { clearTimeout(timer); resolve(error ? null : stdout); });
    } catch {
      return resolve(null); // a file Windows cannot run (EFTYPE), a bad argument
    }
    if (win) timer = setTimeout(() => { if (child.pid) killTree(child.pid); }, timeoutMs);
  });
}
