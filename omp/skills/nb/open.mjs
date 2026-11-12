#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
export function parseInvocation(argv, env = process.env) {
  const o = { mode: 'last', dir: undefined, source: env.PI_SESSION_ID };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--dir', '--source'].includes(a)) {
      const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`Missing value for ${a}`);
      o[a.slice(2)] = v;
    } else if (['last', 'new', 'fork'].includes(a) && i === 0) o.mode = a;
    else throw new Error('Usage: open.mjs [new|fork] [--dir PATH] [--source SESSION_ID]');
  }
  if (o.mode === 'fork' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.source ?? '')) throw new Error('No valid source session id for fork. Pass --source or run from an omp session (PI_SESSION_ID).');
  return o;
}
/** always detached: the window outlives the omp turn that opened it, and Stop in the window ends it */
export function launchArgs(o) {
  return [...(o.dir ? [o.dir] : []), '--agent', 'omp', '--detach', ...(o.mode === 'new' ? ['--new'] : o.mode === 'fork' ? ['--resume', o.source, '--fork'] : [])];
}
const WIN = process.platform === 'win32';
/**
 * The launcher to run, as [command, ...args before the launch args]. NOTA_BENE_BIN, else bin/nota-bene.mjs of the checkout or
 * package this skill sits in, else `nota-bene` from PATH. A .mjs/.js runs with this node. Windows: a `nota-bene` on PATH is
 * npm's nota-bene.cmd shim, which Node cannot spawn without a shell: the .mjs it wraps runs with this node instead.
 */
export function launcherCommand(env = process.env, platform = process.platform) {
  const bundled = fileURLToPath(new URL('../../../bin/nota-bene.mjs', import.meta.url));
  let executable = env.NOTA_BENE_BIN ?? (fs.existsSync(bundled) ? bundled : 'nota-bene');
  if (executable === 'nota-bene' && platform === 'win32') executable = shimTarget(env) ?? executable;
  return /\.m?js$/i.test(executable) ? [process.execPath, executable] : [executable];
}
/** Windows: the JS entry of the first nota-bene.cmd on PATH (npm's shim names it as "%dp0%\...\nota-bene.mjs"), or null. */
function shimTarget(env) {
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const dir of pathVar.split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)) {
    const shim = path.join(dir, 'nota-bene.cmd');
    let text;
    try { text = fs.readFileSync(shim, 'utf8'); } catch { continue; }
    const named = /%~?dp0%?\\?([^"%]+\.m?js)"/i.exec(text)?.[1];
    for (const js of [named && path.join(dir, named), path.join(dir, 'node_modules', 'nota-bene-ide', 'bin', 'nota-bene.mjs')]) {
      if (js && fs.existsSync(js)) return js;
    }
  }
  return null;
}
/** Stops the launcher child: SIGTERM, or on Windows (no signals) taskkill of its tree. */
const stopChild = (child) => {
  if (!WIN) { child.kill('SIGTERM'); return; }
  if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
};
export const publicOutput = (text) => text.replace(/#t=[^\s"'<>]*/g, '');

async function main() {
  const o = parseInvocation(process.argv.slice(2));
  if (process.env.NOTA_BENE_SUPERVISED) throw new Error('Already inside Nota Bene; use the session controls in this window.');
  const [command, ...pre] = launcherCommand();
  const args = launchArgs(o);
  if (process.env.NOTA_BENE_FAKE) args.push('--fake', process.env.NOTA_BENE_FAKE);
  const child = spawn(command, [...pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  // Keep partial lines until complete so a token split between chunks cannot escape redaction.
  let reused = false;
  const relay = (stream, output) => {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i + 1); pending = pending.slice(i + 1);
        if (line.includes('already-open') || line.includes('already open')) reused = true;
        output.write(publicOutput(line));
      }
      if (pending.length > 65536) { pending = ''; stopChild(child); }
    });
    stream.on('end', () => { if (pending) output.write(publicOutput(pending)); });
  };
  relay(child.stdout, process.stdout); relay(child.stderr, process.stderr);
  const stop = () => stopChild(child);
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const code = await new Promise((resolve) => { child.on('error', () => { process.stderr.write('Cannot start Nota Bene. Install nota-bene-ide or set NOTA_BENE_BIN.\n'); resolve(1); }); child.on('exit', (c) => resolve(c ?? 1)); });
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
  if (reused && o.mode !== 'last') process.stdout.write(`The existing window was brought forward; ${o.mode} was not applied to its conversation. Use a new window after closing it, or its session controls.\n`);
  process.exitCode = code;
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) void main().catch((e) => { process.stderr.write(publicOutput(e.message) + '\n'); process.exitCode = 1; });
