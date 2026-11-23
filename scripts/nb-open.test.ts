// Runs plugin/skills/nb/open.mjs (the /nb skill's launcher) with this node, a temp HOME / NOTA_BENE_HOME / CLAUDE_CONFIG_DIR,
// stub `open` / `xdg-open` on PATH (no real browser), fake windows on 4791-4795 that answer /info, and either:
//  - a stub app (a copy of open.mjs beside a stub bin/nota-bene.mjs that records its argv and hands --find / --last to
//    the real bin), for argument, guard and output checks; or
//  - the real bin with the fake agent (NOTA_BENE_FAKE), for the concurrent-open test.
// The plan's commands are read back by bash (Git Bash on Windows, the shell of Claude Code's Bash tool there).
// Every server the real bin starts is killed in afterAll, and the process list must show nothing of ours left.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSlash } from '@nota-bene/shared/paths';
import { loginCredential, proofFor } from '../server/src/auth.ts';
import { killTree, resolveBin } from '../server/src/platform.ts';
import { q } from '../plugin/skills/nb/open.mjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const WIN = process.platform === 'win32';
const SKILL = fileURLToPath(new URL('../plugin/skills/nb', import.meta.url)); // not beside the test: the plugin dir ships to users
const REAL_BIN = fileURLToPath(new URL('../bin/nota-bene.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('../server/test/fixtures/hello.json', import.meta.url));
const SID = '0123abcd-4567-89ab-cdef-0123456789ab';
/** A path as open.mjs prints and passes it on: forward slashes on Windows (C:/Users/x), as it is elsewhere. */
const shown = (p: string): string => (WIN ? toSlash(p) : p);
/** The bash that reads the plan back: /bin/bash, or Git for Windows' bash.exe (never WSL's System32\bash.exe). */
const BASH = ((): string | null => {
  if (!WIN) return '/bin/bash';
  const git = resolveBin('git');
  if (!git) return null;
  for (const up of [2, 3]) { // <Git>\cmd\git.exe or <Git>\mingw64\bin\git.exe
    let d = git;
    for (let i = 0; i < up; i++) d = path.dirname(d);
    if (fs.existsSync(path.join(d, 'bin', 'bash.exe'))) return path.join(d, 'bin', 'bash.exe');
  }
  return null;
})();

let tmp: string; // the whole suite's temp root (also TMPDIR of every run)
let home: string; // HOME of every run
let nbHome: string;
let claudeDir: string;
let project: string;
let stubApp: string; // tmp/stub-skills/nb/open.mjs → tmp/app/plugin/skills/nb (a symlink, like ~/.claude/skills/nb; a junction on Windows)
let realSkill: string; // tmp/real-skills/nb/open.mjs → <repo>/plugin/skills/nb
let pkgOpen: string; // a plugin-cache layout with NO checkout above it: tmp/cache/nota-bene/9.9.9/skills/nb/open.mjs
const PKG_VER = '9.9.9';
const servers: http.Server[] = [];

beforeAll(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-skill-')));
  // the stub app: open.mjs resolves the app from its own (physical) location, so a copy beside a stub bin uses the stub
  fs.mkdirSync(path.join(tmp, 'app/plugin/skills/nb'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'app/bin'));
  fs.copyFileSync(path.join(SKILL, 'open.mjs'), path.join(tmp, 'app/plugin/skills/nb/open.mjs'));
  // Windows: --front is answered here, recorded in fronted.log (the launcher's Windows opener has no stub on PATH)
  fs.writeFileSync(path.join(tmp, 'app/bin/nota-bene.mjs'), `
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === '--front' && process.env.STUB_FRONT_FAIL) process.exit(1);
if (argv[0] === '--front' && process.platform === 'win32') {
  fs.appendFileSync(process.env.STUB_FRONTED, argv[1] + '\\n');
  process.exit(0);
}
if (['--find', '--last', '--url', '--front'].includes(argv[0])) {
  const r = spawnSync(process.execPath, [process.env.STUB_REAL_BIN, ...argv], { stdio: 'inherit', windowsHide: true });
  process.exit(r.status ?? 1);
}
fs.appendFileSync(process.env.STUB_ARGV, JSON.stringify(argv) + '\\n');
if (process.env.STUB_FAIL) {
  process.stderr.write('nota-bene: the server did not come up in 20s. Last log lines:\\nboom: the last log line\\n');
  process.exit(1);
}
process.stdout.write((process.env.STUB_OUT || 'opened http://127.0.0.1:4795') + '\\n');
process.exit(Number(process.env.STUB_EXIT || 0));
`);
  for (const [name, target] of [['stub-skills', path.join(tmp, 'app/plugin/skills/nb')], ['real-skills', SKILL]] as const) {
    fs.mkdirSync(path.join(tmp, name));
    fs.symlinkSync(target, path.join(tmp, name, 'nb'), WIN ? 'junction' : 'dir');
  }
  stubApp = path.join(tmp, 'stub-skills/nb/open.mjs');
  realSkill = path.join(tmp, 'real-skills/nb/open.mjs');
  // the plugin as the plugin cache holds it (<plugin>/<version>/{.claude-plugin,skills/nb}), no bin/ anywhere above
  const cacheVer = path.join(tmp, 'cache/nota-bene', PKG_VER);
  fs.mkdirSync(path.join(cacheVer, 'skills/nb'), { recursive: true });
  fs.mkdirSync(path.join(cacheVer, '.claude-plugin'));
  fs.copyFileSync(path.join(SKILL, 'open.mjs'), path.join(cacheVer, 'skills/nb/open.mjs'));
  fs.writeFileSync(path.join(cacheVer, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'nota-bene', version: PKG_VER }, null, 2));
  pkgOpen = path.join(cacheVer, 'skills/nb/open.mjs');
  // no real browser: `open` / `xdg-open` record their argument
  fs.mkdirSync(path.join(tmp, 'path'));
  for (const name of ['open', 'xdg-open']) {
    const f = path.join(tmp, 'path', name);
    fs.writeFileSync(f, `#!/bin/sh\necho "$1" >> "${tmp}/opened.log"\n`);
    fs.chmodSync(f, 0o755);
  }
  // a stub npm: records its argv; `install --prefix P pkg@v` puts the stub launcher where the package's bin would be.
  // Windows: npm.cmd with node_modules/npm/bin/npm-cli.js beside it, as Node's installer lays it out (open.mjs runs the .js)
  const npmJs = `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_NPM_LOG, JSON.stringify(a) + '\\n');
if (process.env.STUB_NPM_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_NPM_SLEEP) * 1000);
if (process.env.STUB_NPM_FAIL) { process.stderr.write('npm ERR! boom: the last npm line\\n'); process.exit(1); }
const bin = path.join(a[a.indexOf('--prefix') + 1], 'node_modules/nota-bene-ide/bin');
fs.mkdirSync(bin, { recursive: true });
fs.copyFileSync(process.env.STUB_BIN_SRC, path.join(bin, 'nota-bene.mjs'));
`;
  if (WIN) {
    fs.writeFileSync(path.join(tmp, 'path/npm.cmd'), '@echo off\r\necho the stub npm.cmd must not be run 1>&2\r\nexit /b 9\r\n');
    fs.mkdirSync(path.join(tmp, 'path/node_modules/npm/bin'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'path/node_modules/npm/bin/npm-cli.js'), npmJs);
  } else {
    fs.writeFileSync(path.join(tmp, 'path/npm'), `#!${process.execPath}${npmJs}`);
    fs.chmodSync(path.join(tmp, 'path/npm'), 0o755);
  }
});

beforeEach(() => {
  const t = fs.mkdtempSync(path.join(tmp, 't-'));
  home = path.join(t, 'home');
  // Windows: USERPROFILE is the temp home, and a state folder outside the profile is refused (state.ts sharedHomeRefusal)
  nbHome = WIN ? path.join(home, 'nb') : path.join(t, 'nb');
  claudeDir = path.join(t, 'claude');
  project = path.join(t, 'project');
  for (const d of [home, nbHome, claudeDir, project]) fs.mkdirSync(d);
  for (const f of ['opened.log', 'fronted.log', 'npm.log']) fs.rmSync(path.join(tmp, f), { force: true });
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

// every process the real bin started serves a folder under tmp: kill them all, then check that none is left
function ours(): number[] {
  const list = WIN
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'], { encoding: 'utf8', windowsHide: true })
    : execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return list.split(/\r?\n/).filter((l) => (l.includes(tmp) || l.includes(shown(tmp))) && !l.includes('ps -axo') && !l.includes('Win32_Process'))
    .map((l) => Number(l.trim().split(/\s+/)[0])).filter((pid) => pid !== process.pid);
}
afterAll(async () => {
  for (const pid of ours()) killTree(pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  const left = ours();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  expect(left).toEqual([]);
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  // one PATH key: Windows spells it Path, and a second spelling in a child's env is ambiguous
  const e: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  Object.assign(e, {
    PATH: [path.join(tmp, 'path'), path.dirname(process.execPath), process.env.PATH ?? process.env.Path].join(path.delimiter), // a node >= 23.6 first
    HOME: home,
    NOTA_BENE_HOME: nbHome,
    CLAUDE_CONFIG_DIR: claudeDir,
    NOTA_BENE_PORT_RANGE: '4791-4795',
    NOTA_BENE_BUILD_CMD: 'true', // never run the real vite build from a test
    TMPDIR: tmp,
    ...(WIN ? { TEMP: tmp, TMP: tmp, USERPROFILE: home } : {}),
    STUB_REAL_BIN: REAL_BIN,
    STUB_ARGV: path.join(tmp, 'argv.log'),
    STUB_FRONTED: path.join(tmp, 'fronted.log'),
    STUB_NPM_LOG: path.join(tmp, 'npm.log'),
    STUB_BIN_SRC: path.join(tmp, 'app/bin/nota-bene.mjs'),
  });
  delete e.NOTA_BENE_SUPERVISED;
  delete e.NOTA_BENE_FAKE;
  delete e.NB_TEST_NODE_VERSION;
  for (const [k, v] of Object.entries(extra)) {
    if (v === '') delete e[k]; // '' unsets
    else e[k] = v;
  }
  return e;
};

type Result = { code: number; out: string };
type RunOpts = { cwd?: string; env?: Record<string, string> };
/** Runs `file argv...` in the test environment. */
function exec(file: string, argv: string[], o: RunOpts = {}) {
  return new Promise<Result>((resolve) => {
    execFile(file, argv, { cwd: o.cwd ?? project, env: env(o.env), timeout: 30_000, windowsHide: true },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? -1) : 0, out: stdout + stderr }));
  });
}
/** Runs `node <open.mjs> argv...`, as the skill does. */
const sh = (argv: string[], o: RunOpts = {}) => exec(process.execPath, argv, o);
/** Runs a command line in bash, as Claude Code's Bash tool runs the plan's commands. */
const bash = (line: string, o: RunOpts & { shell?: string } = {}) => exec(o.shell ?? BASH!, ['-c', line], o);
function nb(args: string, o: RunOpts & { sid?: string; script?: string } = {}) {
  fs.rmSync(path.join(tmp, 'argv.log'), { force: true });
  return sh([o.script ?? stubApp, args, o.sid ?? SID], o);
}
const launches = (): string[][] => {
  try {
    return fs.readFileSync(path.join(tmp, 'argv.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const logLines = (name: string): string[] => {
  try {
    return fs.readFileSync(path.join(tmp, name), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
/** What a browser opener was asked to open (Windows: the ports the stub --front was asked for). */
const opened = (): string[] => [...logLines('opened.log'), ...logLines('fronted.log')];

/** The access token of the test's state dir (the launcher creates it on first use). */
const tokenOf = (): string => fs.readFileSync(path.join(nbHome, 'token'), 'utf8').trim();
/** The login URL the launcher builds for a window on `port` (the fake windows' launch nonce): in the redirect pages, never in the skill's output. */
const tokUrl = (port: number): string => `http://127.0.0.1:${port}/#t=${loginCredential(tokenOf(), port, 'f0'.repeat(16))}`;
/** The URL the skill prints: plain, the transcript and the API never see the token. */
const plainUrl = (port: number): string => `http://127.0.0.1:${port}`;
/** What the browser was asked to open: pages in the state dir (never a URL, so never a token in argv); the URL each redirects to.
 *  Windows: the login URL of each port the stub --front was asked to bring to front. */
const openedUrls = (): string[] => (WIN ? logLines('fronted.log').map((p) => tokUrl(Number(p))) : logLines('opened.log').map((f) => {
  expect(f).not.toMatch(/^https?:/);
  expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  return /location\.replace\("([^"]+)"\)/.exec(fs.readFileSync(f, 'utf8'))![1]!;
}));

/** A directory holding executables: [name, script] are written, [name, path] of an existing file are symlinked (POSIX only). */
function binDir(name: string, tools: [string, string][]): string {
  const d = path.join(tmp, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d);
  for (const [tool, what] of tools) {
    if (what.startsWith('#!')) {
      fs.writeFileSync(path.join(d, tool), what);
      fs.chmodSync(path.join(d, tool), 0o755);
    } else fs.symlinkSync(what, path.join(d, tool));
  }
  return d;
}

/** A window on `port` whose /info says `root`. */
async function fakeWindow(port: number, root: string): Promise<void> {
  const s = http.createServer((req, res) => {
    // proves itself as a window of this state dir would (the launcher sends nothing before it does)
    const m = /^\/hello\?c=([0-9a-f]+)$/.exec(req.url ?? '');
    if (m && !fs.existsSync(path.join(nbHome, 'token'))) res.writeHead(503).end(); // no token yet: nothing to prove with
    else if (m) res.setHeader('content-type', 'application/json').end(JSON.stringify({ proof: proofFor(tokenOf(), port, 'f0'.repeat(16), m[1]!), n: 'f0'.repeat(16) }));
    else if (req.url === '/info') res.setHeader('content-type', 'application/json').end(JSON.stringify({ root, session: null }));
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));
  servers.push(s);
}
function register(port: number, root: string, pid: number): void {
  fs.mkdirSync(path.join(nbHome, 'windows'), { recursive: true });
  fs.writeFileSync(path.join(nbHome, 'windows', `${port}.json`), JSON.stringify({ root, pid, startedAt: Date.now() }));
}
const registry = (): string[] => {
  try {
    return fs.readdirSync(path.join(nbHome, 'windows')).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
};

describe('arguments', () => {
  it('an unknown argument prints the usage line and launches nothing', async () => {
    const r = await nb('frobnicate');
    expect(r.code).toBe(0);
    expect(r.out).toBe("NB: unknown argument 'frobnicate'. Use /nb (resume the last window session here), /nb new, or "
      + '/nb fork (carry this conversation over).\n');
    expect(launches()).toEqual([]);
  });

  it.each(['-n', 'new please'])('%j is an unknown argument too, and launches nothing', async (arg) => {
    const r = await nb(arg);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`NB: unknown argument '${arg}'. Use /nb (resume the last window session here), /nb new, or `
      + '/nb fork (carry this conversation over).\n');
    expect(launches()).toEqual([]);
  });

  it.each(['new', 'новая'])('%j starts a new session (--new)', async (arg) => {
    const r = await nb(arg);
    expect(r.code).toBe(0);
    expect(launches()).toEqual([[project, '--detach', '--agent', 'claude', '--new']]);
    expect(r.out).toBe(`NB: opened http://127.0.0.1:4795 for ${shown(project)}. Log: ${shown(path.join(tmp, 'nota-bene-4795.log'))}\n`);
  });

  it.each(['fork', 'FORK', 'форк'])('%j forks the caller (--resume SID --fork)',
    async (arg) => {
      const r = await nb(arg);
      expect(r.code).toBe(0);
      expect(launches()).toEqual([[project, '--detach', '--agent', 'claude', '--resume', SID, '--fork']]);
      expect(r.out).toMatch(/\(forked from this conversation\)/);
    });

  it('fork refuses a session id that is not a UUID', async () => {
    for (const sid of ['', 'not-a-session', '0123abcd-4567-89ab-cdef-0123456789ab; rm -rf ~', '------------------------------------']) {
      const r = await nb('fork', { sid });
      expect(r.code).toBe(1);
      expect(r.out).toBe(`NB: no valid session id to fork ('${sid}').\n`);
    }
    expect(launches()).toEqual([]);
  });

  it('no argument launches with the default resume; --last only words the note', async () => {
    let r = await nb('');
    expect(launches()).toEqual([[project, '--detach', '--agent', 'claude']]);
    expect(r.out).toBe(`NB: opened http://127.0.0.1:4795 for ${shown(project)} (new session: no earlier window session for this `
      + `folder). Log: ${shown(path.join(tmp, 'nota-bene-4795.log'))}\n`);

    const id = 'feedface-0000-4000-8000-000000000001';
    fs.writeFileSync(path.join(nbHome, 'sessions.json'), JSON.stringify({ [project]: id }));
    r = await nb('');
    expect(r.out).toMatch(/\(new session: no earlier window session/); // saved, but its transcript is gone
    fs.mkdirSync(path.join(claudeDir, 'projects/p'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'projects/p', `${id}.jsonl`), '');
    r = await nb('');
    expect(launches()).toEqual([[project, '--detach', '--agent', 'claude']]); // the server resumes it itself
    expect(r.out).toBe(`NB: opened http://127.0.0.1:4795 for ${shown(project)} (resumed the last window session feedface). `
      + `Log: ${shown(path.join(tmp, 'nota-bene-4795.log'))}\n`);
  });

  it('NOTA_BENE_FAKE (test only) is passed on as --fake', async () => {
    await nb('new', { env: { NOTA_BENE_FAKE: FAKE } });
    expect(launches()).toEqual([[project, '--detach', '--agent', 'claude', '--new', '--fake', FAKE]]);
  });

  it('the launcher\'s lines carry #t=TOKEN; what the skill prints never does (it enters the transcript and the API)', async () => {
    const tok = 'ab'.repeat(32);
    let r = await nb('', { env: { STUB_OUT: `opened http://127.0.0.1:4795/#t=${tok}` } });
    expect(r.out).toMatch(/^NB: opened http:\/\/127\.0\.0\.1:4795 for .*Log: /);
    expect(r.out).not.toContain(tok);
    r = await nb('', { env: { STUB_OUT: `already-open http://127.0.0.1:4794/#t=${tok}` } });
    expect(r.out).toBe('NB: already open at http://127.0.0.1:4794 (brought to front).\n');
    expect(r.out).not.toContain(tok);
  });

  it('an agent of the running server (epic 383): its URL under /a/<id>/, without the login', async () => {
    const tok = 'ab'.repeat(32);
    let r = await nb('new', { env: { STUB_OUT: `opened http://127.0.0.1:4795/a/claude-k3f7qz/#t=${tok}` } });
    expect(r.out).toBe(`NB: opened http://127.0.0.1:4795/a/claude-k3f7qz/ for ${shown(project)}. Log: ${shown(path.join(tmp, 'nota-bene-4795.log'))}\n`);
    r = await nb('', { env: { STUB_OUT: `already-open http://127.0.0.1:4795/a/codex-k3f7qz/#t=${tok}` } });
    expect(r.out).toBe('NB: already open at http://127.0.0.1:4795/a/codex-k3f7qz/ (brought to front).\n');
    expect(r.out).not.toContain(tok);
  });

  it('a launch that lost the race to another on this folder (already-open) is reported as already open', async () => {
    let r = await nb('', { env: { STUB_OUT: 'already-open http://127.0.0.1:4794' } });
    expect(r.code).toBe(0);
    expect(r.out).toBe('NB: already open at http://127.0.0.1:4794 (brought to front).\n');
    expect(opened()).toEqual([]); // the bin brought it to front, not us (no second tab)
    r = await nb('new', { env: { STUB_OUT: 'something else' } });
    expect(r.code).toBe(1);
    expect(r.out).toBe('NB: the launcher failed (exit code 0): something else\n');
  });

  it('a launch failure is relayed with the log tail, exit 1', async () => {
    const r = await nb('', { env: { STUB_FAIL: '1' } });
    expect(r.code).toBe(1);
    expect(r.out).toBe('NB: the server did not come up in 20s. Last log lines:\nboom: the last log line\n');
  });
});

describe('guards', () => {
  it('inside Nota Bene there is nothing to open', async () => {
    const r = await nb('', { env: { NOTA_BENE_SUPERVISED: '1' } });
    expect(r.code).toBe(0);
    expect(r.out).toBe('NB: already running inside Nota Bene — nothing to open.\n');
    expect(launches()).toEqual([]);
  });

  it('refuses $HOME and /', async () => {
    let r = await nb('', { cwd: home });
    expect(r.out).toBe(`NB: refusing to open the whole ${shown(home)} as a project — cd into a project first.\n`);
    const root = path.parse(project).root; // / or C:\
    r = await nb('new', { cwd: root });
    expect(r.out).toBe(`NB: refusing to open the whole ${shown(root)} as a project — cd into a project first.\n`);
    expect(r.code).toBe(0);
    expect(launches()).toEqual([]);
  });
});

describe('an existing window', () => {
  it('issue 642: an open window is not fronted here; the launcher is asked for the folder\'s agent', async () => {
    await fakeWindow(4792, project);
    register(4792, project, process.pid);
    const r = await nb('', { env: { STUB_OUT: 'already-open http://127.0.0.1:4792/a/claude-k3f7qz/' } });
    expect(r.out).toBe('NB: already open at http://127.0.0.1:4792/a/claude-k3f7qz/ (brought to front).\n');
    expect(launches()).toEqual([[project, '--detach', '--agent', 'claude']]);
    expect(opened()).toEqual([]);
  });

  it('the launcher\'s failure line is relayed without any #t= fragment', async () => {
    const tok = 'cd'.repeat(32);
    const r = await nb('', { env: { STUB_OUT: `opened http://127.0.0.1:4795/#t=${tok}`, STUB_EXIT: '3' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('the launcher failed (exit code 3)');
    expect(r.out).not.toContain(tok);
    expect(r.out).not.toContain('#t=');
  });

  it('stale registry entries are skipped (dead pid, port now serving another folder) and a window is launched', async () => {
    const dead = execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim();
    register(4791, project, Number(dead));
    await fakeWindow(4792, path.join(tmp, 'elsewhere'));
    register(4792, project, process.pid);
    const r = await nb('');
    expect(r.out).toMatch(/^NB: opened http:\/\/127\.0\.0\.1:4795 for /);
    expect(launches()).toEqual([[project, '--detach', '--agent', 'claude']]);
    expect(opened()).toEqual([]); // a wrong window is never brought to front
    expect(registry()).toEqual([]); // both pruned by --find
  });
});

describe.skipIf(WIN)('a refused token file', () => { // Windows has no POSIX mode bits to make the token loose with
  const seedLoose = () => { fs.writeFileSync(path.join(nbHome, 'token'), 'a'.repeat(64), { mode: 0o644 }); fs.chmodSync(path.join(nbHome, 'token'), 0o644); };

  it('--plan shows the secret error at once (one NB: line, exit 0, no NB-RUN), not a plan that fails later', async () => {
    seedLoose();
    fs.rmSync(path.join(tmp, 'argv.log'), { force: true });
    const r = await sh([stubApp, '--plan', '', SID]);
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^NB: .*token is readable by other users.*chmod 600/);
    expect(r.out).not.toContain('NB-RUN');
    expect(launches()).toEqual([]);
  });

  it('without --plan it exits 1 with the same line', async () => {
    seedLoose();
    const r = await nb('');
    expect([r.code, r.out]).toEqual([1, expect.stringMatching(/^NB: .*readable by other users/)]);
  });
});

describe('the environment', () => {
  // the skill runs `node open.mjs`, so the node that runs the script is the one checked (NB_TEST_NODE_VERSION, test only,
  // stands in for an old one); no node at all fails in the shell before the script runs
  it.each(['18.19.0', '23.5.1', '9.99.0'])('an old node (%s) is refused with a clear message', async (v) => {
    const r = await nb('', { env: { NB_TEST_NODE_VERSION: v } });
    expect(r.code).toBe(1);
    expect(r.out).toBe(`NB: Nota Bene needs Node >= 23.6; found ${v} at ${shown(process.execPath)}. Make it the default node for Claude `
      + "Code's shell (e.g. nvm alias default).\n");
    expect(launches()).toEqual([]);
  });

  // the launcher fronts the window; with no opener on PATH (open / xdg-open) its --front fails, and the skill says so
});

// Windows: needs the Windows launcher (its own track) and a stub for its browser opener, which is not looked up on PATH
describe.skipIf(WIN)('two /nb calls on one folder at the same moment', () => {
  it('end with exactly one window, and both point at it', async () => {
    const run = () => nb('', { script: realSkill, env: { NOTA_BENE_FAKE: FAKE } });
    const [a, b] = await Promise.all([run(), run()]);
    const url = (r: Result) => /^NB: (?:opened|already open at) (http:\/\/127\.0\.0\.1:\d+)/.exec(r.out)?.[1];
    expect(url(a), a.out).toBeTruthy();
    expect(url(b), b.out).toBe(url(a));
    const verbs = [a, b].map((r) => (r.out.startsWith('NB: opened') ? 'opened' : 'already'));
    expect(verbs.sort()).toEqual(['already', 'opened']);

    // one registry entry for the folder, and one /info root among the ports
    const entries = registry().map((n) => JSON.parse(fs.readFileSync(path.join(nbHome, 'windows', n), 'utf8')));
    expect(entries.filter((w) => w.root === project)).toHaveLength(1);
    const roots: string[] = [];
    for (let p = 4791; p <= 4795; p++) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/info`, { headers: { authorization: `Bearer ${tokenOf()}` }, signal: AbortSignal.timeout(500) });
        roots.push(((await r.json()) as { root: string }).root);
      } catch {
        // nothing there
      }
    }
    expect(roots.filter((r) => r === project)).toHaveLength(1);
    expect(url(a)).toBe(`http://127.0.0.1:${registry()[0]!.replace('.json', '')}`);
  }, 60_000);
});

// --plan: what the /nb skill runs. It launches nothing; the skill runs NB-RUN in the foreground.
describe('--plan', () => {
  const stubBin = () => path.join(tmp, 'app/bin/nota-bene.mjs');
  const plan = (args: string, o: RunOpts & { sid?: string } = {}) => {
    fs.rmSync(path.join(tmp, 'argv.log'), { force: true });
    return sh([o.script ?? stubApp, '--plan', args, o.sid ?? SID], o);
  };
  const lines = (r: Result) => Object.fromEntries(r.out.trimEnd().split('\n').map((l) => {
    const m = /^(NB-RUN|NB-NOTE): (.*)$/.exec(l);
    if (!m) throw new Error(`not a plan line: ${l}`);
    return [m[1], m[2]];
  }));

  it('new: one foreground command, this script without --plan (no background task); nothing launched', async () => {
    const r = await plan('new');
    expect(r.code).toBe(0);
    expect(r.out).toBe(`NB-RUN: node ${shown(stubApp)} new\n`);
    expect(launches()).toEqual([]);
    expect(opened()).toEqual([]);
    // run as the skill runs it, it opens the folder in the foreground and prints the NB: line
    const run = await bash(lines(r)['NB-RUN']!);
    expect(run.code, run.out).toBe(0);
    expect(launches()).toEqual([[project, '--detach', '--agent', 'claude', '--new']]);
    expect(run.out).toBe(`NB: opened http://127.0.0.1:4795 for ${shown(project)}. Log: ${shown(path.join(tmp, 'nota-bene-4795.log'))}\n`);
  });

  it('no argument: the default resume', async () => {
    const r = await plan('');
    expect(lines(r)['NB-RUN']).toBe(`node ${shown(stubApp)} ''`);
    expect(launches()).toEqual([]);
  });

  it('fork with a valid session id: fork SID', async () => {
    const r = await plan('форк');
    expect(r.code).toBe(0);
    expect(lines(r)['NB-RUN']).toBe(`node ${shown(stubApp)} fork ${SID}`);
  });

  it('guards and refusals are the same NB: lines', async () => {
    let r = await plan('', { env: { NOTA_BENE_SUPERVISED: '1' } });
    expect(r.out).toBe('NB: already running inside Nota Bene — nothing to open.\n');
    r = await plan('', { cwd: home });
    expect(r.out).toBe(`NB: refusing to open the whole ${shown(home)} as a project — cd into a project first.\n`);
    r = await plan('frobnicate');
    expect(r.out).toMatch(/^NB: unknown argument 'frobnicate'\. /);
    r = await plan('fork', { sid: 'x; rm -rf ~' });
    expect(r.code).toBe(0); // --plan runs in the skill's `!` preprocessing: a non-zero exit would fail it with no model turn
    expect(r.out).toBe("NB: no valid session id to fork ('x; rm -rf ~').\n");
    r = await plan('', { env: { NB_TEST_NODE_VERSION: '23.5.1' } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^NB: Nota Bene needs Node >= 23\.6; found 23\.5\.1/);
    expect(launches()).toEqual([]);
  });

  it.skipIf(!BASH)('a folder named `p r$oj Проект`: the run opens it from its own folder in bash and zsh', async () => {
    const odd = path.join(project, 'p r$oj Проект');
    fs.mkdirSync(odd);
    const r = await plan('new', { cwd: odd });
    expect(r.code).toBe(0);
    const shells = [BASH!, ...(fs.existsSync('/bin/zsh') ? ['/bin/zsh'] : [])];
    for (const shell of shells) {
      fs.rmSync(path.join(tmp, 'argv.log'), { force: true });
      const e = await bash(lines(r)['NB-RUN']!, { shell, cwd: odd });
      expect(e.code, e.out).toBe(0);
      expect(launches()).toEqual([[odd, '--detach', '--agent', 'claude', '--new']]);
    }
  });
});

// --- the plugin install: no checkout above the skill, the launcher comes from the npm package under ${CLAUDE_PLUGIN_DATA}
describe('the package lookup (plugin install)', () => {
  const esc = (p: string) => (/[^A-Za-z0-9_./:@%+=,-]/.test(p) ? `'${p.replace(/'/g, "'\\\\''")}'` : p); // q(): safe words as they are, the rest in '...'
  let data: string; // a data dir whose name has a space
  beforeEach(() => {
    data = path.join(path.dirname(project), 'plugin data');
  });
  const prefix = () => path.join(data, PKG_VER); // one install per plugin version
  const pkgBin = () => path.join(prefix(), 'node_modules/nota-bene-ide/bin/nota-bene.mjs');
  const npmCalls = (): string[][] => {
    try {
      return fs.readFileSync(path.join(tmp, 'npm.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  /** An installed package at `ver`, as a good first run leaves it. */
  function installed() {
    fs.mkdirSync(path.dirname(pkgBin()), { recursive: true });
    fs.copyFileSync(path.join(tmp, 'app/bin/nota-bene.mjs'), pkgBin());
    fs.writeFileSync(path.join(prefix(), '.nb-installed'), `${PKG_VER}\n`);
  }
  const plan = (args: string, o: RunOpts & { sid?: string; data?: string | null } = {}) => {
    fs.rmSync(path.join(tmp, 'argv.log'), { force: true });
    const d = o.data === undefined ? data : o.data;
    return sh([pkgOpen, ...(d === null ? [] : ['--data', d]), '--plan', args, o.sid ?? SID], o);
  };
  const lines = (r: Result) => Object.fromEntries(r.out.trimEnd().split('\n').map((l) => {
    const m = /^(NB-RUN|NB-NOTE): (.*)$/.exec(l);
    if (!m) throw new Error(`not a plan line: ${l}`);
    return [m[1], m[2]];
  }));

  it('a checkout above the skill wins over the data dir (nothing installed, npm untouched)', async () => {
    const r = await sh([stubApp, '--data', data, '--plan', 'new', SID]);
    expect(r.out).toBe(`NB-RUN: node ${shown(stubApp)} new\n`);
    expect(npmCalls()).toEqual([]);
    expect(fs.existsSync(data)).toBe(false);
  });

  it('no checkout and no data dir: one NB: line saying how to install the plugin', async () => {
    for (const d of [null, '', '${CLAUDE_PLUGIN_DATA}']) {
      const r = await plan('', { data: d });
      expect(r.code).toBe(0); // --plan never fails the skill's preprocessing
      expect(r.out).toMatch(/^NB: cannot find the Nota Bene launcher: no checkout above this skill and no plugin data dir\. Install the plugin /);
      expect(r.out.trimEnd().split('\n')).toHaveLength(1);
    }
  });

  it('first run: the plan only plans (no install, no data dir), the install is inside NB-RUN, with a patience note', async () => {
    const r = await plan('new');
    expect(r.code).toBe(0);
    const l = lines(r);
    expect(l['NB-RUN']).toBe(`node ${esc(shown(pkgOpen))} --data ${esc(shown(data))} new`);
    expect(l['NB-NOTE']).toBe(`first run: installing nota-bene-ide@${PKG_VER} (about 330 MB); this can take a few minutes.`);
    expect(npmCalls()).toEqual([]);
    expect(fs.existsSync(path.join(data, PKG_VER, 'node_modules'))).toBe(false);
  });

  it('the run installs the pinned version once with npm --prefix, then opens the folder with the plan\'s arguments', async () => {
    const r = await sh([pkgOpen, '--data', data, 'fork', SID]);
    expect(r.code).toBe(0);
    expect(npmCalls()).toEqual([['install', '--prefix', prefix(), `nota-bene-ide@${PKG_VER}`, '--no-audit', '--no-fund']]);
    expect(fs.readFileSync(path.join(prefix(), '.nb-installed'), 'utf8').trim()).toBe(PKG_VER);
    expect(launches()).toEqual([[project, '--detach', '--agent', 'claude', '--resume', SID, '--fork']]);
    expect(r.out).toContain(`first run, installing nota-bene-ide@${PKG_VER}`);
    expect(r.out).toMatch(/NB: opened http:\/\/127\.0\.0\.1:4795 for .*\(forked from this conversation\)/);
    // the second time nothing is installed again
    fs.rmSync(path.join(tmp, 'npm.log'));
    await sh([pkgOpen, '--data', data, 'new', SID]);
    expect(npmCalls()).toEqual([]);
  });

  it('installed: NB-RUN is this script with the data dir (matches allowed-tools), no note, no npm', async () => {
    installed();
    const r = await plan('');
    const l = lines(r);
    expect(l['NB-RUN']).toBe(`node ${esc(shown(pkgOpen))} --data ${esc(shown(data))} ''`);
    expect(l['NB-NOTE']).toBeUndefined();
    expect(npmCalls()).toEqual([]);
  });

  it('fork and its Russian aliases behave as in a checkout; a bad session id is refused', async () => {
    installed();
    for (const a of ['fork', 'форк', 'продолжить']) {
      expect(lines(await plan(a))['NB-RUN']).toBe(`node ${esc(shown(pkgOpen))} --data ${esc(shown(data))} fork ${SID}`);
    }
    expect(lines(await plan('заново'))['NB-RUN']).toBe(`node ${esc(shown(pkgOpen))} --data ${esc(shown(data))} new`);
    const r = await plan('fork', { sid: 'nope' });
    expect(r.out).toBe("NB: no valid session id to fork ('nope').\n");
    expect(r.code).toBe(0);
  });

  it('the version is pinned: a plugin update installs beside the old version and leaves it untouched', async () => {
    const old = path.join(data, '9.9.8/node_modules/nota-bene-ide/bin');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'nota-bene.mjs'), '// old');
    fs.writeFileSync(path.join(data, '9.9.8/.nb-installed'), '9.9.8\n');
    expect(lines(await plan('new'))['NB-NOTE']).toBeDefined();
    await sh([pkgOpen, '--data', data, 'new', SID]);
    expect(npmCalls()).toEqual([['install', '--prefix', prefix(), `nota-bene-ide@${PKG_VER}`, '--no-audit', '--no-fund']]);
    expect(fs.readFileSync(path.join(prefix(), '.nb-installed'), 'utf8').trim()).toBe(PKG_VER);
    expect(fs.readFileSync(path.join(old, 'nota-bene.mjs'), 'utf8')).toBe('// old');
    expect(fs.existsSync(path.join(data, '9.9.8/.nb-installed'))).toBe(true);
  });

  it('a package whose marker is there but whose launcher is gone is installed again', async () => {
    installed();
    fs.rmSync(pkgBin());
    expect(lines(await plan('new'))['NB-NOTE']).toBeDefined();
  });

  it('the plugin version equals the package version, and the plugin dir has no package.json or lockfile', () => {
    const root = path.join(SKILL, '../../..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const plugin = JSON.parse(fs.readFileSync(path.join(root, 'plugin/.claude-plugin/plugin.json'), 'utf8'));
    expect(plugin.version).toBe(pkg.version);
    const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
    expect(market.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: './plugin' })]);
    expect(market.plugins[0].version).toBeUndefined(); // one place for the version
    const names: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : names.push(e.name)));
    walk(path.join(root, 'plugin'));
    expect(names.filter((n) => /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(n))).toEqual([]);
  });

  it('npm missing on the first run: one NB: line with the fix, no NB-RUN', async () => {
    const r = await plan('', { env: { PATH: binDir('nonpm', []) } }); // open.mjs runs the launcher with its own node
    expect(r.code).toBe(0);
    expect(r.out).toBe(`NB: npm not found on PATH; the first run installs nota-bene-ide@${PKG_VER} with it. Install Node.js with npm (nodejs.org), `
      + 'or run `npm install -g nota-bene-ide` and open it with `nota-bene`.\n');
  });

  it('an install failure: the NB: line with the fix and the npm tail, nothing marked installed, no launch', async () => {
    const r = await sh([pkgOpen, '--data', data, 'new', SID], { env: { STUB_NPM_FAIL: '1' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`NB: installing nota-bene-ide@${PKG_VER} failed (npm exit 1).`);
    expect(r.out).toContain(`npm install --prefix "${shown(prefix())}" nota-bene-ide@${PKG_VER}`);
    expect(r.out).toContain('npm ERR! boom: the last npm line');
    expect(fs.existsSync(path.join(prefix(), '.nb-installed'))).toBe(false);
    expect(launches()).toEqual([]);
  });

  const lockAt = (o: { pid?: string; ts?: number }) => {
    const lock = path.join(prefix(), '.nb-install.lock');
    fs.mkdirSync(lock, { recursive: true });
    if (o.pid !== undefined) fs.writeFileSync(path.join(lock, 'pid'), o.pid);
    if (o.ts !== undefined) fs.writeFileSync(path.join(lock, 'ts'), String(o.ts));
  };
  const now = () => Math.floor(Date.now() / 1000);

  it.each([
    ['an empty pid file, taken long ago', { ts: 1 }, {}],
    ['a dead pid', { pid: '999999', ts: now() - 10 }, {}],
    ['a live but recycled pid, taken longer ago than the stale limit', { pid: String(process.pid), ts: now() - 100 }, { NB_LOCK_STALE_SECS: '5' }],
  ])('a stale lock (%s) is reclaimed and the install goes ahead', async (_n, lock, extra) => {
    lockAt(lock);
    const r = await sh([pkgOpen, '--data', data, 'new', SID], { env: { NB_INSTALL_WAIT_SECS: '20', ...extra } });
    expect(r.code).toBe(0);
    expect(npmCalls()).toHaveLength(1);
    expect(fs.existsSync(path.join(prefix(), '.nb-install.lock'))).toBe(false);
  });

  it('a fresh lock of a live holder is respected (no second install) until it gives up', async () => {
    lockAt({ pid: String(process.pid), ts: now() });
    const r = await sh([pkgOpen, '--data', data, 'new', SID], { env: { NB_INSTALL_WAIT_SECS: '2' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('another install of');
    expect(npmCalls()).toEqual([]);
  });

  it('a waiter that judged the lock stale and is then overtaken never disturbs the fresh lock that took its place (no second install)', async () => {
    // Deterministic replay of the CI double install. Waiter B sees the stale lock and is held up (NB_TEST_RECLAIM_GATE, test
    // only) just before it acts on that judgment. Waiter A reclaims the lock, takes it and starts installing. B is released: it
    // must re-judge, find A's fresh lock and leave it alone (it says so in <gate>.released). (The earlier "move aside, judge,
    // move back" takeover hid A's lock for a moment; a third waiter C, started inside that gap, took the free name: two
    // installs.) C is started while B is still working.
    lockAt({ ts: 1 });
    const gate = path.join(tmp, 'gate');
    for (const f of ['stalled', 'go', 'released']) fs.rmSync(`${gate}.${f}`, { force: true });
    const env = { NB_TEST_RECLAIM_GATE: gate, STUB_NPM_SLEEP: '4', NB_INSTALL_WAIT_SECS: '30' };
    const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); expect(f()).toBe(true); };
    const b = sh([pkgOpen, '--data', data, 'new', SID], { env });
    await until(() => fs.existsSync(`${gate}.stalled`));
    const a = sh([pkgOpen, '--data', data, 'new', SID], { env });
    await until(() => npmCalls().length === 1); // A took the lock and is installing
    fs.writeFileSync(`${gate}.go`, '');
    // B acts on its stale judgment: it re-judges under the mutex, finds A's lock fresh and lets go of the mutex
    await until(() => fs.existsSync(`${gate}.released`));
    const c = sh([pkgOpen, '--data', data, 'new', SID], { env });
    const rs = await Promise.all([a, b, c]);
    expect(rs.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(npmCalls()).toHaveLength(1);
  }, 60_000);

  it.skipIf(WIN)('a stale lock that cannot be removed (unwritable install dir) ends at the time limit instead of looping for good', async () => { // Windows: chmod cannot make a folder unwritable
    lockAt({ ts: 1 });
    fs.chmodSync(prefix(), 0o555);
    try {
      const t0 = Date.now();
      const r = await sh([pkgOpen, '--data', data, 'new', SID], { env: { NB_INSTALL_WAIT_SECS: '2' } });
      expect(r.code).toBe(1);
      expect(r.out).toContain('another install of');
      expect(npmCalls()).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(10_000);
    } finally {
      fs.chmodSync(prefix(), 0o755);
    }
  });

  it('a reclaim mutex left behind by a killed waiter is cleared after a minute and the install goes ahead', async () => {
    lockAt({ ts: 1 });
    const mutex = path.join(prefix(), '.nb-install.lock.reclaim');
    fs.mkdirSync(mutex);
    const old = new Date(Date.now() - 180_000);
    fs.utimesSync(mutex, old, old);
    const r = await sh([pkgOpen, '--data', data, 'new', SID], { env: { NB_INSTALL_WAIT_SECS: '20' } });
    expect(r.code).toBe(0);
    expect(npmCalls()).toHaveLength(1);
  });

  it('npm missing on the run: the same NB: line, exit 1, nothing launched', async () => {
    fs.rmSync(path.join(tmp, 'argv.log'), { force: true });
    const r = await sh([pkgOpen, '--data', data, 'new', SID], { env: { PATH: binDir('nonpm-run', []) } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('NB: npm not found on PATH');
    expect(launches()).toEqual([]);
  });

  it('a launcher file without the installed marker (a half-written install) is not enough: the plan installs again', async () => {
    fs.mkdirSync(path.dirname(pkgBin()), { recursive: true });
    fs.writeFileSync(pkgBin(), '// half');
    expect(lines(await plan('new'))['NB-NOTE']).toBeDefined();
  });

  it('SKILL.md passes the data dir single-quoted on every line: a live ${...} makes Claude Code refuse the line before any turn', () => {
    const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
    const uses = md.split('\n').filter((l) => l.includes('CLAUDE_PLUGIN_DATA'));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) {
      expect(l.replace(/'\$\{CLAUDE_PLUGIN_DATA\}'/g, '')).not.toContain('CLAUDE_PLUGIN_DATA');
    }
  });

  it('several waiters racing for a stale lock install once (a lock moved aside is never taken twice)', async () => {
    for (let trial = 0; trial < 3; trial++) {
      fs.rmSync(path.join(tmp, 'npm.log'), { force: true });
      fs.rmSync(data, { recursive: true, force: true });
      lockAt({ ts: 1 });
      const runs = Array.from({ length: 6 }, () => sh([pkgOpen, '--data', data, 'new', SID], { env: { STUB_NPM_SLEEP: '1', NB_INSTALL_WAIT_SECS: '30' } }));
      const rs = await Promise.all(runs);
      expect(rs.map((r) => r.code)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(npmCalls().length, `trial ${trial}`).toBe(1);
    }
  }, 60_000);

  it.skipIf(WIN)('--plan on a data dir it cannot write: one NB: line naming the sandbox, exit 0, no NB-RUN, no retry advice', async () => { // Windows: chmod cannot make a folder unwritable
    fs.mkdirSync(data);
    fs.chmodSync(data, 0o555);
    try {
      const r = await plan('new');
      expect(r.code).toBe(0);
      expect(r.out.trimEnd().split('\n')).toHaveLength(1);
      expect(r.out).toMatch(/^NB: cannot write to the plugin data dir .*9\.9\.9.*sandbox/);
      expect(r.out).not.toMatch(/NB-RUN|run \/nb again/i);
    } finally {
      fs.chmodSync(data, 0o755);
    }
  });

  it('SKILL.md allowed-tools pins the patterns that survive a quoted (spaced or non-ASCII) path', () => {
    const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
    // issue 457: first the exact rule for the skill's own `!` command, as it is written below (Claude Code substitutes
    // ${CLAUDE_SKILL_DIR} in both): it pre-approves that exact command instead of only a wildcard (auto mode drops broad
    // rules that grant arbitrary code execution)
    expect(/^allowed-tools: (.*)$/m.exec(md)?.[1]).toBe('Bash(node "${CLAUDE_SKILL_DIR}/open.mjs" *), Bash(node */nb/open.mjs* *), Bash(node */bin/nota-bene.mjs* *)');
    expect(md).toContain('!`node "${CLAUDE_SKILL_DIR}/open.mjs" --data ');
  });

  it('a second run during an install waits for it instead of installing twice', async () => {
    fs.rmSync(path.join(tmp, 'argv.log'), { force: true });
    const first = sh([pkgOpen, '--data', data, 'new', SID], { env: { STUB_NPM_SLEEP: '2' } });
    await new Promise((r) => setTimeout(r, 700));
    const second = await sh([pkgOpen, '--data', data, 'new', SID]);
    await first;
    expect(second.code).toBe(0);
    expect(npmCalls()).toHaveLength(1);
    expect(launches()).toHaveLength(2);
  });

  it.each([['22.0.0', true], ['22.99.1', true], ['21.9.0', false]])('node floor of the package path is 22 (%s)', async (v, ok) => {
    const r = await plan('new', { env: { NB_TEST_NODE_VERSION: v } });
    if (ok) expect(r.code).toBe(0);
    else {
      expect(r.code).toBe(0);
      expect(r.out).toBe(`NB: Nota Bene needs Node >= 22; found ${v} at ${shown(process.execPath)}. Make it the default node for Claude Code's shell (e.g. nvm alias default).\n`);
    }
  });

  it('a checkout still needs 23.6 even when the package floor is lower', async () => {
    const r = await nb('', { env: { NB_TEST_NODE_VERSION: '22.5.0' } });
    expect(r.out).toContain('needs Node >= 23.6; found 22.5.0');
  });

  /** The words bash makes of `line` (eval, as the Bash tool runs a command line). */
  const readBack = (line: string): string[] => execFileSync(BASH!, ['-c', 'eval "set -- $RUN"; printf "%s\\n" "$@"'],
    { encoding: 'utf8', env: { ...process.env, RUN: line }, windowsHide: true }).replace(/\n$/, '').split('\n');

  it.skipIf(!BASH)('a Cyrillic data dir with an apostrophe: single-quoted, the quote closed and reopened, and read back exactly', async () => {
    const odd = path.join(path.dirname(project), "Проект д'Артаньяна");
    const run = lines(await plan('new', { data: odd }))['NB-RUN']!;
    expect(run).toContain("д'\\''Артаньяна");
    expect(run).not.toContain("$'");
    expect(readBack(run).slice(-3)).toEqual(['--data', shown(odd), 'new']);
  });

  it.skipIf(!BASH || WIN)("a control character in a folder name keeps bash's $'...' form (the only form that can carry it)", async () => { // Windows: no control characters in file names
    const odd = path.join(path.dirname(project), 'tab\there');
    const run = lines(await plan('new', { data: odd }))['NB-RUN']!;
    expect(run).toContain("$'");
    expect(readBack(run)).toContain(odd);
  });

  it('an ASCII data dir with a space: single-quoted, never a backslash-escaped space (Claude Code refuses those)', async () => {
    installed();
    const r = await plan('');
    expect(r.out).not.toMatch(/\\ /);
    expect(lines(r)['NB-RUN']).toContain(`'${shown(data)}'`);
  });

  it.skipIf(!BASH)('q(): safe words as they are, the rest single-quoted (raw UTF-8, quote closed and reopened), control characters as $\'...\'', () => {
    expect(q('C:/Users/x/a-b_c.d@e%f+g=h,i')).toBe('C:/Users/x/a-b_c.d@e%f+g=h,i');
    expect(q('')).toBe("''");
    expect(q('a b')).toBe("'a b'");
    expect(q('$x`y`(z)!*?~#&;|<>\\')).toBe("'$x`y`(z)!*?~#&;|<>\\'");
    expect(q("д'А")).toBe("'д'\\''А'");
    expect(q('a\tb\nü')).toBe("$'a\\tb\\n\\303\\274'");
    const words = ['plain', '', 'a b', "it's", 'Проект д\'А $HOME', 'a\tb\nc\\d\'e', '\x01\x7f', 'C:\\Users\\x y'];
    expect(readBack(words.map(q).join(' '))).toEqual(words.flatMap((w) => w.split('\n')));
  });

  it.skipIf(!BASH)('the plan\'s NB-RUN reads back exactly in bash with a data dir and a folder whose names have spaces and quotes', async () => {
    const odd = path.join(path.dirname(project), "my p r$oj 'x'");
    fs.mkdirSync(odd);
    const r = await plan('new', { cwd: odd, data: path.join(path.dirname(project), "da ta $x") });
    const run = lines(r)['NB-RUN']!;
    expect(readBack(run)).toEqual(['node', shown(pkgOpen), '--data', shown(path.join(path.dirname(project), 'da ta $x')), 'new']);
  });
});
