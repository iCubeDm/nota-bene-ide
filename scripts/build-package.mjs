#!/usr/bin/env node
// Builds the publishable npm package into pkg/ (git-ignored): a compiled server and launcher, a FRESH web build, the
// blend assets, LICENSE, THIRD-PARTY-NOTICES, README and a generated package.json. It never publishes anything.
//
//   node scripts/build-package.mjs [--out DIR] [--skip-web]
//
// Why esbuild, one bundle per entry, same directory depth as the checkout: Node refuses to strip types under
// node_modules, so the server cannot ship as .ts. The code finds its files through `import.meta` relative lookups
// (main.ts -> ../../web/dist, server.ts -> repoDir two levels up, blend.ts -> ./blend/*, the launcher -> ../server/src/main):
// bundling server/src/main.ts to pkg/server/src/main.js and bin/nota-bene.mjs to pkg/bin/nota-bene.mjs keeps every one of
// them true with no change to the lookups. `@nota-bene/shared` is a workspace package, so it is inlined; the real runtime
// dependencies stay external and are installed by npm.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { HIDDEN, npxSpec } from '../server/src/platform.ts';

/** The published name. One constant: it may still change. The command it installs is BIN. */
export const PACKAGE_NAME = 'nota-bene-ide';
export const BIN = 'nota-bene';
/**
 * The Node floor. The compiled code needs `import.meta.dirname` (20.11) and fetch / AbortSignal.timeout (18); 22 is the
 * oldest line still supported upstream and the oldest this was run on (22.23, 26.12), so it is the floor we promise.
 */
export const NODE_RANGE = '>=22';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rootJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const serverJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/package.json'), 'utf8'));

/** The runtime dependencies: the server's own, without the inlined workspace package. Exact versions only. */
export function runtimeDependencies() {
  const deps = Object.fromEntries(Object.entries(serverJson.dependencies).filter(([n]) => n !== '@nota-bene/shared'));
  for (const [n, v] of Object.entries(deps)) if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`dependency ${n}@${v} is not an exact version`);
  return deps;
}

export function packageJson() {
  if (!rootJson.version) throw new Error('package.json has no version (the single source of the published version)');
  return {
    name: PACKAGE_NAME,
    version: rootJson.version,
    description: 'A browser agentic development environment (ADE) over Claude Code, Codex and omp: agent chat, inline margin comments sent as one batch, a file tree and viewers.',
    license: 'Apache-2.0',
    repository: { type: 'git', url: 'git+https://github.com/iCubeDm/nota-bene-ide.git' },
    type: 'module',
    bin: { [BIN]: 'bin/nota-bene.mjs' },
    files: ['bin/nota-bene.mjs', 'server/src/main.js', 'server/src/host.js', 'server/src/remote/cli.js', 'server/src/blend', 'server/src/dictation', 'web/dist', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'codex/skills/nb', 'omp/skills/nb'],
    engines: { node: NODE_RANGE },
    dependencies: runtimeDependencies(),
    keywords: ['claude', 'claude-code', 'codex', 'omp', 'ide', 'agent'],
  };
}

/**
 * Makes `out` an empty directory. A missing or empty one is fine; a non-empty one must be a previous build of this package
 * (its package.json names PACKAGE_NAME) and goes to the Trash (the Recycle Bin on Windows), never rmSync; anything else is
 * refused, so a wrong --out can never wipe a checkout or a home directory.
 */
export function prepareOut(out) {
  if (fs.existsSync(out)) {
    if (!fs.statSync(out).isDirectory()) throw new Error(`${out} exists and is not a directory`);
    if (fs.readdirSync(out).length > 0) {
      let name;
      try { name = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')).name; } catch { /* not a build */ }
      if (name !== PACKAGE_NAME) throw new Error(`refusing to build into ${out}: it is not empty and is not a previous ${PACKAGE_NAME} build`);
      const r = toTrash(out);
      if (r.status !== 0 || fs.existsSync(out)) throw new Error(`could not move the previous build ${out} to the Trash (${r.error?.message ?? `${r.tool} exit code ${r.status}`})`);
    }
  }
  fs.mkdirSync(out, { recursive: true });
}

/**
 * Moves `dir` to the Trash. macOS and Linux: the `trash` command. Windows has none: Windows PowerShell (always there) sends it
 * to the Recycle Bin through .NET's FileSystem.DeleteDirectory, the path passed in the environment so nothing is quoted.
 */
function toTrash(dir) {
  if (process.platform !== 'win32') return { ...spawnSync('trash', [dir], { stdio: 'pipe' }), tool: 'trash' };
  const script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:NB_TRASH_DIR, 'OnlyErrorDialogs', 'SendToRecycleBin')";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe', env: { ...process.env, NB_TRASH_DIR: dir }, ...HIDDEN });
  return { ...r, tool: 'powershell' };
}

export async function buildPackage({ out = path.join(ROOT, 'pkg'), skipWeb = false } = {}) {
  prepareOut(out);

  const external = Object.keys(runtimeDependencies());
  const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', external, logLevel: 'warning', legalComments: 'none' };
  await build({ ...common, entryPoints: [path.join(ROOT, 'server/src/main.ts')], outfile: path.join(out, 'server/src/main.js') });
  await build({ ...common, entryPoints: [path.join(ROOT, 'server/src/remote/cli.ts')], outfile: path.join(out, 'server/src/remote/cli.js') });
  // the Whisper host: the process a window starts so that all windows share one model (server/src/dictation/hostClient.ts:
  // hostEntryFile looks for host.js beside the server bundle). At server/src/, like main.js, so that its dictationAssetDir()
  // finds pipelineWorker.mjs in server/src/dictation/ the same way.
  await build({ ...common, entryPoints: [path.join(ROOT, 'server/src/dictation/hostEntry.ts')], outfile: path.join(out, 'server/src/host.js') });
  await build({ ...common, entryPoints: [path.join(ROOT, 'bin/nota-bene.mjs')], outfile: path.join(out, 'bin/nota-bene.mjs') });
  fs.chmodSync(path.join(out, 'bin/nota-bene.mjs'), 0o755);

  fs.mkdirSync(path.join(out, 'server/src/blend'), { recursive: true });
  for (const f of ['export.py', 'sandbox.sb']) fs.copyFileSync(path.join(ROOT, 'server/src/blend', f), path.join(out, 'server/src/blend', f));
  // Whisper on the host: the worker thread's entry (plain JS, run as is) and the lockfile `npm ci` installs from; the
  // bundled server and host.js find them beside themselves (server/src/dictation/pipelineHost.ts: dictationAssetDir)
  fs.mkdirSync(path.join(out, 'server/src/dictation'), { recursive: true });
  for (const f of ['pipelineWorker.mjs', 'npm-shrinkwrap.json']) fs.copyFileSync(path.join(ROOT, 'server/src/dictation', f), path.join(out, 'server/src/dictation', f));
  fs.cpSync(path.join(ROOT, 'codex/skills/nb'), path.join(out, 'codex/skills/nb'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'omp/skills/nb'), path.join(out, 'omp/skills/nb'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(out, 'CHANGELOG.md'));
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(out, 'LICENSE'));
  fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(out, 'README.md'));
  fs.copyFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), path.join(out, 'THIRD-PARTY-NOTICES.md'));

  if (skipWeb) fs.mkdirSync(path.join(out, 'web/dist'), { recursive: true }); // tests: they put their own index.html in
  else {
    // web/vite.config.ts keeps old chunks in web/dist on purpose (a reloading page asks for them); the package gets its own
    // outDir, emptied, so it holds the current build only. The local web/dist is not touched.
    const npx = npxSpec(['vite', 'build', '--outDir', path.join(out, 'web/dist'), '--emptyOutDir']);
    const r = spawnSync(npx.command, npx.args, { cwd: path.join(ROOT, 'web'), stdio: 'inherit', windowsVerbatimArguments: npx.windowsVerbatimArguments, ...HIDDEN });
    if (r.status !== 0) throw new Error(`vite build failed (${r.error?.message ?? `exit code ${r.status}`})`);
  }

  fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(packageJson(), null, 2)}\n`);
  return out;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  if (i >= 0 && (argv[i + 1] === undefined || argv[i + 1] === '' || argv[i + 1].startsWith('--'))) {
    console.error('--out needs a directory');
    process.exit(2);
  }
  const out = i >= 0 ? path.resolve(argv[i + 1]) : undefined;
  buildPackage({ ...(out ? { out } : {}), skipWeb: argv.includes('--skip-web') }).then(
    (dir) => console.log(`package built in ${dir}`),
    (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); },
  );
}
