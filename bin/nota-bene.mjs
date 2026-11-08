#!/usr/bin/env node
// nota-bene — open a Nota Bene window on a folder and supervise its server.
// Plain Node ESM, no dependencies; imports the server's .ts helpers directly (Node >= 23.6 strips the types). The published
// package bundles this file and the server to plain JS (scripts/build-package.mjs).
//
//   nota-bene [dir] [--port N] [--resume ID [--fork]] [--new] [--detach] [--no-open]
//   nota-bene --find DIR [--scan]   prints the port of a live window serving DIR (exit 0), or exits 1 (3: a secret file is refused,
//                          the message says which); --scan also asks the other ports of the range (a lost registry write)
//   nota-bene --last DIR   prints DIR's saved session id if its transcript still exists (exit 0), or exits 1
//   nota-bene --url PORT   prints the window's login URL (http://127.0.0.1:PORT/#t=LOGIN), for a second browser
//   nota-bene --front PORT brings the window to front in the browser, logged in
//   --detach prints exactly one line, `opened URL` or `already-open URL` (exit 0), or an error and the log tail (exit 1);
//   the URL carries the login fragment `#t=LOGIN` (this launch's login value, never the token; the foreground line and the log never do)
//
// The access token (server/src/auth.ts) is never put in argv or a URL: a browser is opened on a page in the state dir (mode 600)
// that redirects to the login URL, and the helpers send a credential derived after the listener proved it holds the token.
//
// Without --agent, in an interactive terminal, a launch asks which agent when more than one is installed (server/src/agent/choice.ts);
// anything else gets Claude. One window per folder: a launch takes the folder's lock, then gives way to a window already serving it.
// A picked port avoids 4780 (dev) and 4790-4795 (smoke, tests) unless NOTA_BENE_PORT_RANGE is set.
//
// Server exit codes 75 relaunches at once with --continue (more than 10 within 60 s give up);
// 0, 130, 143 exit; 98 (listen failed) on the first start retries once on another port when the port was picked
// automatically; anything else (a signal too) is a crash: relaunch after 1 s, give up at 5 crashes within 60 s.
// A relaunch keeps the port, so the open tab reconnects by itself, reopens the folder the window has now (it may have
// switched), and drops --resume/--fork/--new for --continue. The registry entry stays through the restart gap (it is
// removed only when the launcher ends), so no other launch picks the port meanwhile; a 98 on a relaunch gives up.
//
// Handover (in-app update): a published launcher whose runtime/current (server/src/runtime.ts) names a newer x.y.z runs that
// version's launcher as a child instead of its own (the outer part, `outer`), on the same port with the same nonce, and again
// whenever a server or an inner launcher exits 77 (a newer version is current; the server may do so only with
// NOTA_BENE_HANDOVER=1). A new version that does not answer /info within 20 s, or whose launcher exits within its first 60 s,
// is rolled back: current goes back to the version that ran before, and the window runs on that one. A checkout never hands over.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { SecretError, accessToken, isNonce, loginCredential, newNonce, proveListener, stateSecret } from '../server/src/auth.ts';
import { launcherOf, patchUpdateState, readCurrent, runtimeDir, writeCurrent } from '../server/src/runtime.ts';
import { transcriptExists } from '../server/src/sessions.ts';
import { lastSession, stateBaseDir, stateDir } from '../server/src/state.ts';
import { defaultChoice, detectAgents, lastAgent, menu, parseChoice, rememberAgent } from '../server/src/agent/choice.ts';
import { parseProvider } from '../server/src/agent/provider.ts';
import { RELEASE, isNewer } from '../server/src/update.ts';
import {
  liveWindows, pidAlive, probeInfo, readWindows, registerWindow, restartingWindows, unregisterWindow,
} from '../server/src/windows.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
// the source checkout runs the server's .ts directly; the published package ships it compiled (Node does not strip types
// under node_modules) at the same relative place
const MAIN = path.join(REPO, fs.existsSync(path.join(REPO, 'server/src/main.js')) ? 'server/src/main.js' : 'server/src/main.ts');
const USAGE = 'Usage: nota-bene [dir] [--agent claude|codex|omp] [--port N] [--resume ID [--fork]] [--new] [--detach] [--no-open]\n'
  + '       nota-bene --find DIR [--scan] | --last DIR | --url PORT | --front PORT\n'
  + '       nota-bene remote [pair | devices | revoke ID | status | --relay URL]   (remote access, see nota-bene remote --help)\n'
  + '       nota-bene --help | --version';
const DEV_BACKEND_PORT = 4780; // `npm run dev`'s server (scripts/dev.mjs, web/vite.config.ts)
const EXIT_SECRET = 3; // a secret file is refused (loose mode, foreign owner, ...): --find & co. say so instead of "not found"
const RESTART = 75;
const LISTEN_FAILED = 98; // server/src/main.ts LISTEN_FAILED
const NO_AGENT_BINARY = 76; // server/src/main.ts NO_AGENT_BINARY: the server said why, a relaunch cannot help
export const HANDOVER = 77; // server/src/main.ts HANDOVER: a newer version is current, the outer part hands the window over
// a new version whose window does not answer /info within this is rolled back
// TEST-ONLY: NOTA_BENE_TEST_HANDOVER_INFO_MS shortens it for bin/nota-bene.test.ts. Never set it otherwise.
const HANDOVER_INFO_MS = Number(process.env.NOTA_BENE_TEST_HANDOVER_INFO_MS) || 20_000;
const HANDOVER_EXIT_MS = 60_000; // ... as is one whose launcher exits (not cleanly, not 77) within this
const CLEAN_EXITS = new Set([0, 130, 143]);
const MAX_CRASHES = 5;
const MAX_RESTARTS = 10;
const GUARD_WINDOW_MS = 60_000;
// test only: NOTA_BENE_DETACH_WAIT_MS shortens the wait, to reach the timeout path
const DETACH_WAIT_MS = Number(process.env.NOTA_BENE_DETACH_WAIT_MS) || 20_000;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const RESTART_WAIT_MS = 10_000; // how long a launch waits for a restarting window of its folder to come back

/** This package's version (the checkout's root package.json says the same). */
export function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * A published package (no `.git` at its root, the rule server/src/system.ts uses for the version) may hand over; a checkout never.
 * TEST-ONLY: NOTA_BENE_TEST_PUBLISHED=1 makes bin/nota-bene.test.ts's checkout launcher count as published. Never set it otherwise.
 */
const PUBLISHED = process.env.NOTA_BENE_TEST_PUBLISHED === '1' || !fs.existsSync(path.join(REPO, '.git'));
const INNER = process.env.NOTA_BENE_INNER === '1'; // started by an outer part: run the window here, return 77 to it

/** The version to hand over to: `current` when it is a newer plain release and this launcher is published; else null. */
export function handoverTarget({ own, current, published }) {
  return published && current !== null && RELEASE.test(own) && RELEASE.test(current) && isNewer(current, own) ? current : null;
}

const say = (msg) => process.stderr.write(`nota-bene: ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realDir = (d) => fs.realpathSync.native(path.resolve(d));

export function parseArgs(argv) {
  const o = { dir: undefined, port: undefined, resume: undefined, fork: false, new: false, continue: false,
    detach: false, open: true, help: false, version: false, fake: undefined, allowOrigins: [], find: undefined, last: undefined,
    scan: false, url: undefined, front: undefined };
  const value = (i) => {
    if (argv[i] === undefined) throw new Error(`${USAGE}\nMissing value for ${argv[i - 1]}`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const v = value(++i);
      if (!/^\d+$/.test(v) || Number(v) > 65535) throw new Error(`${USAGE}\nInvalid port: ${v}`);
      o.port = Number(v);
    } else if (a === '--agent') o.agent = parseProvider(value(++i));
    else if (a === '--resume') o.resume = value(++i);
    else if (a === '--fork') o.fork = true;
    else if (a === '--new') o.new = true;
    else if (a === '--continue') o.continue = true;
    else if (a === '--detach') o.detach = true;
    else if (a === '--no-open') o.open = false;
    else if (a === '--fake') o.fake = path.resolve(value(++i));
    else if (a === '--allow-origin') o.allowOrigins.push(value(++i));
    else if (a === '--find') o.find = value(++i);
    else if (a === '--last') o.last = value(++i);
    else if (a === '--scan') o.scan = true;
    else if (a === '--url') o.url = value(++i);
    else if (a === '--front') o.front = value(++i);
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version' || a === '-v') o.version = true;
    else if (a.startsWith('-') && a.length > 1) throw new Error(`${USAGE}\nUnknown option: ${a}`); // not a folder named like a flag
    else if (o.dir === undefined) o.dir = a;
    else throw new Error(`${USAGE}\nUnexpected argument: ${a}`);
  }
  if (o.fork && o.resume === undefined) throw new Error(`${USAGE}\n--fork needs --resume`);
  if (o.new && o.resume !== undefined) throw new Error(`${USAGE}\n--new cannot be combined with --resume`);
  return o;
}

/** The server's argv. A relaunch resumes what the window has now (--continue), never the original --resume/--fork/--new. */
export function serverArgs(o, port, relaunch) {
  const a = [o.dir, '--port', String(port)];
  if (o.agent) a.push('--agent', o.agent);
  if (relaunch) a.push('--continue');
  else {
    if (o.resume !== undefined) a.push('--resume', o.resume);
    if (o.fork) a.push('--fork');
    if (o.new) a.push('--new');
    if (o.continue) a.push('--continue');
  }
  if (o.fake) a.push('--fake', o.fake);
  for (const origin of o.allowOrigins) a.push('--allow-origin', origin);
  return a;
}

/**
 * The server child's environment. Started through npx / npm run, we inherit npm's `npm_*` variables and a PATH that npm
 * prefixed with the package's node_modules/.bin (and node-gyp-bin); the server and the agent it runs must not see either.
 */
export function serverEnv(base, launcherPid, { handover = false, updatedFrom } = {}) {
  const env = { ...base, NOTA_BENE_SUPERVISED: '1', NOTA_BENE_LAUNCHER_PID: String(launcherPid) };
  // the server's permission to exit 77, and the version it was updated from: ours to give, never inherited
  delete env.NOTA_BENE_HANDOVER;
  delete env.NOTA_BENE_UPDATED_FROM;
  if (handover) env.NOTA_BENE_HANDOVER = '1';
  if (updatedFrom) env.NOTA_BENE_UPDATED_FROM = updatedFrom;
  // only when npm / npx started us: a plain shell launch keeps the user's own NPM_TOKEN, npm_config_registry, PATH
  if (!(base.npm_execpath || base.npm_lifecycle_event)) return env;
  for (const k of Object.keys(env)) if (/^npm_/.test(k)) delete env[k];
  delete env.INIT_CWD; // set by npm; the dir and --fake are absolute already
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  if (key && env[key]) {
    const parts = env[key].split(path.delimiter);
    let i = 0;
    while (i < parts.length && /(^|[\\/])(node_modules[\\/]\.bin|node-gyp-bin)$/.test(parts[i])) i++; // npm prepends them
    env[key] = parts.slice(i).join(path.delimiter);
  }
  return env;
}

// --- ports -----------------------------------------------------------------------------------------------------

/** The live window range; NOTA_BENE_PORT_RANGE="A-B" narrows it (the tests use 4791-4795). */
function portRange(env = process.env) {
  const m = /^(\d+)-(\d+)$/.exec(env.NOTA_BENE_PORT_RANGE ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [4777, 4799];
}

/** Ports a window may take: the default range minus the dev server (4780) and the smoke/test ports (4790-4795). */
export function candidatePorts(env = process.env) {
  const [from, to] = portRange(env);
  const reserved = env.NOTA_BENE_PORT_RANGE ? [] : [4780, 4790, 4791, 4792, 4793, 4794, 4795];
  const out = [];
  for (let p = from; p <= to; p++) if (!reserved.includes(p)) out.push(p);
  return out;
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    // no such address on this machine (no IPv6): nobody can hold the port there
    s.once('error', (e) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/**
 * A real bind test (not a connect probe like the prototype's nc) on 127.0.0.1, 0.0.0.0 and ::1. The loopback test
 * alone is not enough: with SO_REUSEADDR, macOS lets 127.0.0.1:P bind while another app holds the wildcard *:P.
 */
export async function portFree(port) {
  for (const host of ['127.0.0.1', '0.0.0.0', '::1']) if (!(await canBind(port, host))) return false;
  return true;
}

/** The first port that passes the bind test and is not reserved by a live launcher (a window in its restart gap). */
async function firstFreePort(skip = new Set()) {
  const reserved = new Set(skip);
  for (const [key, w] of Object.entries(readWindows())) if (w.launcherPid && pidAlive(w.launcherPid)) reserved.add(Number(key));
  for (const p of candidatePorts()) if (!reserved.has(p) && await portFree(p)) return p;
  return null;
}

// --- web/dist --------------------------------------------------------------------------------------------------

const SOURCES = ['web/src', 'web/index.html', 'web/public', 'web/vite.config.ts', 'web/package.json', 'shared/src',
  'package-lock.json'];
const STAMP = 'web/dist/.nb-built';

function newestMtime(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const e of fs.readdirSync(p)) if (e !== 'node_modules') max = Math.max(max, newestMtime(path.join(p, e)));
  return max;
}

/** web/dist/index.html is missing, or the stamp of the last successful build is missing or older than a source. */
export function needsBuild(repo) {
  // an installed package carries its web/dist and no sources: there is nothing to rebuild from, and nothing may be written
  if (!fs.existsSync(path.join(repo, 'web/src'))) return false;
  let built;
  try {
    fs.statSync(path.join(repo, 'web/dist/index.html'));
    built = fs.statSync(path.join(repo, STAMP)).mtimeMs;
  } catch {
    return true;
  }
  return Math.max(...SOURCES.map((p) => newestMtime(path.join(repo, p)))) > built;
}

export const buildLock = (repo) =>
  path.join(os.tmpdir(), `nota-bene-build-${createHash('sha1').update(repo).digest('hex').slice(0, 12)}.lock`);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Builds web/dist when stale: `npm run build -w web`, or NOTA_BENE_BUILD_CMD (a shell command; the tests stub it).
 * Two launchers never build at once (an mkdir lock; after lockWaitMs a lock is taken as stale and we build anyway).
 * The stamp gets the build's START time, and only if the build really wrote dist/index.html, so an edit made during
 * the build, or a stub command, still counts as stale. Returns the build output when stdio is 'pipe'.
 */
export function ensureBuild(repo, env = process.env, stdio = 'inherit', lockWaitMs = 60_000) {
  if (!needsBuild(repo)) return '';
  const lock = buildLock(repo);
  let locked = false;
  const end = Date.now() + lockWaitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      locked = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') break; // cannot lock at all: build unguarded
    }
    if (Date.now() >= end) break;
    pause(250);
    if (!needsBuild(repo)) return ''; // the other launcher built it
  }
  try {
    if (!needsBuild(repo)) return '';
    const started = Date.now();
    const cmd = env.NOTA_BENE_BUILD_CMD;
    const r = cmd
      ? spawnSync(cmd, { cwd: repo, env, stdio, shell: true })
      : spawnSync('npm', ['run', 'build', '-w', 'web'], { cwd: repo, env, stdio });
    const output = stdio === 'pipe' ? `${r.stdout ?? ''}${r.stderr ?? ''}` : '';
    if (r.status !== 0) {
      throw Object.assign(new Error(`building web/dist failed (${r.error?.message ?? `exit code ${r.status}`})`), { output });
    }
    const index = path.join(repo, 'web/dist/index.html');
    if (fs.existsSync(index) && fs.statSync(index).mtimeMs >= started - 1000) {
      fs.writeFileSync(path.join(repo, STAMP), '');
      fs.utimesSync(path.join(repo, STAMP), started / 1000, started / 1000);
    }
    return output;
  } finally {
    if (locked) fs.rmSync(lock, { recursive: true, force: true });
  }
}

// --- one window per folder ------------------------------------------------------------------------------------

/**
 * The folder's launch lock: an mkdir of <stateDir>/locks/<sha1(root)[0,16]> holding a pid file. Held from before the
 * port pick until the window answers /info and is registered, so a second launch on the folder waits, then finds that
 * window instead of starting another (two launchers' bind tests can overlap, so the port alone is no arbiter).
 * A lock whose owner is dead, or older than LOCK_STALE_MS, is broken; after LOCK_WAIT_MS we go on unguarded.
 * Returns the release function (idempotent; removes the lock only while it is still ours).
 */
export async function acquireLaunchLock(root, waitMs = LOCK_WAIT_MS) {
  const lock = path.join(stateDir(), 'locks', createHash('sha1').update(root).digest('hex').slice(0, 16));
  const pidFile = path.join(lock, 'pid');
  const owner = () => {
    try {
      // empty (the holder is between its mkdir and its write) or garbage: unknown, never "dead"
      const n = Number(fs.readFileSync(pidFile, 'utf8').trim());
      return Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  };
  const age = () => {
    try {
      return Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      return 0;
    }
  };
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(pidFile, String(process.pid));
      let held = true;
      return () => {
        if (held && owner() === process.pid) fs.rmSync(lock, { recursive: true, force: true });
        held = false;
      };
    } catch (e) {
      if (e.code !== 'EEXIST') {
        say(`cannot take the launch lock (${e.message}), going on without it`);
        return () => {};
      }
    }
    const pid = owner(); // undefined for a moment between the holder's mkdir and its pid write
    if ((pid !== undefined && !pidAlive(pid)) || age() > LOCK_STALE_MS) {
      // rename first: of two launchers breaking the same stale lock, only one succeeds, and neither removes a fresh one
      const gone = `${lock}.stale-${process.pid}`;
      try {
        if (owner() === pid) fs.renameSync(lock, gone);
        fs.rmSync(gone, { recursive: true, force: true });
      } catch {
        // someone else broke it first
      }
      continue;
    }
    if (Date.now() >= end) {
      say(`another launch on this folder holds the lock for over ${waitMs / 1000}s, going on without it`);
      return () => {};
    }
    await sleep(100);
  }
}

/**
 * A live window serving root (registry entries verified by /info; stale ones pruned), or undefined. A window of root
 * in its restart gap is waited for (up to waitMs), so the launch finds it instead of opening a second one.
 */
async function windowFor(root, waitMs = RESTART_WAIT_MS) {
  const end = Date.now() + waitMs;
  for (;;) {
    const hit = (await liveWindows((p) => probeInfo(p))).find((w) => w.root === root);
    if (hit) return hit;
    if (Date.now() >= end || !restartingWindows().some((w) => w.root === root)) return undefined;
    await sleep(250);
  }
}

/**
 * The launch re-check: the registry, else any port of the range whose /info serves root. The scan covers a window
 * whose registry write failed (the lock is released after /info answers either way) and prototype windows.
 */
async function servingWindow(root) {
  const hit = await windowFor(root);
  if (hit) return hit.port;
  const roots = await Promise.all(candidatePorts().map(async (p) => ((await probeInfo(p))?.root === root ? p : null)));
  return roots.find((p) => p !== null) ?? undefined;
}

// --- helpers for the /nb skill ---------------------------------------------------------------------------------

async function find(dir, scan = false) {
  accessToken(); // a refused token file is an error to report, not "no window" (nothing may be probed without it)
  const root = realDir(dir);
  const port = scan ? await servingWindow(root) : (await windowFor(root))?.port;
  if (port === undefined) return 1;
  process.stdout.write(`${port}\n`);
  return 0;
}

/** `http://127.0.0.1:PORT` for a port, or a loopback http URL as given (the dev server's); null for anything else. */
export function baseUrlOf(what) {
  if (/^\d{1,5}$/.test(what) && Number(what) > 0 && Number(what) < 65536) return `http://127.0.0.1:${Number(what)}`;
  const m = /^(http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5})\/?$/.exec(what);
  return m ? m[1] : null;
}

/**
 * The URL that logs a browser in, or null when the listener did not prove itself (nothing is built for it). The fragment `#t=`
 * carries the LOGIN value of that listener's launch (HMAC of port and nonce, never the raw token): a leaked URL opens that one
 * window until its launcher exits. The fragment never reaches a server, a proxy or a log, but the page's own script reads it,
 * hence the proof first. A localhost base is the dev page (Vite proxies /hello to the backend, whose proof is bound to the
 * backend's port): the backend must prove itself directly and so must the page's port through the proxy. A program that relays
 * /hello to the real backend still passes; that is dev only, and what a proxy is.
 */
export async function loginTarget(base) {
  const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/.exec(base);
  if (!m) return null;
  const port = Number(m[2]);
  const dev = m[1] === 'localhost';
  const bound = dev ? DEV_BACKEND_PORT : port;
  const n = await proveListener({ dial: bound, timeoutMs: 1500 });
  if (n === null) return null;
  if (dev && (await proveListener({ dial: port, bound, host: 'localhost', timeoutMs: 1500 })) === null) return null;
  return `${base}/#t=${loginCredential(accessToken(), bound, n)}`;
}

function last(dir) {
  const id = lastSession(realDir(dir));
  if (!id || (process.env.NOTA_BENE_AGENT === 'claude' && !transcriptExists(id))) return 1;
  process.stdout.write(`${id}\n`);
  return 0;
}

// --- launch ----------------------------------------------------------------------------------------------------

function refuse(dir) {
  const home = (() => {
    try {
      return realDir(os.homedir());
    } catch {
      return os.homedir();
    }
  })();
  return dir === home || dir === '/';
}

const OPEN_PAGE_KEEP_MS = 30_000;

/**
 * The page the browser is opened on: `open URL` would put the login URL in argv, where `ps` shows it to every user. So the
 * browser gets a file in the state dir (dir 700, file 600; only this user can read it, as the token file itself) that
 * redirects to the login URL. Removed 30 s after if this process is still running; whatever is left (a launcher that exited
 * first) is swept at the next write once it is over 10 minutes old, so a page can outlive its launch by a while (same mode and
 * trust as the token file; the login value in it dies with the launch anyway). `url` is a loginTarget().
 */
export function writeOpenPage(url) {
  const dir = path.join(stateDir(), 'open');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a plain folder (a symbolic link?); delete it`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  try {
    fs.chmodSync(dir, 0o700); // best effort, as the state dir
  } catch { /* not ours */ }
  for (const n of fs.readdirSync(dir)) {
    if (!/^open-[0-9a-f]+\.html$/.test(n)) continue; // only our own pages
    try {
      if (Date.now() - fs.lstatSync(path.join(dir, n)).mtimeMs > 10 * 60_000) fs.rmSync(path.join(dir, n), { force: true });
    } catch {
      // gone already
    }
  }
  const file = path.join(dir, `open-${randomBytes(6).toString('hex')}.html`);
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>Nota Bene</title>\n<script>location.replace(${JSON.stringify(url)})</script>\n<noscript><meta http-equiv="refresh" content="0;url=${url}"></noscript>\n`, { mode: 0o600, flag: 'wx' });
  setTimeout(() => fs.rmSync(file, { force: true }), OPEN_PAGE_KEEP_MS).unref();
  return file;
}

/**
 * Opens (or brings to front) the window in the browser, logged in. `base` is `http://127.0.0.1:PORT`. A listener that cannot prove
 * itself gets the plain base (no login value in it): the page then says it is not logged in. Resolves when the opener has handed
 * the page over (bounded); callers that do not care just do not await it.
 */
async function openBrowser(base) {
  let target = base;
  try {
    const url = await loginTarget(base);
    if (url) target = writeOpenPage(url);
    else say(`nothing on ${base} proved it is this state dir's window; opening it without a login`);
  } catch (e) {
    if (e instanceof SecretError) throw e;
    say(`cannot write the page that logs the browser in (${e.message}); opening the window without it`);
  }
  const p = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { stdio: 'ignore', detached: true });
  // true: the opener took it (exit 0, or it did not answer within the bound); false: it failed to start or exited non-zero
  return new Promise((resolve) => {
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
    setTimeout(() => resolve(true), 3000).unref(); // bounded; the child keeps the loop alive until it hands the page over
  });
}

const entryOf = (port) => readWindows()[String(port)];

/**
 * The detached launcher's log in $TMPDIR (a shared /tmp on Linux): opened without following a symlink and without blocking on a
 * FIFO (a FIFO would hang the open), and used only if it is a regular file of ours; then made 600 (an old 644 log becomes 600) and
 * emptied. Anything else: no log, one line saying so (stderr; stdout stays the one URL line). Returns the fd or null.
 */
export function openLog(log) {
  let fd;
  try {
    fd = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  } catch (e) {
    say(`no log: cannot open ${log} (${e.code ?? e.message}); the window's output is not kept`);
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (process.getuid && st.uid !== process.getuid())) {
      fs.closeSync(fd);
      say(`no log: ${log} is not a regular file of yours; the window's output is not kept`);
      return null;
    }
    fs.fchmodSync(fd, 0o600);
    fs.ftruncateSync(fd, 0);
    return fd;
  } catch (e) {
    fs.closeSync(fd);
    say(`no log: cannot prepare ${log} (${e.code ?? e.message}); the window's output is not kept`);
    return null;
  }
}

/**
 * `--detach`: re-spawn this launcher in its own session with output to the log, wait for its window, print the URL.
 * The URL is printed only once the registry has the window (the entry of our detached launcher, verified by /info),
 * or, if the detached launcher gave way to a window already open on the folder, that window's verified entry.
 */
async function detach(o, argv, autoPort, buildOutput) {
  const log = path.join(os.tmpdir(), `nota-bene-${o.port}.log`);
  const fd = openLog(log);
  if (fd !== null && buildOutput) fs.writeSync(fd, buildOutput);
  const args = argv.filter((a) => a !== '--detach');
  if (autoPort) args.push('--port', String(o.port));
  const child = spawn(process.execPath, [SELF, ...args], {
    detached: true,
    stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
    // the parent holds the folder's launch lock until the URL is printed; the child must not wait for it
    env: { ...process.env, NOTA_BENE_LOCKED: '1', ...(autoPort ? { NOTA_BENE_AUTOPORT: '1' } : {}) },
  });
  if (fd !== null) fs.closeSync(fd);
  let exitCode;
  child.on('exit', (code, signal) => (exitCode = code ?? signal));
  child.unref();

  const end = Date.now() + DETACH_WAIT_MS;
  while (Date.now() < end) {
    const gone = exitCode !== undefined;
    for (const [key, w] of Object.entries(readWindows())) {
      // a window handed over to the current version is registered by the inner launcher (our child's child) on our port
      const mine = w.launcherPid === child.pid || (!gone && Number(key) === o.port);
      if (w.root !== o.dir || !(mine || (gone && exitCode === 0 && pidAlive(w.pid)))) continue;
      if ((await probeInfo(Number(key)))?.root === o.dir) {
        // ours, or the window our launcher gave way to (it lost a port race to a launcher of the same folder)
        process.stdout.write(`${mine ? 'opened' : 'already-open'} ${(await loginTarget(`http://127.0.0.1:${key}`)) ?? `http://127.0.0.1:${key}`}\n`);
        return 0;
      }
    }
    if (gone) break;
    await sleep(250);
  }
  if (exitCode === undefined) {
    // timed out: stop the detached launcher and its server before our caller releases the folder's lock
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  say(exitCode !== undefined
    ? `the server did not come up (launcher exited: ${exitCode}). Last log lines:`
    : `the server did not come up in ${DETACH_WAIT_MS / 1000}s. Last log lines:`);
  if (fd !== null) process.stderr.write(tail(fs.readFileSync(log, 'utf8')));
  return 1;
}

function tail(text, n = 15) {
  const lines = String(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n).map((l) => `${l}\n`).join('');
}

/**
 * The supervisor loop. Resolves with the launcher's exit code; the window's registry entry goes with it, except on 77 (the
 * window goes on in another version). `init`: the launch nonce and the version the window was updated from (a handover).
 */
async function run(o, autoPort, release = () => {}, init = {}) {
  const state = Object.assign(init, { port: o.port, pid: undefined }); // the caller reads port and nonce back
  let code;
  try {
    code = await supervise(o, autoPort, release, state);
    return code;
  } finally {
    if (state.pid !== undefined && code !== HANDOVER) dropEntry(state.port, state.pid);
  }
}

/** Removes the port's entry if it is this launcher's: its last child's, or an earlier child's kept through a restart. */
function dropEntry(port, pid) {
  try {
    const w = entryOf(port);
    unregisterWindow(port, w?.launcherPid === process.pid ? w.pid : pid);
  } catch (e) {
    say(`cannot update the window registry: ${e.message}`);
  }
}

/**
 * A foreground launcher (the /nb background task) stops when the shell that started it is gone (it was SIGKILLed
 * without its children): ppid changes, checked every 2 s, and the child is stopped as on SIGTERM. Not for a detached
 * child (NOTA_BENE_LOCKED: its parent exits by design) or a launcher already reparented at start (ppid 1).
 */
function watchParent(onSignal, everyMs = 2000) {
  const parent = process.ppid;
  if (process.env.NOTA_BENE_LOCKED === '1' || parent === 1) return;
  const timer = setInterval(() => {
    if (process.ppid === parent) return;
    clearInterval(timer);
    // the shell's output pipe may be gone with it: a failed write must not crash the shutdown
    for (const s of [process.stdout, process.stderr]) s.on('error', () => {});
    say(`the parent process (pid ${parent}) is gone — stopping`);
    onSignal('SIGTERM');
  }, everyMs);
  timer.unref();
}

async function supervise(o, autoPort, release, state) {
  let port = o.port;
  let dir = o.dir; // follows the window's in-app folder switches (its registry entry), so a relaunch reopens it
  let child = null;
  let stopping = false;
  let wake = null; // cuts the 1 s crash pause short on a signal
  const onSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    if (child) child.kill(sig);
    else wake?.();
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal);
  watchParent(onSignal);

  const crashes = [];
  const restarts = [];
  const recent = (list) => {
    const now = Date.now();
    while (list.length && now - list[0] >= GUARD_WINDOW_MS) list.shift();
    list.push(now);
    return list.length;
  };
  let first = true;
  let retried = false;
  // this launch's nonce (public; server/src/auth.ts): every server this launcher starts or relaunches gets the same one, so a
  // restart keeps open tabs logged in while a value captured from an earlier launch is dead
  // Exit 75 (the user's restart) keeps it; after a crash it is replaced and the browser is opened on a fresh login, so whatever
  // the crashed launch handed out (a leaked URL, a cookie) dies with it
  // A handover passes the nonce on (state.nonce, kept up to date for the outer part)
  let nonce = state.nonce ?? newNonce();
  let crashed = false;
  const version = packageVersion();
  // the outer part withholds the permission to exit 77 once it stopped handing over (a loop, a refused release)
  const mayHandOver = PUBLISHED && state.handover !== false;
  for (;;) {
    if (crashed) {
      nonce = newNonce();
    }
    state.nonce = nonce;
    // the version updated from: for the window's first server only, so a later restart does not say "updated" again
    const env = serverEnv(process.env, process.pid, { handover: mayHandOver, updatedFrom: first ? state.updatedFrom : undefined });
    env.NOTA_BENE_NONCE = nonce;
    delete env.NOTA_BENE_AUTOPORT;
    delete env.NOTA_BENE_LOCKED;
    delete env.NOTA_BENE_INNER;
    delete env.NOTA_BENE_HANDOVER_NONCE;
    const c = spawn(process.execPath, [MAIN, ...serverArgs({ ...o, dir }, port, !first)], {
      cwd: REPO,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child = c;
    state.pid = c.pid;
    const exited = new Promise((resolve) => c.on('exit', (code, signal) => resolve({ code, signal })));
    let done = false;
    void exited.then(() => (done = true));

    // register once /info answers; the root comes from the server, which re-registers itself on a folder switch
    while (!done) {
      const got = await probeInfo(port);
      if (got && !done) {
        try {
          registerWindow(port, got.root, c.pid, process.pid, version);
        } catch (e) {
          say(`cannot register the window: ${e.message}`); // the window works without it; --find falls back
        }
        release(); // registered: a later launch on the folder finds this window
        if ((first || crashed) && o.open && !stopping) void openBrowser(`http://127.0.0.1:${port}`).catch(() => {});
        crashed = false;
        break;
      }
      await Promise.race([sleep(250), exited]);
    }
    const { code, signal } = await exited;
    child = null;
    // the entry stays (pid dead, launcher alive = restarting) so no other launch takes the port before the relaunch
    const w = entryOf(port);
    if (w?.pid === c.pid && w.root !== dir && fs.existsSync(w.root)) dir = w.root;
    if (stopping) return 0;

    if (!first && code === LISTEN_FAILED) {
      say(`port ${port} was taken during the restart — giving up`);
      return LISTEN_FAILED;
    }

    if (first && code === LISTEN_FAILED) {
      if (!autoPort || retried) {
        say(`port ${port} is in use`);
        return LISTEN_FAILED;
      }
      // the bind test passed, then another launcher took the port first: if it serves this folder, it is ours
      const holder = await probeInfo(port, 1000);
      if (holder?.root === dir) {
        if (o.open) await openBrowser(`http://127.0.0.1:${port}`); // bring it to front
        process.stdout.write(`nota-bene: already open at http://127.0.0.1:${port}\n`);
        return 0;
      }
      const next = await firstFreePort(new Set([port]));
      if (stopping) return 0;
      if (next === null) {
        say(`port ${port} was taken and there is no other free port in ${portRange().join('–')}`);
        return LISTEN_FAILED;
      }
      say(`port ${port} was taken meanwhile, retrying on ${next}`);
      dropEntry(port, c.pid); // a holder's /info may have got us registered there
      port = next;
      state.port = next;
      retried = true;
      continue; // still the first start: the original --resume/--fork/--new apply
    }

    if (code === NO_AGENT_BINARY) return code;
    if (code === HANDOVER && mayHandOver) {
      // the entry stays: the outer part reads the port, the folder and this launch's nonce from it (the state dir is private)
      try {
        registerWindow(port, dir, c.pid, process.pid, version, nonce);
      } catch (e) {
        say(`cannot update the window registry: ${e.message}`); // the outer part then hands over with a fresh nonce
      }
      return code;
    }

    if (code === RESTART) {
      const n = recent(restarts);
      if (n > MAX_RESTARTS) {
        say(`server asked for ${n} restarts in the last minute — restarting in a loop, giving up`);
        return RESTART;
      }
    } else if (code !== null && CLEAN_EXITS.has(code)) {
      return code;
    } else {
      const n = recent(crashes);
      const how = code !== null ? `with code ${code}` : `by ${signal}`;
      if (n >= MAX_CRASHES) {
        say(`server exited ${how} (${n} crashes in the last minute) — crashing in a loop, giving up`);
        return code ?? 128 + (os.constants.signals[signal] ?? 0);
      }
      say(`server exited ${how} — relaunching (${n} crash(es) in the last minute)`);
      crashed = true;
      await new Promise((r) => {
        wake = r;
        setTimeout(r, 1000);
      });
      wake = null;
      if (stopping) return 0;
    }
    first = false;
  }
}

async function main(argv) {
  // a command of its own, with its own arguments (server/src/remote/cli.ts): before the window options are parsed
  if (argv[0] === 'remote') return (await import('../server/src/remote/cli.ts')).remoteMain(argv.slice(1));
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  if (o.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (o.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  // a bare launch in a terminal asks which agent when more than one can start; anything else (a script, a skill, the detached
  // or inner launcher this one starts) gets Claude unless --agent says otherwise, as before
  const launching = o.find === undefined && o.last === undefined && o.url === undefined && o.front === undefined;
  if (launching && o.agent === undefined && !INNER && process.env.NOTA_BENE_LOCKED !== '1' && process.stdin.isTTY && process.stderr.isTTY) {
    const chosen = await chooseAgent(o.dir);
    if (chosen === null) return 130;
    if (chosen !== undefined) {
      o.agent = chosen;
      argv = [...argv, '--agent', chosen]; // a detached launcher re-reads argv
    }
  }
  process.env.NOTA_BENE_AGENT = o.agent ?? 'claude';
  try {
    if (o.find !== undefined) return await find(o.find, o.scan);
    if (o.last !== undefined) return last(o.last);
    if (o.url !== undefined || o.front !== undefined) {
      const base = baseUrlOf(o.url ?? o.front);
      if (!base) {
        say(`not a window port or a loopback URL: ${o.url ?? o.front}`);
        return 2;
      }
      const url = await loginTarget(base);
      if (!url) {
        say(`nothing on ${base} proved it is a Nota Bene ${base.includes('localhost') ? `dev page (backend on ${DEV_BACKEND_PORT})` : 'window'} of this state dir`);
        return 1;
      }
      // the login value dies with that window's launcher: a URL kept from earlier needs a new --url
      if (o.url !== undefined) process.stdout.write(`${url}\n`);
      else if (!(await openBrowser(base))) {
        say(`the browser could not be opened; run \`nota-bene --url ${new URL(base).port}\` and open the URL it prints`);
        return 1;
      }
      return 0;
    }
    o.dir = realDir(o.dir ?? '.');
  } catch (e) {
    say(e.message);
    return e instanceof SecretError ? EXIT_SECRET : 1;
  }
  if (refuse(o.dir)) {
    say(`refusing to open the whole ${o.dir} as a project — cd into a project first.`);
    return 1;
  }
  rememberAgent(stateBaseDir(), o.dir, o.agent ?? 'claude');
  // the secrets, before any spawn: a refused one is reported once here, never as a crash loop of servers that die on it
  try {
    accessToken();
    stateSecret('control-token');
  } catch (e) {
    say(e.message);
    return 1;
  }
  // build first, pick the port after: a long build must not widen the race between the bind test and the listen
  let buildOutput = '';
  try {
    buildOutput = ensureBuild(REPO, process.env, o.detach ? 'pipe' : 'inherit'); // --detach: stdout stays one line
  } catch (e) {
    say(e.message);
    if (e.output) process.stderr.write(tail(e.output));
    return 1;
  }
  // one window per folder: wait for any launch in progress on it, then give way to a window already serving it
  // a detached child (the parent holds the lock and checked) or an inner launcher (its outer part did)
  const locked = process.env.NOTA_BENE_LOCKED === '1' || INNER;
  const release = locked ? () => {} : await acquireLaunchLock(o.dir);
  try {
    if (!locked) {
      const port = await servingWindow(o.dir);
      if (port !== undefined) {
        const url = `http://127.0.0.1:${port}`;
        if (o.open) await openBrowser(url); // bring it to front
        process.stdout.write(o.detach ? `already-open ${(await loginTarget(url)) ?? url}\n` : `nota-bene: already open at ${url}\n`);
        return 0;
      }
    }
    return await launch(o, argv, buildOutput, release);
  } finally {
    release();
  }
}

/**
 * The agent for a bare launch in a terminal: the only one that can start here, or the user's pick from a menu on stderr (Enter
 * takes the one last used in the folder). undefined: none found, or the folder is unreadable (the launch reports it); null: the
 * user cancelled (Ctrl+C, Ctrl+D).
 */
async function chooseAgent(dir) {
  let root;
  try {
    root = realDir(dir ?? '.');
  } catch {
    return undefined;
  }
  const found = await detectAgents(process.env);
  const usable = found.filter((f) => !f.tooOld).map((f) => f.agent);
  if (usable.length < 2) return usable[0];
  const last = lastAgent(stateBaseDir(), root);
  const fallback = defaultChoice(usable, last);
  process.stderr.write(menu(found, fallback, last));
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  let answered = () => {};
  const cancel = () => answered(null);
  rl.on('SIGINT', cancel).on('close', cancel);
  const ask = (q) => new Promise((resolve) => {
    answered = resolve;
    rl.question(q, resolve);
  });
  try {
    for (;;) {
      const answer = await ask(`Agent [${usable.indexOf(fallback) + 1}]: `);
      if (answer === null) {
        process.stderr.write('\n');
        return null;
      }
      const pick = parseChoice(answer, usable, fallback);
      if (pick) return pick;
      say(`type 1–${usable.length}, an agent's name, or Enter for ${fallback}`);
    }
  } finally {
    rl.close();
  }
}

async function launch(o, argv, buildOutput, release) {
  const picked = o.port === undefined;
  // a detached launcher gets its port from the parent's pick (NOTA_BENE_AUTOPORT), so it may still retry once on a race
  const autoPort = picked || process.env.NOTA_BENE_AUTOPORT === '1';
  if (picked) {
    o.port = await firstFreePort();
    if (o.port === null) {
      say(`no free port in ${portRange().join('–')}`);
      return 1;
    }
  }
  if (o.detach) return detach(o, argv, picked, buildOutput);
  if (INNER) {
    const from = process.env.NOTA_BENE_UPDATED_FROM;
    return run(o, autoPort, release, {
      nonce: isNonce(process.env.NOTA_BENE_HANDOVER_NONCE) ? process.env.NOTA_BENE_HANDOVER_NONCE : undefined,
      updatedFrom: from && RELEASE.test(from) ? from : undefined,
    });
  }
  return outer(o, autoPort, release);
}

/**
 * The outer part: runs the window in the newest version, and again in the current one each time a version exits 77. The
 * version is this launcher's own (in-process, `run`) unless `current` names a newer release: then that version's launcher
 * runs as a child (NOTA_BENE_INNER), stdio inherited, signals passed on, its exit code passed through. Every run keeps the
 * port and the launch nonce; after the first one the window continues its session and the browser is not opened again.
 * A handed-over version that fails (see the top of the file) is rolled back and not tried again by this outer part.
 */
async function outer(o, autoPort, release) {
  const own = packageVersion();
  let stopping = false;
  let inner = null;
  const onSignal = (sig) => {
    stopping = true;
    inner?.kill(sig); // in its own process group, so a terminal's Ctrl-C reaches it only from here; in-process, supervise has its own
  };
  const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of sigs) process.on(sig, onSignal);
  watchParent(onSignal);
  let up = false; // a window answered: later runs continue it, without --resume/--new and without opening the browser
  const registered = () => {
    up = true;
    release();
  };
  let nonce = newNonce();
  let from; // the version the window was just updated from (NOTA_BENE_UPDATED_FROM)
  let previous = own; // what the window ran before the next handover: a rollback goes back to it
  let retried = false;
  const refused = new Set(); // rolled back: never handed over to again by this outer part
  let handingOver = true; // false once a loop or a refused release stopped it: the own version runs, its server may not exit 77
  const handovers = [];
  const innerPids = new Set();
  try {
    for (;;) {
      const t = PUBLISHED ? handoverTarget({ own, current: readCurrent(), published: true }) : null; // a checkout never reads it
      if (t !== null && refused.has(t)) handingOver = false;
      const target = handingOver ? t : null;
      const opts = up ? { ...o, resume: undefined, fork: false, new: false, continue: true, open: false } : o;
      let code;
      let ran = own;
      if (target === null) {
        const state = { nonce, updatedFrom: from, handover: handingOver };
        code = await run(opts, up ? false : autoPort, registered, state);
        nonce = state.nonce ?? nonce;
        o.port = state.port; // a first start may have moved on a lost port race
        const w = entryOf(o.port);
        if (code === HANDOVER && w?.launcherPid === process.pid && fs.existsSync(w.root)) o.dir = w.root;
      } else {
        ran = target;
        const args = [...serverArgs({ ...opts, agent: o.agent ?? 'claude' }, o.port, false), ...(opts.open ? [] : ['--no-open'])];
        const env = { ...process.env, NOTA_BENE_INNER: '1', NOTA_BENE_HANDOVER_NONCE: nonce };
        delete env.NOTA_BENE_LOCKED; // the inner launcher watches us as its parent
        delete env.NOTA_BENE_AUTOPORT;
        delete env.NOTA_BENE_UPDATED_FROM;
        if (from) env.NOTA_BENE_UPDATED_FROM = from;
        const started = Date.now();
        // its own process group: a version that hangs is stopped with its server, which may ignore SIGTERM and hold the port
        const c = spawn(process.execPath, [launcherOf(target), ...args], { env, stdio: 'inherit', detached: true });
        inner = c;
        innerPids.add(c.pid);
        const exited = new Promise((resolve) => {
          c.on('exit', (code, signal) => resolve({ code, signal }));
          c.on('error', (e) => resolve({ code: null, signal: null, error: e }));
        });
        let done = false;
        void exited.then(() => (done = true));
        let failed = null;
        let answered = false;
        while (!done && !stopping) {
          if (await probeInfo(o.port)) {
            answered = true;
            break;
          }
          if (Date.now() - started >= HANDOVER_INFO_MS) break;
          await Promise.race([sleep(250), exited]);
        }
        if (answered) registered();
        else if (!done && !stopping) {
          failed = `no answer on /info within ${HANDOVER_INFO_MS / 1000} s`;
          c.kill('SIGTERM');
          if (!(await Promise.race([exited, sleep(5000).then(() => null)]))) killGroup(c.pid);
        }
        const r = await exited;
        inner = null;
        if (r.error && !failed) failed = `its launcher did not start (${r.error.message})`;
        if (stopping) return r.code ?? 0;
        if (r.code === NO_AGENT_BINARY) return r.code; // the server said why; not the new version's fault, no rollback
        if (!failed && r.code === LISTEN_FAILED && !up) {
          // the port was taken (between our pick and its listen, or an explicit busy --port): not the new version's fault
          if (!autoPort || retried) return LISTEN_FAILED;
          const next = await firstFreePort(new Set([o.port]));
          if (next === null) return LISTEN_FAILED;
          say(`port ${o.port} was taken meanwhile, retrying on ${next}`);
          o.port = next;
          retried = true;
          continue;
        }
        const clean = r.code !== null && (CLEAN_EXITS.has(r.code) || r.code === HANDOVER);
        if (!failed && !clean && Date.now() - started < HANDOVER_EXIT_MS) {
          failed = `its launcher exited ${r.code !== null ? `with code ${r.code}` : `by ${r.signal}`} within ${HANDOVER_EXIT_MS / 1000} s`;
        }
        if (failed) {
          killGroup(c.pid); // whatever of it is left (a hung server)
          await portFreed(o.port, () => stopping);
          rollBack(target, previous, failed);
          refused.add(target);
          if (stopping) return 0; // a signal during the wait: the window stops, the previous version is not started
          from = undefined;
          delete process.env.NOTA_BENE_TEST_CRASH;
          continue; // on the previous version, same port and nonce
        }
        code = r.code ?? 128 + (os.constants.signals[r.signal] ?? 0);
        if (code === HANDOVER) {
          // the inner launcher kept its entry: the window's port and folder now; keep the port reserved by us for the gap
          const hit = Object.entries(readWindows()).find(([, w]) => w.launcherPid === c.pid);
          // its nonce, when it recorded one: a launch that replaced it after a crash never gets the stale one back
          nonce = isNonce(hit?.[1].nonce) ? hit[1].nonce : newNonce();
          if (hit) {
            const [key, w] = hit;
            o.port = Number(key);
            if (fs.existsSync(w.root)) o.dir = w.root;
            try {
              registerWindow(o.port, w.root, w.pid, process.pid, w.version);
            } catch (e) {
              say(`cannot update the window registry: ${e.message}`);
            }
          }
        }
      }
      // TEST-ONLY hook (server/src/main.ts): fires on the first server run only, so a test's own server does not exit 77 for good
      delete process.env.NOTA_BENE_TEST_CRASH;
      if (stopping || code !== HANDOVER) return code;
      const now = Date.now();
      while (handovers.length && now - handovers[0] >= GUARD_WINDOW_MS) handovers.shift();
      handovers.push(now);
      if (handovers.length > MAX_RESTARTS) {
        // the window keeps running: on the own version, whose server may not exit 77
        say(`${handovers.length} handovers in the last minute — handing over in a loop, staying on ${own}`);
        handingOver = false;
      }
      from = ran;
      previous = ran;
    }
  } finally {
    for (const sig of sigs) process.off(sig, onSignal);
    // an entry left by a 77 that no run took over (we stopped in the gap): ours to remove
    try {
      const w = entryOf(o.port);
      if (w && (w.launcherPid === process.pid || innerPids.has(w.launcherPid)) && !pidAlive(w.pid)) unregisterWindow(o.port, w.pid);
    } catch (e) {
      say(`cannot update the window registry: ${e.message}`);
    }
  }
}

/** SIGKILLs a process group, if any of it is left. */
function killGroup(pgid) {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // all gone
  }
}

/** Waits (bounded, and no longer once `stop()` says so) until a killed window's port is free again, so the next run does not fail to listen on it. */
async function portFreed(port, stop = () => false, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !stop() && !(await portFree(port))) await sleep(100);
}

/** `current` goes back to the version that ran before (only while it still names the failed one); the window says why. */
function rollBack(failedVersion, back, reason) {
  say(`${failedVersion} did not come up (${reason}) — rolled back to ${back}`);
  try {
    writeCurrent(back, failedVersion);
    patchUpdateState((s) => ({ ...s, rolledBack: { version: failedVersion, at: Date.now() } }));
    fs.appendFileSync(path.join(runtimeDir(), 'update.log'),
      `${new Date().toISOString()} ${failedVersion} failed in a window: ${reason}; rolled back to ${back}\n`, { mode: 0o600 });
  } catch (e) {
    say(`cannot record the rollback: ${e.message}`);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      say(e instanceof Error ? e.stack ?? e.message : String(e));
      process.exit(1);
    },
  );
}
