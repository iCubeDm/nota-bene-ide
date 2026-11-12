import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ShellStop } from '@nota-bene/shared';
import type { EmitInput } from '../hub.ts';
import { HIDDEN, isWindows, killTree, pathKey, pidAlive, resolveBin, type SpawnSpec } from '../platform.ts';
import { readPrefs, type ShellChoice } from '../prefs.ts';
import { AGENT_STREAM_CAP, AnsiStripper, OutputDecoder, Tail, bashBlock, codePageDecoder, isSlashCommand, leadOf, shellEnv } from './shellText.ts';

/** a command that runs longer is stopped, with the reason shown */
export const SHELL_TIMEOUT_MS = 10 * 60_000;
/** after TERM, the process group gets this long before KILL */
export const SHELL_KILL_MS = 3000;
/** after the shell exits, a background child that still holds the pipes does not hold the block open longer than this */
const PIPE_GRACE_MS = 300;
/** the output goes to the sockets at most this often: one frame of the tail per tick, however much the command prints */
export const SHELL_FLUSH_MS = 100;
/** how many finished runs wait for the agent's next message; the oldest go first */
const QUEUE_MAX = 10;
/** shells that take `-lc -- cmd` like sh does (fish is left out: that form is untested there); any other $SHELL (csh, tcsh, fish, nologin, false) is not used, /bin/sh runs the command */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** how often a group that was sent TERM is looked at: once it is empty the KILL is cancelled, its id may be reused */
const POLL_MS = 150;

type Run = {
  id: string; cmd: string; child?: ChildProcess;
  out: Tail; err: Tail; all: Tail; ansiOut: AnsiStripper; ansiErr: AnsiStripper;
  /** Windows: the bytes of each stream as text (see OutputDecoder); elsewhere the streams are read as UTF-8 */
  decOut?: OutputDecoder; decErr?: OutputDecoder;
  /** the Windows shell that runs it: the block shows it, the agent hears it when it is not bash */
  shell?: WinShell;
  /** Git Bash: its bash.exe, and the value of MARK_VAR its processes inherit (see msysKill) */
  bash?: string; mark?: string;
  stop?: ShellStop | 'switch';
  /** a switch, a /clear or a close stopped it: it says nothing more to the feed and leaves nothing for the agent */
  quiet: boolean;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  error?: string;
  timers: ReturnType<typeof setTimeout>[];
  /** the KILL that follows a TERM: it outlives the run's end, a child that ignored TERM must not be left behind */
  killTimer?: ReturnType<typeof setTimeout>;
  /** polls whether the group is gone, to cancel the KILL (a pgid may be recycled) */
  poll?: ReturnType<typeof setInterval>;
  /** a flush of the output is scheduled */
  flush?: ReturnType<typeof setTimeout>;
  done: boolean;
};

type Options = {
  /** true: a lossy frame was skipped for some socket, so the same state is sent again at the next tick */
  emit: (ev: EmitInput, o?: { store?: boolean; lossy?: boolean }) => boolean | void;
  /** the project folder now (it moves with a switch) */
  root: () => string;
  report: (where: string, e: unknown) => void;
  /** tests shorten the timeout and the kill delay, and stub the environment */
  timeoutMs?: number;
  killMs?: number;
  env?: () => NodeJS.ProcessEnv;
  /** Windows: the shell setting (Settings → Defaults), read for every run; tests pick one */
  shell?: () => ShellChoice;
};

// every live process group is killed when this process exits, however it exits (exitWith, a signal handler, a crash handler
// that calls process.exit): a command must not outlive the server. Only a SIGKILL of the server itself is beyond this.
/**
 * `stream.on('data', on)`; on Windows the stream also lets the event loop go round after each chunk. There libuv reads a
 * pipe in a loop for as long as it holds data: with a command that prints without end (`yes`) and a reader a little slower
 * than it, that loop never returns, so no timer (the frames, the run's timeout, the KILL) and no socket (Stop) is served
 * until it ends. A pause until the next turn of the loop breaks it; the command waits at most that long. POSIX reads a
 * bounded number of times per turn already: unchanged there.
 */
export function onData(stream: NodeJS.ReadableStream, on: (c: string | Buffer) => void): void {
  if (!isWindows()) { stream.on('data', on); return; }
  let held = false;
  stream.on('data', (c: string | Buffer) => {
    on(c);
    if (held) return;
    held = true;
    stream.pause();
    setImmediate(() => { held = false; stream.resume(); });
  });
}

const live = new Set<Run>();
let exitHooked = false;
function killAllOnExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const r of live) signalGroup(r, 'SIGKILL', true);
  });
}

function signalGroup(r: Run, sig: NodeJS.Signals | 0, sync = !r.exit): boolean {
  const pid = r.child?.pid;
  if (pid === undefined) return false;
  if (isWindows()) {
    // no process groups and no signals: the tree under the shell is killed hard (taskkill /T /F) while the shell lives; once it
    // has exited its pid may be reused. Git Bash's processes are not all in that tree (an MSYS fork's Windows parent exits on
    // its exec): they go by the run's mark, also after the shell is gone, the mark being this run's alone; taskkill only when
    // that could not run.
    if (sig === 0) return !r.exit && pidAlive(pid);
    const viaMsys = !!r.mark && !!r.bash && msysKill(r.bash, r.mark, sync);
    if (r.exit || !pidAlive(pid)) return false;
    if (!viaMsys) killTree(pid);
    return true;
  }
  try {
    process.kill(-pid, sig); // the group the child leads (spawn detached): its own children go with it
    return true;
  } catch {
    return false; // gone already
  }
}

const shellPath = (): string => {
  const s = process.env.SHELL;
  if (s && s.startsWith('/') && SHELLS.has(path.basename(s))) {
    try {
      fs.accessSync(s, fs.constants.X_OK);
      return s;
    } catch { /* fall through */ }
  }
  return '/bin/sh';
};

/** A Windows shell for `! cmd` (Settings → Defaults); `auto` takes the first of Git Bash, PowerShell 7, Windows PowerShell. */
export type WinShell = Exclude<ShellChoice, 'auto'>;
export const WIN_SHELL_NAMES: Record<WinShell, string> = { 'git-bash': 'Git Bash', pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'cmd' };
const AUTO_ORDER: readonly WinShell[] = ['git-bash', 'pwsh', 'powershell'];

type Env = Record<string, string | undefined>;
const envGet = (env: Env, name: string): string | undefined => env[Object.keys(env).find((k) => k.toUpperCase() === name) ?? name];
const isFile = (p: string): boolean => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};
const systemRoot = (env: Env): string => envGet(env, 'SYSTEMROOT') || 'C:\\Windows';

/**
 * Git Bash: CLAUDE_CODE_GIT_BASH_PATH (the variable Claude Code reads for its own Bash tool), else `bin\bash.exe` of the Git
 * install the `git.exe` on PATH belongs to (`<git>\cmd\git.exe`, `<git>\bin\git.exe`, `<git>\mingw64\bin\git.exe`). Never a
 * `bash.exe` found on PATH: the one in System32 and the WindowsApps alias start WSL.
 */
export function gitBashPath(env: Env = process.env): string | null {
  const own = envGet(env, 'CLAUDE_CODE_GIT_BASH_PATH');
  if (own && isFile(own)) return own;
  const git = resolveBin('git', { env, platform: 'win32' });
  if (!git) return null;
  const dir = path.win32.dirname(git);
  const sys = pathKey(path.win32.join(systemRoot(env), 'System32'), 'win32');
  for (const up of ['.', '..', '..\\..']) {
    const p = path.win32.join(dir, up, 'bin', 'bash.exe');
    if (!pathKey(p, 'win32').startsWith(`${sys}\\`) && isFile(p)) return p;
  }
  return null;
}

/** Where each shell of the setting is on this Windows machine; null: not installed. Pure stat checks, nothing is spawned. */
export function winShells(env: Env = process.env): Record<WinShell, string | null> {
  const ps51 = path.win32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const comspec = envGet(env, 'COMSPEC');
  const cmd = comspec && isFile(comspec) ? comspec : path.win32.join(systemRoot(env), 'System32', 'cmd.exe');
  return {
    'git-bash': gitBashPath(env),
    pwsh: resolveBin('pwsh', { env, platform: 'win32' }),
    powershell: isFile(ps51) ? ps51 : null,
    cmd: isFile(cmd) ? cmd : null,
  };
}

/** The shell a run takes with this setting, or the one it names that is not installed: an explicit choice has no fallback. */
export function pickWinShell(choice: ShellChoice, found: Record<WinShell, string | null>): { shell: WinShell; file: string } | { missing: WinShell } {
  if (choice !== 'auto') {
    const file = found[choice];
    return file ? { shell: choice, file } : { missing: choice };
  }
  for (const s of AUTO_ORDER) {
    const file = found[s];
    if (file) return { shell: s, file };
  }
  return { missing: 'powershell' }; // every Windows 10/11 has it: only a broken system gets here
}

/** How a Windows shell runs `cmd`: Git Bash like sh (`-lc --`), PowerShell `-Command`, cmd `/d /s /c "cmd"` as typed. */
export function winShellSpec(shell: WinShell, file: string, cmd: string): SpawnSpec {
  if (shell === 'git-bash') return { command: file, args: ['-lc', '--', cmd] };
  // verbatim: /s takes off exactly the outer quotes and cmd parses the rest as the user typed it
  if (shell === 'cmd') return { command: file, args: ['/d', '/s', '/c', `"${cmd}"`], windowsVerbatimArguments: true };
  return { command: file, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd] };
}

/** `shell-end.error` of a run refused for its shell: the page words it in the user's language (ShellBlock), the agent in English */
export const SHELL_MISSING = 'shell-missing:';
export const CMD_ONE_LINE = 'shell-cmd-one-line';
const refusalText = (e: string): string => e === CMD_ONE_LINE ? 'cmd runs a single line'
  : e.startsWith(SHELL_MISSING) ? `${WIN_SHELL_NAMES[e.slice(SHELL_MISSING.length) as WinShell] ?? e} is not installed; see the setting "Shell for ! commands"`
  : e;

/** set for a Git Bash run: every process of it inherits the run's own value, which is how msysKill finds them */
export const MARK_VAR = 'NOTA_BENE_SHELL_RUN';
// kill -9 every MSYS process whose environment holds `MARK_VAR=$1` (the native programs it started are MSYS processes too);
// bash builtins only, ~0.1 s. Exit 0: it ran, whatever it found.
const MSYS_KILL = `m="${MARK_VAR}=$1"; for d in /proc/[0-9]*; do while IFS= read -r -d '' v; do [ "$v" = "$m" ] && { kill -9 "\${d#/proc/}"; break; }; done < "$d/environ"; done 2>/dev/null; exit 0`;

/**
 * Ends the processes of a Git Bash run, its background jobs included: sync for a stop (and at exit), else in the background
 * (true). Through MSYS, not taskkill: an MSYS process killed from outside can leave MSYS's shared state so that the next
 * bash to start dies at once ("cmalloc would have returned NULL"). false: the helper itself did not run.
 */
function msysKill(bash: string, mark: string, sync: boolean): boolean {
  const args = ['--noprofile', '--norc', '-c', MSYS_KILL, 'nb-kill', mark];
  // a bare environment: it needs no more, and it does not carry the mark itself
  const opts = { ...HIDDEN, stdio: 'ignore' as const, env: { SYSTEMROOT: envGet(process.env, 'SYSTEMROOT') } };
  if (sync) return spawnSync(bash, args, { ...opts, timeout: 5000 }).status === 0;
  spawn(bash, args, opts).on('error', () => {});
  return true;
}

// the OEM code page console programs write a pipe in (866, 437, …): read once; null when it cannot be read
let oemCp: number | null | undefined;
function oemCodePage(): number | null {
  if (oemCp !== undefined) return oemCp;
  const r = spawnSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], { ...HIDDEN, encoding: 'utf8', timeout: 5000 });
  const m = /OEMCP\s+REG_SZ\s+(\d+)/.exec(r.stdout ?? '');
  return (oemCp = m ? Number(m[1]) : null);
}

/**
 * The window's `! cmd` runs (protocol 11): one at a time, outside the agent. `$SHELL -lc cmd` in the project folder, stdin
 * /dev/null, its own process group, the launcher's variables left out. The run is a block in the feed: `shell-start` (stored),
 * the output so far (`shell-out`, live, the whole tail at most ten times a second), `shell-end` (stored, with the last 64 K
 * characters). A finished run is also queued for the agent: `take` puts the queued runs, as Claude Code writes them, in front
 * of the next message. A stop (the user's, the timeout) signals the group: TERM, then KILL; when the shell ends the rest of its
 * group is stopped the same way, so background jobs end with the command. A switch, a /clear or a close does the same quietly,
 * and the queue is the session manager's to drop.
 * Windows: the shell of the setting (`winShells`, `pickWinShell`), no stdin, no group: a stop kills at once, a Git Bash run
 * by its processes' mark (msysKill, which also ends its background jobs when the shell is gone), another shell's run as the
 * shell's process tree (taskkill /T /F); a job of those that outlives its shell is not tracked. The output is decoded per chunk (UTF-8, else the
 * OEM code page) and the block's starts with a line naming the shell.
 */
export class ShellRunner {
  private current: Run | null = null;
  private queue: string[] = [];
  private readonly o: Required<Pick<Options, 'timeoutMs' | 'killMs'>> & Options;

  constructor(o: Options) {
    this.o = { timeoutMs: SHELL_TIMEOUT_MS, killMs: SHELL_KILL_MS, ...o };
  }

  /** The id of the run in progress, if any. */
  get running(): string | null {
    return this.current?.id ?? null;
  }

  /** false: one is running already, nothing started. */
  run(id: string, cmd: string): boolean {
    if (this.current) return false;
    const ansiOut = new AnsiStripper();
    const ansiErr = new AnsiStripper();
    const run: Run = {
      id, cmd, out: new Tail(AGENT_STREAM_CAP), err: new Tail(AGENT_STREAM_CAP), all: new Tail(), ansiOut, ansiErr, quiet: false, timers: [], done: false,
    };
    this.current = run;
    this.o.emit({ kind: 'shell-start', id, cmd });
    let child: ChildProcess;
    try {
      // `--` ends the shell's own options: a command such as `--version` is a command, not a flag
      let spec: SpawnSpec;
      const env = { ...(this.o.env ?? (() => shellEnv(process.env)))() };
      if (isWindows()) {
        const pick = pickWinShell(this.o.shell?.() ?? readPrefs().shell ?? 'auto', winShells());
        if ('missing' in pick) throw new Error(SHELL_MISSING + pick.missing);
        if (pick.shell === 'cmd' && /[\r\n]/.test(cmd)) throw new Error(CMD_ONE_LINE); // cmd would run the first line only
        run.shell = pick.shell;
        if (pick.shell === 'git-bash') {
          run.bash = pick.file;
          run.mark = `${process.pid}-${id}-${Date.now()}`;
          env[MARK_VAR] = run.mark;
        }
        spec = winShellSpec(pick.shell, pick.file, cmd);
        const oem = codePageDecoder(oemCodePage());
        run.decOut = new OutputDecoder(oem);
        run.decErr = new OutputDecoder(oem);
      } else spec = { command: shellPath(), args: ['-lc', '--', cmd] };
      // Windows has no process groups, and `detached` there opens a console window of its own
      child = spawn(spec.command, spec.args, {
        cwd: this.o.root(), env, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows(), ...HIDDEN,
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (e) {
      // a spawn that throws at once (a bad env value): the block ends with the reason
      run.error = e instanceof Error ? e.message : String(e);
      this.finish(run);
      return true;
    }
    run.child = child;
    live.add(run);
    killAllOnExit();
    const { decOut, decErr } = run;
    if (!decOut || !decErr) {
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
    }
    // always drained, whatever the sockets do: the tails stay current and the command is never held up by us
    onData(child.stdout!, (c) => this.collect(run, ansiOut.push(typeof c === 'string' ? c : decOut!.push(c)), run.out));
    onData(child.stderr!, (c) => this.collect(run, ansiErr.push(typeof c === 'string' ? c : decErr!.push(c)), run.err));
    child.stdout!.on('error', () => {});
    child.stderr!.on('error', () => {});
    // the block shows which shell ran, as the first line of its output (the stored events have no field for it); the
    // agent's streams leave it out. 'spawn' comes before any output, and not at all when the shell could not start.
    const shell = run.shell;
    if (shell) child.once('spawn', () => { if (!run.done) run.all.push(`[${WIN_SHELL_NAMES[shell]}]\n`); });
    // 'error': it could not start (no such folder, no shell) or a kill failed; without a pid nothing ran and no 'exit' follows
    child.on('error', (e) => {
      if (child.pid === undefined) {
        run.error = e.message;
        this.finish(run);
      } else this.o.report('shell', e);
    });
    child.on('exit', (code, signal) => {
      run.exit = { code, signal };
      this.signalRest(run); // the shell is gone: what it left in the group (background jobs) goes with it
      run.timers.push(setTimeout(() => this.finish(run), PIPE_GRACE_MS));
    });
    child.on('close', () => this.finish(run));
    run.timers.push(setTimeout(() => this.terminate(run, 'timeout'), this.o.timeoutMs));
    return true;
  }

  /** The user's stop; an id that is not the running one is no news. */
  stop(id: string): void {
    if (this.current?.id === id) this.terminate(this.current, 'user');
  }

  /** A switch, a /clear or a close: stop the run, and let it say nothing more. The next run may start at once. */
  stopAll(): void {
    const r = this.current;
    if (!r) return;
    r.quiet = true;
    this.current = null;
    clearTimeout(r.flush);
    this.terminate(r, 'switch');
  }

  /** What the agent is told of the runs finished since its last message, in front of `text`; `text` itself when there are none, or when a slash command (a block before it would stop it being one). */
  take(text: string): string {
    return this.takeFor(text).text;
  }

  /** `take`, with a way back: `restore` puts the runs it took where they were (the hand-over to the agent failed). */
  takeFor(text: string): { text: string; restore(): void } {
    if (!this.queue.length || isSlashCommand(text)) return { text, restore() {} };
    const taken = this.queue;
    this.queue = [];
    const lead = leadOf(taken);
    return { text: text ? `${lead}\n\n${text}` : lead, restore: () => { this.queue = [...taken, ...this.queue].slice(-QUEUE_MAX); } };
  }

  /** Forget the runs waiting for the agent (a new session: they belong to the old conversation). */
  dropQueue(): void {
    this.queue = [];
  }

  /** The output so far of the run in progress, for a socket that attached meanwhile. */
  snapshot(): { id: string; text: string; truncated: boolean } | null {
    const r = this.current;
    return r && r.all.text ? { id: r.id, text: r.all.text, truncated: r.all.cut } : null;
  }

  private collect(r: Run, text: string, into: Tail): void {
    if (!text || r.done) return;
    into.push(text);
    r.all.push(text);
    // one frame per tick, whatever came in: the tail so far, replacing what the page shows
    if (r.quiet || r.flush) return;
    this.schedule(r);
  }

  private schedule(r: Run): void {
    r.flush = setTimeout(() => {
      r.flush = undefined;
      if (r.quiet || r.done) return;
      const skipped = this.o.emit({ kind: 'shell-out', id: r.id, text: r.all.text, truncated: r.all.cut }, { store: false, lossy: true });
      if (skipped) this.schedule(r); // a socket was behind and missed it: a quiet run would stay stale there, so again until it took it
    }, SHELL_FLUSH_MS);
  }

  private terminate(r: Run, why: ShellStop | 'switch'): void {
    if (r.done || r.stop) return;
    r.stop = why;
    if (signalGroup(r, 'SIGTERM')) this.armKill(r);
  }

  /** TERM to what is left of the group after the shell ended, and KILL a little later if any of it stayed. */
  private signalRest(r: Run): void {
    if (signalGroup(r, 'SIGTERM')) this.armKill(r);
  }

  /**
   * The KILL that follows a TERM that landed. The run stays in `live` (the exit hook kills it) until the KILL has gone or the group
   * is empty, which a poll notices: then there is nothing to kill, and the group id must not be signalled again.
   */
  private armKill(r: Run): void {
    if (r.killTimer) return;
    const end = () => {
      clearTimeout(r.killTimer);
      clearInterval(r.poll);
      live.delete(r);
    };
    r.killTimer = setTimeout(() => { signalGroup(r, 'SIGKILL'); end(); }, this.o.killMs);
    r.poll = setInterval(() => { if (!signalGroup(r, 0)) end(); }, POLL_MS);
    r.killTimer.unref(); // after the run ended it only guards stragglers; it must not hold the process open
    r.poll.unref();
  }

  private finish(r: Run): void {
    if (r.done) return;
    for (const t of r.timers) clearTimeout(t); // not killTimer: a child that ignored TERM is still to be killed
    // a background child may hold the pipes: let go of them, the output so far is what the run printed
    r.child?.stdout?.destroy();
    r.child?.stderr?.destroy();
    if (r.decOut) this.collect(r, r.ansiOut.push(r.decOut.end()), r.out);
    if (r.decErr) this.collect(r, r.ansiErr.push(r.decErr.end()), r.err);
    this.collect(r, r.ansiOut.end(), r.out);
    this.collect(r, r.ansiErr.end(), r.err);
    clearTimeout(r.flush);
    r.done = true;
    if (this.current === r) this.current = null;
    if (!r.killTimer && !r.exit) this.signalRest(r); // no exit seen (a failed spawn path): the group still goes; after an exit it was already checked
    if (!r.killTimer) live.delete(r); // nothing left to kill; otherwise it stays until the KILL or an empty group
    if (r.quiet) return;
    // a tree killed on Windows exits 1 (taskkill /F), which is not the command's code: like a signal elsewhere, none
    const code = r.stop && r.shell ? null : r.exit?.code ?? null;
    this.o.emit({
      kind: 'shell-end', id: r.id, cmd: r.cmd, output: r.all.text, truncated: r.all.cut, code,
      ...(r.stop && r.stop !== 'switch' ? { stop: r.stop } : {}), ...(r.error ? { error: r.error } : {}),
    });
    const note = r.stop === 'user' ? '[stopped by the user]' : r.stop === 'timeout' ? '[stopped: it ran longer than 10 minutes]'
      : r.error ? `[could not run: ${refusalText(r.error)}]` : code ? `[exit code ${code}]` : undefined;
    // Claude Code's form says bash: a run of another shell says which it was
    const ran = r.shell && r.shell !== 'git-bash' ? `[run in ${WIN_SHELL_NAMES[r.shell]}]` : undefined;
    const notes = [ran, note].filter(Boolean).join('\n');
    this.queue.push(bashBlock({ cmd: r.cmd, stdout: r.out.text, stdoutCut: r.out.cut, stderr: r.err.text, stderrCut: r.err.cut, ...(notes ? { note: notes } : {}) }));
    if (this.queue.length > QUEUE_MAX) this.queue.shift();
  }
}
