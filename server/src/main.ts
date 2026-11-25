import fs from 'node:fs';
import os from 'node:os';
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
import { launchTarget } from './sessions.ts';
import { AGENT_ID, agentContext, serverStateDir } from './state.ts';
import { parseProvider, type AgentProvider } from './agent/provider.ts';
import { pidAlive, realpathNative, samePath } from './platform.ts';
import { packageVersion } from './version.ts';

const USAGE =
  'Usage: node server/src/main.ts [dir | --home] [--agent claude|codex|omp] [--port N] [--resume ID [--fork]] [--new] [--continue] [--fake script.json] [--id AGENT_ID] [--allow-origin URL]';

export function parseArgs(
  argv: string[],
  cwd: string,
): {
  dir: string; port: number; resume?: string; fork: boolean; new: boolean; continue: boolean; fake?: string; id?: string; home?: true; allowOrigins: string[]; agent?: AgentProvider;
} {
  let dirArg: string | undefined;
  let port = 4777;
  let resume: string | undefined;
  let cont = false;
  let fork = false;
  let fresh = false;
  let fake: string | undefined;
  let id: string | undefined;
  let home = false;
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
    else if (a === '--home') home = true; // no agent: the server's home page (the launcher's start with no folder)
    else if (a === '--id') id = value(++i); // the e2e fixtures: their page address is fixed in the Playwright config
    else if (a === '--allow-origin') allowOrigins.push(value(++i));
    else if (a.startsWith('--')) throw new Error(`${USAGE}\nUnknown option: ${a}`);
    else if (dirArg === undefined) dirArg = a;
    else throw new Error(`${USAGE}\nUnexpected argument: ${a}`);
  }
  if (home && (dirArg !== undefined || resume !== undefined || fresh || id !== undefined)) throw new Error(`${USAGE}\n--home opens no agent: it takes no folder, session or id`);
  const dir = fs.realpathSync.native(home ? os.homedir() : path.resolve(cwd, dirArg ?? '.'));
  if (fork && resume === undefined) throw new Error(`${USAGE}\n--fork needs --resume`);
  if (fresh && resume !== undefined) throw new Error(`${USAGE}\n--new cannot be combined with --resume`);
  if (id !== undefined && (!AGENT_ID.test(id) || !id.startsWith(`${agent ?? 'claude'}-`))) throw new Error(`${USAGE}\nInvalid agent id: ${id}`);
  return { dir, port, resume, fork, new: fresh, continue: cont, fake, ...(id ? { id } : {}), ...(home ? { home } : {}), allowOrigins, ...(agent ? { agent } : {}) };
}

/**
 * What to resume. An explicit --resume wins (with --fork it branches); --new starts fresh; otherwise (also with
 * --continue, which is the same thing) the project's last session, but only while its transcript still exists.
 */
export { launchTarget };

// `npm start -- ../proj` runs with cwd = package root; INIT_CWD is where npm was invoked.
export function invocationCwd(env: NodeJS.ProcessEnv, cwd: string): string {
  return env.INIT_CWD || cwd;
}

/** The startup log line that says which state dir this server uses (dev mode has its own). */
export function stateLine(): string {
  return `state: ${serverStateDir()}`;
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
  delete env.NOTA_BENE_PLUGIN_VERSION; // issue 457: that launcher's plugin, not ours
  return true;
}

/**
 * Issue 457: the /nb plugin version the launcher passed (bin/nota-bene.mjs pluginOriginEnv; '' is "not a plugin's"), taken out of
 * `env`: the agent and the `! cmd` runs spawned with this process's environment would otherwise pass it to a launcher they start.
 */
export function takePluginVersion(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.NOTA_BENE_PLUGIN_VERSION;
  delete env.NOTA_BENE_PLUGIN_VERSION;
  return v || undefined;
}

/** Epic 383: the launcher picked this window's port, so it may fold into a server below (fold.ts); taken out of `env`. */
export function takeFold(env: NodeJS.ProcessEnv): boolean {
  const v = env.NOTA_BENE_FOLD === '1';
  delete env.NOTA_BENE_FOLD;
  return v;
}

const FOLD_LOOK_MS = 30_000; // two quiet looks in a row: a window with no tab for about a minute folds in

async function main(): Promise<void> {
  dropInheritedLauncherEnv(process.env, process.ppid);
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2), invocationCwd(process.env, process.cwd()));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  process.env.NOTA_BENE_AGENT = args.agent ?? 'claude'; // child launches still read it
  const agent = agentContext(parseProvider(args.agent));
  // a backend per agent, as a window had its own (the ACP one keeps a session slot per instance)
  const backendFor = (p: AgentProvider) => (p === 'codex' ? codexBackend({ stateDir: agentContext(p).stateDir }) : p === 'omp' ? ompBackend() : sdkBackend());
  // --fake (the launcher's tests): every agent plays the same script
  const script = args.fake ? JSON.parse(fs.readFileSync(args.fake, 'utf8')) : undefined;
  const backends = script ? () => fakeFromScript(script, args.dir) : backendFor;
  const native = args.agent === 'codex' || args.agent === 'omp';
  // the launcher's launch nonce (public, but it stays out of the agent's and the `!` commands' environment all the same)
  const nonce = isNonce(process.env.NOTA_BENE_NONCE) ? process.env.NOTA_BENE_NONCE : undefined;
  delete process.env.NOTA_BENE_NONCE;
  const pluginVersion = takePluginVersion(process.env);
  const fold = takeFold(process.env);
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  // one pair for every Claude agent: each remembers the last reading, so a pair per agent would record the account's twice
  const claudeUsage = { onStats: limitRecorder(new UsageStore('claude')), onLimit: hitRecorder(new UsageStore('claude')) };
  let started: Awaited<ReturnType<typeof startServer>>;
  try {
    started = await startServer({
      cwd: args.dir,
      port: args.port,
      ...(args.id ? { id: args.id } : {}),
      ...(args.home ? { home: true } : {}),
      ...launchTarget({ ...args, native }, agent.stateDir),
      agent,
      backends,
      webDist,
      allowedOrigins: args.allowOrigins,
      ...(args.fake ? {} : { usage: (provider) => (provider === 'claude' ? claudeUsage : {}) }),
      ...(nonce ? { nonce } : {}),
      ...(pluginVersion ? { pluginVersion } : {}),
      audit: {},
      // only a launcher's window is in the registry the connector serves: one outside it (npm run dev, a test server) would
      // start a connector that finds no window and exits within a minute, again and again
      ...(process.env.NOTA_BENE_SUPERVISED === '1' ? { remote: remoteKeeper(), keep: { launcherPid: Number(process.env.NOTA_BENE_LAUNCHER_PID) }, ...(fold ? { fold: { everyMs: FOLD_LOOK_MS } } : {}) } : {}),
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
  const version = packageVersion(); // none: a connector of another one is then not replaced
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
