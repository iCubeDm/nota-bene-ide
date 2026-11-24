// Open Nota Bene (browser chat over Claude Code with inline comments) on the current folder. Called by the /nb skill.
// Usage: node open.mjs [--data DIR] [--plan] "<skill arguments>" <calling sessionId>
//   --data DIR is the plugin's data dir (SKILL.md passes ${CLAUDE_PLUGIN_DATA}: it is NOT in the env of Bash commands).
//   Where the launcher lives, in this order:
//     1. a checkout: bin/nota-bene.mjs three levels above this skill dir (plugin/skills/nb -> repo root), as before;
//        found through the ~/.claude/skills/nb symlink (a junction on Windows) too. Needs Node >= 23.6 (it runs the .ts sources).
//     2. the npm package nota-bene-ide@<plugin version> installed under DIR/<version>/ (one install per version, about 330 MB
//        each, not pruned yet; npm install --prefix DIR/<version>, done on the first run, never in the --plan preprocessing).
//        Needs Node >= 22. The version is the plugin's (.claude-plugin/plugin.json); a plugin update therefore reinstalls.
//   no arguments — the folder's agent already open is just brought to front; otherwise the folder opens, resuming its
//                  last window session (if its transcript still exists), else starting one
//   new          — always a new session
//   fork         — carry the calling terminal conversation over: the window resumes it as a fork (new session id),
//                  so the terminal and the window never append to one transcript
// The folder opens as an agent of the running Nota Bene server, or in a server the launcher starts (`--detach`, epic 383):
// either way it outlives this Claude Code session; nothing runs as its background task.
// --plan (what the skill runs) launches nothing: after the same guards it prints
//   NB-RUN: <this script without --plan>     the skill runs it in the foreground; it prints one NB: line
//   NB-NOTE: <text>                           on a first install only: the run installs the package first (minutes)
// or one NB: line (an error, a refusal). The command is read back by Claude Code's Bash tool, which is bash
// (Git Bash on Windows), and is built by q(): a word of safe characters stays as it is, anything else (spaces, quotes, $,
// parentheses, non-ASCII) is single-quoted, so bash and zsh read each back exactly and Claude Code accepts the text (it refuses
// backslash-escaped spaces and $'\320...' escapes). Paths in it use forward slashes on Windows too (C:/Users/...), which
// node and bash both take and the allowed-tools patterns match.
// The URL this script prints for the skill is the plain one, with no login: the skill's output enters the Claude Code transcript
// and goes to the API. A browser logs in through the launcher, which opens a page in the state dir that redirects with the login
// (the launcher itself, for a new agent and an open one). A second browser can use `nota-bene --url PORT` in a terminal.
// The launcher is bin/nota-bene.mjs (--find / --last / --detach). Its launch lock keeps one server, so two /nb at once end with
// one agent for the folder; this script finds, words and relays. It ships alone in the plugin (no package.json, no imports
// beyond Node's own) and parses on old Node versions, so the floor check below can say what is wrong.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
const PKG = 'nota-bene-ide';

class Exit {
  constructor(code) { this.code = code; }
}
const say = (line) => process.stdout.write(`${line}\n`);
const exit = (code) => { throw new Exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const secs = (v, dflt) => (/^[0-9]+$/.test(v ?? '') ? Number(v) : dflt);
// what is printed and passed on: Windows paths with forward slashes and an upper-case drive (C:/Users/x), POSIX ones as they are
const shown = (p) => (WIN ? p.replace(/\\/g, '/').replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`) : p);
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const envGet = (name) => (WIN ? Object.entries(process.env).find(([k]) => k.toUpperCase() === name)?.[1] : process.env[name]);

/** The file a bare command name would run (`command -v`): PATH, and on Windows PATHEXT (`npm` is `npm.cmd`). */
function which(name) {
  const exts = WIN ? (envGet('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (envGet('PATH') ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const p = path.join(WIN ? dir.replace(/^"(.*)"$/, '$1') : dir, name + e);
      if (!isFile(p)) continue;
      if (WIN) return p;
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* not executable */ }
    }
  }
  return null;
}

/** How to spawn npm with `args`. POSIX: `npm` from PATH, as a shell would. Windows: the npm-cli.js beside the npm.cmd found on
 *  PATH, run with this node; else the .cmd through cmd.exe, quoted as server/src/platform.ts `spawnSpec` does (Node refuses a
 *  .cmd without a shell, and `shell: true` would not quote). */
function npmSpawn(npm, args) {
  if (!WIN) return { command: 'npm', args };
  const ext = path.extname(npm).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { command: npm, args };
  const cli = path.join(path.dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (isFile(cli)) return { command: process.execPath, args: [cli, ...args] };
  const META = /([()%!^"<>&|])/g;
  const quote = (a) => `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(META, '^$1').replace(META, '^$1');
  const line = [`"${npm.replace(/%/g, '"^%"')}"`, ...args.map(quote)].join(' ');
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/** A process with this pid runs (`kill -0`: a pid owned by someone else counts as gone, as in the shell version). */
const alive = (pid) => {
  if (!/^[0-9]+$/.test(pid ?? '') || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
};

/**
 * One shell word that bash and zsh read back exactly, in the only forms Claude Code accepts when it matches allowed-tools: safe
 * characters as they are, anything else (spaces, parentheses, quotes, $, non-ASCII) in '...' with ' as '\'' (it refuses
 * backslash-escaped spaces and $'\320...' escapes). Control characters have no such form and get bash's $'...' (printf %q in
 * the C locale: every byte that is not printable ASCII as an octal escape).
 */
export function q(s) {
  if (/[\x00-\x1f\x7f]/.test(s)) {
    const named = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 27: 'E', 39: "'", 92: '\\' };
    let o = "$'";
    for (const b of Buffer.from(s, 'utf8')) {
      if (named[b]) o += `\\${named[b]}`;
      else if (b >= 0x20 && b < 0x7f) o += String.fromCharCode(b);
      else o += `\\${b.toString(8).padStart(3, '0')}`;
    }
    return `${o}'`;
  }
  if (s === '' || /[^A-Za-z0-9_./:@%+=,-]/.test(s)) return `'${s.replace(/'/g, "'\\''")}'`;
  return s;
}

const SELF_PHYS = fileURLToPath(import.meta.url);
const SKDIR = real(path.dirname(SELF_PHYS)) ?? path.dirname(SELF_PHYS); // physical: the skill dir may be linked from ~/.claude/skills/nb
// this script as it was called (through the ~/.claude/skills/nb link), so NB-RUN matches the skill's allowed-tools
const SELF = path.resolve(process.argv[1] ?? SELF_PHYS);

async function main(argv) {
  let DATA = '';
  if (argv[0] === '--data' && argv.length >= 2) { DATA = argv[1]; argv = argv.slice(2); }
  if (DATA.includes('${')) DATA = ''; // an unsubstituted ${CLAUDE_PLUGIN_DATA} is no directory
  // --plan runs in the skill's `!` preprocessing: a non-zero exit there fails the whole skill with no model turn, so an error
  // or refusal is printed and exits 0 (the model relays the NB: line). Every other mode keeps exit 1 for failures.
  const PLAN = argv[0] === '--plan';
  const bail = (line) => { say(line); exit(PLAN ? 0 : 1); };
  // the launcher's `--find` exits 3 when a secret file (the access token) is refused; its stderr says which and how to fix it
  const relayErr = (text) => {
    const lines = text.replace(/#t=[0-9a-fA-F]*/g, '').split('\n');
    lines[0] = `NB: ${lines[0].replace(/^nota-bene: /, '')}`;
    process.stdout.write(lines.join('\n'));
  };

  let SRC, BIN, VER = '', PREFIX = '', MIN = [23, 6], FIRST_RUN = false;
  if (isFile(path.join(SKDIR, '../../../bin/nota-bene.mjs'))) {
    SRC = 'checkout';
    BIN = path.join(real(path.join(SKDIR, '../../..')), 'bin', 'nota-bene.mjs');
  } else if (DATA) {
    SRC = 'package';
    MIN = [22, 0];
    try { VER = String(JSON.parse(read(path.join(SKDIR, '../../.claude-plugin/plugin.json'))).version ?? ''); } catch { VER = ''; }
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(VER)) bail('NB: cannot read the plugin version (.claude-plugin/plugin.json beside skills/): reinstall the plugin.');
    // one install per version: DATA/<version>/ (about 330 MB each). A plugin update installs beside the old one, so a session
    // still on the old version (or a window running from it) is never touched. Old version dirs are not pruned yet.
    PREFIX = path.join(DATA, VER);
    BIN = path.join(PREFIX, 'node_modules', PKG, 'bin', 'nota-bene.mjs');
  } else {
    bail('NB: cannot find the Nota Bene launcher: no checkout above this skill and no plugin data dir. Install the plugin (/plugin marketplace add iCubeDm/nota-bene-ide, then /plugin install nota-bene@nota-bene) or link the skill from a checkout.');
  }
  // installed = the marker (written last, after a good install) and the launcher
  const installed = () => isFile(path.join(PREFIX, '.nb-installed')) && isFile(BIN);
  if (SRC === 'package' && !installed()) FIRST_RUN = true;

  // the checkout launcher imports the server's .ts files directly: Node >= 23.6 strips their types; the package is compiled.
  // The node that runs this script is the `node` of Claude Code's shell, the same one NB-RUN runs.
  const nodeV = process.env.NB_TEST_NODE_VERSION || process.versions.node; // test only: pretend to be another version
  const m = /^([0-9]+)\.([0-9]+)/.exec(nodeV);
  if (!m || Number(m[1]) < MIN[0] || (Number(m[1]) === MIN[0] && Number(m[2]) < MIN[1])) {
    const floor = MIN[1] > 0 ? `${MIN[0]}.${MIN[1]}` : `${MIN[0]}`;
    bail(`NB: Nota Bene needs Node >= ${floor}; found ${nodeV} at ${shown(process.execPath)}. Make it the default node for Claude Code's shell (e.g. nvm alias default).`);
  }

  // npm is only needed for the first install of the package
  const NPM_MISSING = `NB: npm not found on PATH; the first run installs ${PKG}@${VER} with it. Install Node.js with npm (nodejs.org), or run \`npm install -g ${PKG}\` and open it with \`nota-bene\`.`;
  const lock = path.join(PREFIX, '.nb-install.lock');
  const STALE_SECS = secs(process.env.NB_LOCK_STALE_SECS, 3600); // a live slow install must not be robbed; a recycled pid costs one waiter timeout
  const olderThan = (p, ms) => { try { return Date.now() - fs.statSync(p).mtimeMs > ms; } catch { return false; } };
  // seconds since the lock was taken; huge when it carries no timestamp and is over a minute old; 0 when just taken
  const lockAge = () => {
    const ts = (read(path.join(lock, 'ts')) ?? '').trim();
    if (/^[0-9]+$/.test(ts)) return Math.floor(Date.now() / 1000) - Number(ts);
    return olderThan(lock, 60_000) ? 999999 : 0;
  };
  const lockStale = () => {
    const holder = (read(path.join(lock, 'pid')) ?? '').trim();
    const age = lockAge();
    return (holder !== '' && !alive(holder) && age > 3) || age > STALE_SECS;
  };
  const mkdir = (p) => { try { fs.mkdirSync(p); return true; } catch { return false; } };
  const rmdir = (p) => { try { fs.rmdirSync(p); } catch { /* gone, or not empty */ } };
  const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };
  // test only: the first process to reach the reclaim mutex stops there until <gate>.go exists (a deterministic replay of a race)
  const GATE = process.env.NB_TEST_RECLAIM_GATE;
  let gated = false;

  // install the package into DATA/<version>; progress goes to our stdout. The lock keeps two /nb runs from installing at once.
  async function installPkg() {
    const log = path.join(PREFIX, '.nb-install.log');
    try { fs.mkdirSync(PREFIX, { recursive: true }); } catch { say(`NB: cannot create the plugin data dir ${shown(PREFIX)}.`); return false; }
    const tee = (text) => process.stdout.write(text);
    const npm = which('npm');
    if (!npm) { tee(`${NPM_MISSING}\n`); return false; }
    const started = Date.now();
    for (;;) {
      // the time limit counts elapsed seconds, not loop turns: a mkdir that keeps failing (unwritable dir) or a stale lock that
      // cannot be removed must still end
      const waited = Math.floor((Date.now() - started) / 1000);
      if (waited >= secs(process.env.NB_INSTALL_WAIT_SECS, 540)) { tee(`NB: another install of ${PKG}@${VER} is still running after ${waited}s.\n`); return false; }
      // Every change of the lock's existence (taking a free lock, removing a stale one) happens inside a short critical section,
      // the mutex dir "<lock>.reclaim" (mkdir is atomic: one waiter gets it). Judging a lock stale and removing it are separate
      // steps, so they must not be separated by someone else's take: an unguarded look-then-remove (or move aside, judge, move
      // back) deletes or hides a fresh lock that a faster waiter took in between, and a third waiter then takes the gap: two
      // installs. Under the mutex nobody else can take, remove or move the lock, so a stale judgment is re-made there on the
      // very lock that is then removed, and the lock is complete (ts, pid) before anyone can look at it.
      // The look outside the mutex only decides whether to try; it is never acted on without the second look.
      // Accepted risk: a live holder whose install runs past NB_LOCK_STALE_SECS (an hour) looks stale and can be reclaimed.
      if (!fs.existsSync(lock) || lockStale()) {
        if (GATE && !fs.existsSync(`${GATE}.stalled`)) {
          gated = true;
          fs.writeFileSync(`${GATE}.stalled`, '');
          while (!fs.existsSync(`${GATE}.go`)) await sleep(50);
        }
        if (mkdir(`${lock}.reclaim`)) {
          if (mkdir(lock)) {
            fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
            fs.writeFileSync(path.join(lock, 'ts'), `${Math.floor(Date.now() / 1000)}\n`);
            rmdir(`${lock}.reclaim`);
            break;
          }
          // a lock whose holder is gone (dead pid) or that is simply old (a recycled pid, or no timestamp at all)
          if (lockStale()) rmrf(lock);
          rmdir(`${lock}.reclaim`);
          if (gated) { gated = false; fs.writeFileSync(`${GATE}.released`, ''); }
        } else {
          // a waiter killed inside the critical section must not block everyone for good. Clearing is itself a critical section
          // (<lock>.reclaim.break): of several clearers one re-checks the age and removes, so none removes a mutex another has
          // just cleared and re-taken. A break dir left by a killed clearer is cleared only at a longer age.
          if (olderThan(`${lock}.reclaim`, 60_000)) {
            if (mkdir(`${lock}.reclaim.break`)) {
              if (olderThan(`${lock}.reclaim`, 60_000)) rmdir(`${lock}.reclaim`);
              rmdir(`${lock}.reclaim.break`);
            } else if (olderThan(`${lock}.reclaim.break`, 5 * 60_000)) rmdir(`${lock}.reclaim.break`);
          }
          await sleep(200);
        }
        continue;
      }
      // another run is installing: wait for it, then use its result
      await sleep(1000);
      if (installed()) return true;
    }
    // taken: another run may have finished between our last look and the lock
    if (installed()) { rmrf(lock); return true; }
    rmrf(path.join(PREFIX, '.nb-installed'));
    say(`Nota Bene: first run, installing ${PKG}@${VER} into the plugin data dir (about 330 MB, this takes a while)...`);
    const spec = npmSpawn(npm, ['install', '--prefix', PREFIX, `${PKG}@${VER}`, '--no-audit', '--no-fund']);
    let logText = '';
    const rc = await new Promise((resolve) => {
      const c = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments });
      const take = (d) => { process.stdout.write(d); logText += d.toString(); };
      c.stdout.on('data', take);
      c.stderr.on('data', take);
      c.on('error', () => resolve(127));
      c.on('close', (code) => resolve(code ?? 1));
    });
    try { fs.writeFileSync(log, logText); } catch { /* the output went to the task already */ }
    if (rc !== 0 || !isFile(BIN)) {
      const tail = logText.replace(/\n$/, '').split('\n').slice(-5).join('\n');
      tee(`NB: installing ${PKG}@${VER} failed (npm exit ${rc}). Check the network and free disk space, then run /nb again; or run \`npm install --prefix "${shown(PREFIX)}" ${PKG}@${VER}\` yourself to see the full error.\n${tail ? `${tail}\n` : ''}`);
      rmrf(lock);
      return false;
    }
    fs.writeFileSync(path.join(PREFIX, '.nb-installed'), `${VER}\n`);
    rmrf(lock);
    say(`Nota Bene: installed ${PKG}@${VER}.`);
    return true;
  }

  const find = (dir, extra = []) => {
    const r = spawnSync(process.execPath, [BIN, '--find', dir, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return { rc: r.status ?? 1, port: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
  };

  if (PLAN) argv = argv.slice(1);

  const ARG = (argv[0] ?? '').toLowerCase().trim();
  const SID = argv[1] ?? '';
  let MODE;
  if (ARG === '') MODE = 'last';
  else if (['new', 'новая', 'новую', 'заново'].includes(ARG)) MODE = 'new';
  else if (['fork', 'continue', 'here', 'продолжить', 'продолжи', 'форк'].includes(ARG)) MODE = 'fork';
  else { say(`NB: unknown argument '${argv[0]}'. Use /nb (resume the last window session here), /nb new, or /nb fork (carry this conversation over).`); exit(0); }

  // inside a Nota Bene window (the launcher)
  if (process.env.NOTA_BENE_SUPERVISED) { say('NB: already running inside Nota Bene — nothing to open.'); exit(0); }
  const DIR = real(process.cwd()) ?? process.cwd();
  const HOME = process.env.HOME || os.homedir();
  const same = (a, b) => (WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : a === b);
  if (same(DIR, HOME) || same(DIR, real(HOME) ?? HOME) || path.parse(DIR).root === DIR) {
    say(`NB: refusing to open the whole ${shown(DIR)} as a project — cd into a project first.`);
    exit(0);
  }

  // the launcher brings a window to front (its opener: open on macOS, xdg-open on Linux, its own one on Windows); this
  // script opens nothing itself. A launch that printed its line opened the browser, if there is an opener to open it with
  const OPENER = WIN || process.platform === 'darwin' || !!which('xdg-open');
  let FRONTED = false; // set once a browser was really pointed at the window
  const frontNote = (url) => (FRONTED ? 'brought to front'
    : `no browser could be opened from here: run \`nota-bene --url ${new URL(url).port}\` in a terminal for a login link`);
  const already = (url) => {
    if (MODE === 'fork') say(`NB: a window is already open on this folder at ${url} (${frontNote(url)}). It was NOT switched to this conversation: switching restarts it and may cut a running turn. To move this conversation there, quit the terminal claude and pick it in Sessions ▾.`);
    else say(`NB: already open at ${url} (${frontNote(url)}).`);
    exit(0);
  };

  // a refused secret file is said at once, in --plan too. A window already serving the folder is not fronted here: a
  // server that serves it may have no agent of it left (issue 642), so the launcher below asks it for the folder's agent
  if (!FIRST_RUN) {
    const r = find(DIR, ['--scan']);
    if (r.rc === 3) { relayErr(r.err); exit(PLAN ? 0 : 1); }
  }

  const ARGS = ['--detach', '--agent', 'claude']; // explicit: a launcher never picks another agent for /nb
  let NOTE = '';
  if (MODE === 'last') {
    // the server itself resumes the folder's last session; --last only tells us which note to print
    if (FIRST_RUN) NOTE = ''; // nothing installed yet to ask
    else {
      const r = spawnSync(process.execPath, [BIN, '--last', DIR], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const last = (r.stdout ?? '').replace(/\n+$/, '');
      NOTE = r.status === 0 && last ? ` (resumed the last window session ${last.slice(0, 8)})` : ' (new session: no earlier window session for this folder)';
    }
  } else if (MODE === 'new') ARGS.push('--new');
  else {
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(SID)) bail(`NB: no valid session id to fork ('${SID}').`);
    ARGS.push('--resume', SID, '--fork');
    NOTE = ' (forked from this conversation)';
  }
  // test only: the launcher tests run the real bin with the fake agent
  if (process.env.NOTA_BENE_FAKE) ARGS.push('--fake', process.env.NOTA_BENE_FAKE);

  if (PLAN) {
    if (FIRST_RUN) {
      if (!which('npm')) bail(NPM_MISSING);
      // the install needs a writable data dir; under Claude Code's sandbox mode it is not, and the run would fail the same way
      // on every retry, so say the likely cause here (a plan runs first) and give no "run /nb again"
      try {
        fs.mkdirSync(PREFIX, { recursive: true });
        fs.writeFileSync(path.join(PREFIX, '.nb-probe'), '');
        fs.rmSync(path.join(PREFIX, '.nb-probe'), { force: true });
      } catch {
        bail(`NB: cannot write to the plugin data dir ${shown(PREFIX)}, which the first run needs to install ${PKG}@${VER}. The likely cause is Claude Code's sandbox mode (it blocks writes outside the project): allow writes to that folder in the sandbox settings, or turn the sandbox off for /nb. Retrying will not help until then.`);
      }
    }
    // this script again, without --plan: it installs when needed, opens the folder and prints one NB: line
    let RUN = `node ${q(shown(SELF))}`;
    if (SRC === 'package') RUN += ` --data ${q(shown(DATA))}`;
    RUN += ` ${q(MODE === 'last' ? '' : MODE)}${MODE === 'fork' ? ` ${q(SID)}` : ''}`;
    say(`NB-RUN: ${RUN}`);
    if (FIRST_RUN) say(`NB-NOTE: first run: installing ${PKG}@${VER} (about 330 MB); this can take a few minutes.`);
    exit(0);
  }
  if (FIRST_RUN) {
    if (!(await installPkg())) exit(1);
    FIRST_RUN = false;
  }

  // --detach prints one line: "opened URL", or "already-open URL" (a launch on this folder got there first; the bin
  // brought that window to front)
  const r = spawnSync(process.execPath, [BIN, DIR, ...ARGS], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const RC = r.status ?? 1;
  const OUT = (r.stdout ?? '').replace(/\n+$/, '');
  // an agent of the running server is under its /a/<id>/
  const lm = /^(opened|already-open) http:\/\/127\.0\.0\.1:([0-9]+)(\/a\/[a-z]+-[a-z2-7]{6})?\/?(#t=[0-9a-f]+)?$/.exec(OUT);
  if (RC === 0 && lm) {
    const URL_ = `http://127.0.0.1:${lm[2]}${lm[3] ? `${lm[3]}/` : ''}`; // the launcher's line carries #t=LOGIN; the skill's output must not
    if (OPENER) FRONTED = true; // the launcher opened (or fronted) the login page itself
    if (lm[1] === 'already-open') already(URL_);
    say(`NB: opened ${URL_} for ${shown(DIR)}${NOTE}. Log: ${shown(path.join(os.tmpdir(), `nota-bene-${lm[2]}.log`))}`);
    exit(0);
  }
  // the launcher's error (its "nota-bene: " prefix becomes ours), then the log tail it printed
  relayErr(r.stderr ? r.stderr : `nota-bene: the launcher failed (exit code ${RC})${OUT ? `: ${OUT}` : ''}\n`);
  exit(1);
}

const isMain = (() => { try { return real(process.argv[1]) === real(SELF_PHYS); } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2)).then(
    () => { process.exitCode = 0; },
    (e) => {
      if (e instanceof Exit) process.exitCode = e.code;
      else { process.stdout.write(`NB: open.mjs failed: ${String(e && e.message ? e.message : e).replace(/#t=[0-9a-fA-F]*/g, '')}\n`); process.exitCode = process.argv.includes('--plan') ? 0 : 1; }
    },
  );
}
