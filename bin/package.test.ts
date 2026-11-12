import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIN, buildPackage, NODE_RANGE, PACKAGE_NAME } from '../scripts/build-package.mjs';
import { HostClient } from '../server/src/dictation/hostClient.ts';
import { encodeFrame, FrameDecoder, HOST_PINS, HOST_PROTO, hostSocketPath } from '../server/src/dictation/hostWire.ts';
import { WHISPER_PACKAGE } from '../server/src/dictation/whisper.ts';

// The published package: built by scripts/build-package.mjs (without the web build: a stub index.html), made read-only like
// an install under a root-owned global prefix, then run for real. Ports: the launcher range 4791-4795 of this project.
const FAKE = fileURLToPath(new URL('../server/test/fixtures/hello.json', import.meta.url));
let tmp: string;
let pkg: string;
let home: string;
let project: string;
const run = (args: string[]) => spawnSync(process.execPath, [path.join(pkg, 'bin/nota-bene.mjs'), ...args], {
  encoding: 'utf8', env: { ...process.env, NOTA_BENE_HOME: home, NOTA_BENE_PORT_RANGE: '4791-4795', CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') },
});

function tree(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const snapshot = (dir: string) => tree(dir).map((f) => `${f} ${fs.statSync(f).mtimeMs}`).sort();

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-pkg-')));
  pkg = path.join(tmp, 'node_modules', PACKAGE_NAME);
  home = path.join(tmp, 'home');
  project = path.join(tmp, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  await buildPackage({ out: pkg, skipWeb: true });
  fs.writeFileSync(path.join(pkg, 'web/dist/index.html'), '<!doctype html><title>Nota Bene</title>');
  fs.chmodSync(path.join(pkg, 'package.json'), 0o444);
  for (const f of tree(pkg)) fs.chmodSync(f, 0o444);
  fs.chmodSync(path.join(pkg, 'bin/nota-bene.mjs'), 0o555);
  for (const d of [...new Set(tree(pkg).map((f) => path.dirname(f)))]) fs.chmodSync(d, 0o555);
  fs.chmodSync(pkg, 0o555);
});

afterAll(() => {
  const open = (d: string) => { fs.chmodSync(d, 0o755); for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) open(path.join(d, e.name)); };
  if (pkg) open(pkg);
  fs.rmSync(tmp, { recursive: true, force: true });
});

it('the generated package.json: unscoped name, one bin, exact runtime deps only, no shared, no publishConfig, an engines floor', () => {
  const j = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')) as Record<string, any>;
  expect(j.name).toBe(PACKAGE_NAME);
  expect(j.name).not.toMatch(/^@/);
  expect(j.bin).toEqual({ [BIN]: 'bin/nota-bene.mjs' });
  expect(j.version).toBe((JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version);
  expect(Object.keys(j.dependencies).sort()).toEqual(['@anthropic-ai/claude-agent-sdk', 'uqr', 'ws']);
  for (const v of Object.values(j.dependencies)) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  expect(j.private).toBeUndefined();
  expect(j.publishConfig).toBeUndefined();
  expect(j.devDependencies).toBeUndefined();
  expect(j.engines).toEqual({ node: NODE_RANGE });
  expect(j.files).toEqual(expect.arrayContaining(['server/src/main.js', 'server/src/host.js', 'server/src/dictation'])); // the Whisper host ships
  const root = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { private?: boolean; engines: { node: string } };
  expect(root.private).toBe(true); // the repo root stays private, its engines untouched
  expect(root.engines.node).toBe('>=23.6');
});

it('ships compiled JS with the shared protocol inlined, the blend assets and no TypeScript', () => {
  const files = tree(pkg).map((f) => path.relative(pkg, f));
  expect(files).toEqual(expect.arrayContaining(['bin/nota-bene.mjs', 'server/src/main.js', 'server/src/host.js', 'server/src/blend/export.py', 'server/src/blend/sandbox.sb', 'server/src/dictation/pipelineWorker.mjs', 'server/src/dictation/npm-shrinkwrap.json', 'web/dist/index.html', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'README.md', 'package.json']));
  expect(files.filter((f) => /\.tsx?$/.test(f))).toEqual([]);
  for (const f of ['bin/nota-bene.mjs', 'server/src/main.js', 'server/src/host.js']) expect(fs.readFileSync(path.join(pkg, f), 'utf8')).not.toContain('@nota-bene/shared');
  expect(fs.readFileSync(path.join(pkg, 'bin/nota-bene.mjs'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
});

it('nota-bene remote runs from the package, its runtime deps installed beside it', () => {
  // as npm lays out an install: the dependencies next to the package in node_modules
  for (const dep of ['ws', 'uqr']) fs.symlinkSync(fileURLToPath(new URL(`../node_modules/${dep}`, import.meta.url)), path.join(tmp, 'node_modules', dep));
  const r = run(['remote', '--help']);
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/nota-bene remote pair/);
  const j = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  expect(j.dependencies.uqr).toBe('0.1.3');
  expect(fs.existsSync(path.join(pkg, 'server/src/remote/cli.js'))).toBe(true);
});

it('a read-only install runs: --find / --last answer, a window serves /info and the page, codeChanged stays false, nothing is written to it', async () => {
  // the dependencies live in the repo; make them reachable from the package directory the way npm would
  fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
  for (const d of ['ws', '@anthropic-ai']) {
    const link = path.join(tmp, 'node_modules', d);
    if (!fs.existsSync(link)) fs.symlinkSync(fileURLToPath(new URL(`../node_modules/${d}`, import.meta.url)), link);
  }
  expect(fs.readFileSync(path.join(pkg, 'codex/skills/nb/SKILL.md'), 'utf8')).toContain('name: nb');
  expect(fs.existsSync(path.join(pkg, 'codex/skills/nb/open.mjs'))).toBe(true);
  expect(fs.readFileSync(path.join(pkg, 'omp/skills/nb/SKILL.md'), 'utf8')).toContain('name: nb');
  expect(fs.existsSync(path.join(pkg, 'omp/skills/nb/open.mjs'))).toBe(true);
  const before = snapshot(pkg);

  expect(run(['--find', project]).status).toBe(1); // no window yet
  const lastBefore = run(['--last', project]);
  expect(lastBefore.status).toBe(1);
  const id = '0123abcd-0000-4000-8000-000000000000';
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ [project]: id }));
  fs.mkdirSync(path.join(tmp, 'claude/projects/x'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'claude/projects/x', `${id}.jsonl`), '');
  const lastAfter = run(['--last', project]);
  expect([lastAfter.status, lastAfter.stdout.trim()]).toEqual([0, id]);

  const child = spawn(process.execPath, [path.join(pkg, 'bin/nota-bene.mjs'), project, '--no-open', '--fake', FAKE], {
    env: { ...process.env, NOTA_BENE_HOME: home, NOTA_BENE_PORT_RANGE: '4791-4795', CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    const url = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no start line:\n${out}`)), 15_000);
      const iv = setInterval(() => {
        const m = /Nota Bene: (http:\/\/\S+)/.exec(out);
        if (m) { clearTimeout(t); clearInterval(iv); res(m[1]!); }
      }, 100);
    });
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    const auth = { headers: { authorization: `Bearer ${token}` } };
    expect((await fetch(`${url}/info`)).status).toBe(401); // the packaged server wants the token too
    const info = await (await fetch(`${url}/info`, auth)).json() as { codeChanged: boolean; blender: boolean };
    expect(info.codeChanged).toBe(false);
    expect(info.blender).toBe(false);
    expect(await (await fetch(`${url}/`)).text()).toContain('Nota Bene');
    const about = await (await fetch(`${url}/system/about`, auth)).json() as { version: string };
    expect(about.version).toBe(JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version);
    let found = run(['--find', project]);
    for (let n = 0; n < 50 && found.status !== 0; n++) { // the registry entry is written just after the listen
      await new Promise((r) => setTimeout(r, 100));
      found = run(['--find', project]);
    }
    expect([found.status, found.stdout.trim(), found.stderr]).toEqual([0, new URL(url).port, '']);
    expect(out).not.toMatch(/building|npm run build/i); // the launcher never tries to build
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
  expect(snapshot(pkg)).toEqual(before); // nothing created or touched in the install
});

// The Whisper host, started the way a window starts it: `node host.js` beside the server bundle. A unix socket path must fit
// sun_path (~104 bytes), which the package's own folder under os.tmpdir() does not on macOS: the host's home is a short /tmp one.
describe.skipIf(process.platform === 'win32')('the Whisper host in the package', { timeout: 30_000 }, () => {
  let base: string;
  const children: ChildProcess[] = [];
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync('/tmp/nbw-'));
    vi.stubEnv('NOTA_BENE_HOME', base);
    vi.stubEnv('NOTA_BENE_TEST_WHISPER_IDLE_MS', '2000');
  });
  afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const hostJs = () => path.join(pkg, 'server/src/host.js');
  const until = async (cond: () => boolean, ms = 10_000) => {
    const stop = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > stop) throw new Error('timed out waiting for a condition');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const hello = (socketPath: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const s = net.connect(socketPath);
    const decoder = new FrameDecoder();
    s.setTimeout(5000, () => { s.destroy(); reject(new Error('the host did not answer hello')); });
    s.once('error', reject);
    s.once('connect', () => s.write(encodeFrame({ type: 'hello', proto: HOST_PROTO })));
    s.on('data', (d: Buffer) => { for (const f of decoder.push(d)) { s.destroy(); resolve(f.header); } });
  });

  it('starts, publishes its socket (private), answers hello with its own pid, loads no model, and exits 0 when idle', async () => {
    const child = spawn(process.execPath, [hostJs()], { cwd: base, env: { ...process.env, NOTA_BENE_HOME: base, NOTA_BENE_TEST_WHISPER_IDLE_MS: '2000' }, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    let log = '';
    child.stderr!.on('data', (d) => (log += d));
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once('exit', (code, signal) => resolve([code, signal])));
    const socketPath = hostSocketPath();
    await until(() => fs.existsSync(socketPath));
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(await hello(socketPath)).toMatchObject({ type: 'hello', proto: HOST_PROTO, pins: HOST_PINS, pid: child.pid, loaded: false, queued: 0 });
    expect(await exited).toEqual([0, null]); // idle: the model was never loaded, and the process ends by itself
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(log).toContain('listening on');
    expect(log).toContain('stopping (idle)');
  });

  it('a window starts it from the package and a job reaches the model worker: host.js finds pipelineWorker.mjs beside the bundle', async () => {
    // a package in place of transformers.js: the worker thread loads it from <home>/whisper and answers `heard <samples>`
    const dir = path.join(base, 'whisper', 'node_modules', ...WHISPER_PACKAGE.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: WHISPER_PACKAGE, version: '0.0.0', type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), "export const env = {};\nexport const pipeline = async () => async (audio) => ({ text: `heard ${audio.length}` });\n");
    const told: unknown[] = [];
    const c = new HostClient({ entry: hostJs(), report: (_where, e) => { told.push(e); } });
    try {
      expect(await c.transcribe(new Float32Array(160).fill(0.25), 'en', false)).toEqual({ text: 'heard 160', lang: 'en' });
      expect(c.spawned).toBe(1);
      expect(await c.status()).toMatchObject({ loaded: true, running: false });
      expect(told).toEqual([]);
    } finally {
      c.close();
      for (const child of c.children) child.kill('SIGKILL');
    }
  });
});
