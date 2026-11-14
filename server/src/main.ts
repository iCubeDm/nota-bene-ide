import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretError, isNonce } from './auth.ts';
import { fakeFromScript } from './agent/fake.ts';
import { codexBackend } from './agent/codex/backend.ts';
import { ompBackend } from './agent/acp/omp.ts';
import { sdkBackend } from './agent/claude/sdk.ts';
import { RemoteKeeper } from './remote/keeper.ts';
import { startServer } from './server.ts';
import { HANDOVER } from './updater.ts';
import { hitRecorder, limitRecorder } from './usage/routes.ts';
import { UsageStore } from './usage/store.ts';
import { transcriptExists } from './sessions.ts';
import { lastSession, stateDir } from './state.ts';
import { parseProvider, type AgentProvider } from './agent/provider.ts';
import { pidAlive, realpathNative, samePath } from './platform.ts';

const USAGE =
  'Usage: node server/src/main.ts [dir] [--agent claude|codex|omp] [--port N] [--resume ID [--fork]] [--new] [--continue] [--fake script.json] [--allow-origin URL]';

export function parseArgs(
  argv: string[],
  cwd: string,
): {
  dir: string; port: number; resume?: string; fork: boolean; new: boolean; continue: boolean; fake?: string; allowOrigins: string[]; agent?: AgentProvider;
} {
  let dirArg: string | undefined;
  let port = 4777;
  let resume: string | undefined;
  let cont = false;
  let fork = false;
  let fresh = false;
  let fake: string | undefined;
  let agent: AgentProvider | undefined;
  const allowOrigins: string[] = [];
  const value = (i: number): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${USAGE}\nMissing value for ${argv[i - 1]}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') {
      const v = value(++i);
      if (!/^\d+$/.test(v) || Number(v) > 65535) throw new Error(`${USAGE}\nInvalid port: ${v}`);
      port = Number(v);
    } else if (a === '--agent') agent = parseProvider(value(++i));
    else if (a === '--resume') resume = value(++i);
    else if (a === '--continue') cont = true;
    else if (a === '--fork') fork = true;
    else if (a === '--new') fresh = true;
    else if (a === '--fake') fake = path.resolve(cwd, value(++i)); // same base as the project dir
    else if (a === '--allow-origin') allowOrigins.push(value(++i));
    else if (a.startsWith('--')) throw new Error(`${USAGE}\nUnknown option: ${a}`);
    else if (dirArg === undefined) dirArg = a;
    else throw new Error(`${USAGE}\nUnexpected argument: ${a}`);
  }
  const dir = fs.realpathSync.native(path.resolve(cwd, dirArg ?? '.'));
  if (fork && resume === undefined) throw new Error(`${USAGE}\n--fork needs --resume`);
  if (fresh && resume !== undefined) throw new Error(`${USAGE}\n--new cannot be combined with --resume`);
  return { dir, port, resume, fork, new: fresh, continue: cont, fake, allowOrigins, ...(agent ? { agent } : {}) };
}

/**
 * What to resume. An explicit --resume wins (with --fork it branches); --new starts fresh; otherwise (also with
 * --continue, which is the same thing) the project's last session, but only while its transcript still exists.
 */
export function launchTarget(
  args: Pick<ReturnType<typeof parseArgs>, 'dir' | 'resume' | 'fork' | 'new'>,
  projectsDir?: string,
): { resume?: string; fork?: boolean } {
  if (args.resume !== undefined) return { resume: args.resume, ...(args.fork ? { fork: true } : {}) };
  if (args.new) return {};
  const last = lastSession(args.dir);
  return last && transcriptExists(last, projectsDir) ? { resume: last } : {};
}

// `npm start -- ../proj` runs with cwd = package root; INIT_CWD is where npm was invoked.
export function invocationCwd(env: NodeJS.ProcessEnv, cwd: string): string {
  return env.INIT_CWD || cwd;
}

/** The startup log line that says which state dir this server uses (dev mode has its own). */
export function stateLine(): string {
  return `state: ${stateDir()}`;
}

/** Exit code for a failed listen (port taken): the launcher retries its first start on another port. */
export const LISTEN_FAILED = 98;
export const NO_AGENT_BINARY = 76; // bin/nota-bene.mjs: no relaunch
export { HANDOVER }; // updater.ts: a newer version is current, the launcher hands the window over (only with NOTA_BENE_HANDOVER=1)
/** The launcher's "stop as on SIGTERM" over the IPC channel (bin/nota-bene.mjs STOP_MESSAGE): Windows has no signals to send. */
export const STOP_MESSAGE = 'nota-bene:stop';

/**
 * The launcher's env vars are ours only if that launcher is our parent right now. Anything started from a shell inside
 * a window (e2e, npm start, npm run dev, an agent's own test server) inherits them from the window's server; trusting
 * them would make it watch someone else's launcher and stop at once, and claim to be supervised. Drop them then.
 */
export function dropInheritedLauncherEnv(env: NodeJS.ProcessEnv, ppid: number): boolean {
  const pid = Number(env.NOTA_BENE_LAUNCHER_PID);
  if (env.NOTA_BENE_LAUNCHER_PID === undefined || pid === ppid) return false;
  delete env.NOTA_BENE_LAUNCHER_PID;
  delete env.NOTA_BENE_SUPERVISED;
  delete env.NOTA_BENE_NONCE; // that launcher's launch, not ours
  delete env.NOTA_BENE_HANDOVER; // nobody would hand us over
  delete env.NOTA_BENE_UPDATED_FROM;
  return true;
}

async function main(): Promise<void> {
  dropInheritedLauncherEnv(process.env, process.ppid);
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2), invocationCwd(process.env, process.cwd()));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  process.env.NOTA_BENE_AGENT = args.agent ?? 'claude';
  const backend = args.fake
    ? fakeFromScript(JSON.parse(fs.readFileSync(args.fake, 'utf8')), args.dir)
    : args.agent === 'codex' ? codexBackend() : args.agent === 'omp' ? ompBackend() : sdkBackend();
  const native = args.agent === 'codex' || args.agent === 'omp';
  // the launcher's launch nonce (public, but it stays out of the agent's and the `!` commands' environment all the same)
  const nonce = isNonce(process.env.NOTA_BENE_NONCE) ? process.env.NOTA_BENE_NONCE : undefined;
  delete process.env.NOTA_BENE_NONCE;
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  let started: Awaited<ReturnType<typeof startServer>>;
  try {
    started = await startServer({
      cwd: args.dir,
      port: args.port,
      backend,
      ...(native ? (args.resume ? { resume: args.resume, ...(args.fork ? { fork: true } : {}) } : !args.new && lastSession(args.dir) ? { resume: lastSession(args.dir)! } : {}) : launchTarget(args)),
      webDist,
      allowedOrigins: args.allowOrigins,
      ...(!native && !args.fake ? { onStats: limitRecorder(new UsageStore('claude')), onLimit: hitRecorder(new UsageStore('claude')) } : {}),
      ...(nonce ? { nonce } : {}),
      audit: {},
      // only a launcher's window is in the registry the connector serves: one outside it (npm run dev, a test server) would
      // start a connector that finds no window and exits within a minute, again and again
      ...(process.env.NOTA_BENE_SUPERVISED === '1' ? { remote: remoteKeeper() } : {}),
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).syscall !== 'listen') throw e;
    console.error(`Nota Bene: cannot listen on 127.0.0.1:${args.port}: ${(e as Error).message}`);
    process.exit(LISTEN_FAILED);
  }
  const { url, close } = started;
  console.log(`Nota Bene: ${url}  project: ${args.dir}`);
  console.log(stateLine());
  const stop = () => {
    close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  // SIGHUP (the terminal closed) and SIGQUIT end the process by default without running anything: stop through close(), so a
  // `! cmd` run's process group goes with us
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) process.on(sig, stop);
  watchLauncher(process.env.NOTA_BENE_LAUNCHER_PID, stop);
}

type Channel = { channel?: unknown; once(e: 'disconnect', f: () => void): unknown; on(e: 'message', f: (m: unknown) => void): unknown };

/**
 * Under the launcher: once it is gone (SIGKILLed, or its Claude Code background task killed hard), nobody would stop us,
 * so close and exit, with a hard exit if the close hangs. The launcher spawns us with an IPC channel, which the OS closes
 * however the launcher ends ('disconnect'); it also carries the launcher's STOP_MESSAGE (Windows: no signals). Without
 * the channel (a launcher of an older version) the launcher is polled: gone once we are reparented (POSIX) or its pid is
 * dead (Windows never reparents).
 */
export function watchLauncher(launcherPid: string | undefined, stop: () => void, everyMs = 2000, proc: Channel = process): void {
  const pid = Number(launcherPid);
  if (!launcherPid || !Number.isInteger(pid) || pid <= 0) return;
  const gone = () => {
    console.error(`Nota Bene: the launcher (pid ${pid}) is gone — stopping`);
    setTimeout(() => process.exit(0), 3000).unref();
    stop();
  };
  if (proc.channel) {
    proc.once('disconnect', gone);
    proc.on('message', (m) => { if (m === STOP_MESSAGE) stop(); });
    return;
  }
  const timer = setInterval(() => {
    if (process.ppid === pid && pidAlive(pid)) return;
    clearInterval(timer);
    gone();
  }, everyMs);
  timer.unref();
}

const self = fileURLToPath(import.meta.url);

/** The window's remote-access keeper: it starts the package's own launcher (`bin/nota-bene.mjs remote --managed`), here and in
 * the package bundle alike two folders above this file, and tells the connector the package version. */
function remoteKeeper(): RemoteKeeper {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  let version: string | undefined;
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { version?: unknown }).version;
    if (typeof v === 'string' && v) version = v;
  } catch { /* no version: a connector of another one is then not replaced */ }
  return new RemoteKeeper({ entry: path.join(repo, 'bin', 'nota-bene.mjs'), ...(version ? { version } : {}) });
}
if (process.argv[1] && samePath(realpathNative(process.argv[1]), realpathNative(self))) {

  // TEST-ONLY: bin/nota-bene.test.ts injects exit loops with it: exit with this code (1 = crash, 75 = restart) before
  // anything starts. Never set it otherwise.
  if (process.env.NOTA_BENE_TEST_CRASH) process.exit(Number(process.env.NOTA_BENE_TEST_CRASH) || 1);
  main().catch((e) => {
    if (e instanceof SecretError) {
      console.error(`Nota Bene: ${e.message}`); // one clear line, not a stack: the user has to fix a file
      process.exit(1);
    }
    if (e instanceof Error && /^Native CLI binary .* not found/.test(e.message)) { // the SDK's word for a missing optional binary
      console.error('Nota Bene: this install has no Claude Code binary (it was installed with --omit=optional). Reinstall without that flag, or start a Codex window with --agent codex.');
      process.exit(NO_AGENT_BINARY);
    }
    console.error(e);
    process.exit(1);
  });
}
