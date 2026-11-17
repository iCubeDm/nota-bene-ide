import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';
import { fileRoutes } from './fileRoutes.ts';
import { clearStatusCache, gitStatus } from './git.ts';

let dir: string;
let repo: string;
let plain: string;
let current: string;
let server: http.Server;
let port: number;
const hub = new EventHub();
const allowedHosts: string[] = [];
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString();

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-gst-')));
  repo = path.join(dir, 'repo');
  plain = path.join(dir, 'plain');
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.md'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  current = repo;
  server = http.createServer(
    httpHandler({ hub, webDist: dir, allowedHosts, allowedOrigins: [], info: () => ({}), extra: fileRoutes({ root: () => current, hub, complete: async () => [] }) }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = () => new Promise<{ status: number; body: string }>((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/git-status' }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode!, body }));
  }).on('error', reject);
});

describe('gitStatus', () => {
  it('clean, dirty (tracked change or a new file; ignored files do not count), detached, not a repo', async () => {
    clearStatusCache();
    expect(await gitStatus(repo)).toEqual({ branch: 'main', detached: false, dirty: false });
    fs.writeFileSync(path.join(repo, '.git/info/exclude'), 'ignored.log\n');
    fs.writeFileSync(path.join(repo, 'ignored.log'), 'x');
    clearStatusCache();
    expect((await gitStatus(repo))?.dirty).toBe(false);
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked');
    clearStatusCache();
    expect((await gitStatus(repo))?.dirty).toBe(true);
    fs.rmSync(path.join(repo, 'new.txt'));
    fs.writeFileSync(path.join(repo, 'a.md'), 'changed');
    clearStatusCache();
    expect(await gitStatus(repo)).toEqual({ branch: 'main', detached: false, dirty: true });
    git(repo, 'checkout', '-q', '--', 'a.md');
    git(repo, 'checkout', '-q', '--detach');
    clearStatusCache();
    expect(await gitStatus(repo)).toEqual({ branch: null, detached: true, dirty: false });
    git(repo, 'checkout', '-q', 'main');
    clearStatusCache();
    expect(await gitStatus(plain)).toBeNull();
  });
  it('a repo without commits still names its branch', async () => {
    const fresh = path.join(dir, 'fresh');
    fs.mkdirSync(fresh);
    git(fresh, 'init', '-q', '-b', 'trunk');
    expect(await gitStatus(fresh)).toEqual({ branch: 'trunk', detached: false, dirty: false });
  });
  it('is cached per root for a few seconds', async () => {
    clearStatusCache();
    expect((await gitStatus(repo))?.dirty).toBe(false);
    fs.writeFileSync(path.join(repo, 'a.md'), 'again');
    expect((await gitStatus(repo))?.dirty).toBe(false);
    clearStatusCache();
    expect((await gitStatus(repo))?.dirty).toBe(true);
    git(repo, 'checkout', '-q', '--', 'a.md');
  });
  it('GET /git-status answers the current root: object in a repo, null outside, never 500 (a git timeout is a 503)', async () => {
    clearStatusCache();
    current = repo;
    const a = await get();
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body)).toEqual({ branch: 'main', detached: false, dirty: false });
    current = plain;
    expect(JSON.parse((await get()).body)).toBeNull();
    current = path.join(dir, 'does-not-exist');
    const c = await get();
    expect(c.status).toBe(200);
    expect(JSON.parse(c.body)).toBeNull();
    current = repo;
  });
});

describe('gitStatus with a git that misbehaves (issue 471)', () => {
  const fake = (body: string) => {
    const bin = fs.mkdtempSync(path.join(dir, 'bin-'));
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho x >> "${bin}/calls"\n${body}\n`, { mode: 0o755 });
    const was = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${was}`;
    clearStatusCache();
    return { calls: () => fs.readFileSync(path.join(bin, 'calls'), 'utf8').split('\n').filter(Boolean).length, done: () => { process.env.PATH = was; } };
  };
  it('outside a repo git runs once', async () => {
    const g = fake('echo "fatal: not a git repository" >&2; exit 128');
    try {
      expect(await gitStatus(plain)).toBeNull();
      expect(g.calls()).toBe(1);
    } finally { g.done(); }
  });
  it('an answer too large is not "not a repo": it rejects, so the header keeps what it showed', async () => {
    const g = fake('head -c 17000000 /dev/zero');
    try {
      await expect(gitStatus(repo)).rejects.toBeTruthy();
    } finally { g.done(); }
  });
});
