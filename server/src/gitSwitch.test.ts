import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';
import { fileRoutes } from './fileRoutes.ts';
import { clearSourceCache, clearStatusCache, gitStatus, listSources } from './git.ts';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString();
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const commit = (cwd: string, m: string) => { git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', m); };
const read = (p: string) => fs.readFileSync(p, 'utf8');

// main: a.md, b.md; feature/x changes a.md and adds x.md; `held` is checked out in the worktree wt/ inside the project
let dir: string, root: string, plain: string, held: string, current: string;
let server: http.Server, port: number;
const origin = 'http://nb.test';
const allowedHosts: string[] = [];
let busy: string[] = [];
let selfBusy = false;
const audit: { ev: string; f: Record<string, unknown> }[] = [];

beforeAll(async () => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-switch-')));
  root = path.join(dir, 'proj');
  plain = path.join(dir, 'plain');
  held = path.join(root, 'wt');
  fs.mkdirSync(root);
  fs.mkdirSync(plain);
  git(root, 'init', '-q', '-b', 'main');
  write(path.join(root, '.gitignore'), 'wt/\n');
  write(path.join(root, 'a.md'), 'a\n');
  write(path.join(root, 'b.md'), 'b\n');
  commit(root, 'init');
  git(root, 'switch', '-q', '-c', 'feature/x');
  write(path.join(root, 'a.md'), 'a on x\n');
  write(path.join(root, 'x.md'), 'x\n');
  commit(root, 'x');
  git(root, 'switch', '-q', 'main');
  git(root, 'branch', 'held');
  git(root, 'worktree', 'add', '-q', held, 'held');
  current = root;
  server = http.createServer(httpHandler({
    hub: new EventHub(), webDist: dir, allowedHosts, allowedOrigins: [origin], info: () => ({}),
    extra: fileRoutes({
      root: () => current, hub: new EventHub(), complete: async () => [],
      working: async () => busy, selfBusy: () => selfBusy, audit: (ev, f) => audit.push({ ev, f }),
    }),
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  git(root, 'checkout', '-q', '-f', 'main');
  git(root, 'clean', '-qfd');
  clearSourceCache();
  clearStatusCache();
  current = root;
  busy = [];
  selfBusy = false;
  audit.length = 0;
});

const branchNow = () => git(root, 'branch', '--show-current').trim();
function post(body: string, method = 'POST') {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/git-switch', method, headers: { origin, 'content-type': 'application/json' } }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        let v: Record<string, unknown> = {};
        try { v = JSON.parse(s) as Record<string, unknown>; } catch { v = { text: s }; }
        resolve({ status: res.statusCode ?? 0, body: v });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const switchTo = (branch: unknown) => post(JSON.stringify({ branch }));

describe('POST /git-switch', () => {
  it('switches this folder to a local branch and answers its name', async () => {
    const r = await switchTo('feature/x');
    expect(r).toEqual({ status: 200, body: { branch: 'feature/x' } });
    expect(branchNow()).toBe('feature/x');
    expect(read(path.join(root, 'a.md'))).toBe('a on x\n');
  });

  it('refuses a branch that does not exist, and leaves the folder as it was', async () => {
    const r = await switchTo('nope');
    expect(r).toMatchObject({ status: 404, body: { error: 'unknown-branch' } });
    expect(branchNow()).toBe('main');
  });

  it('a name git would take but the branch list does not have never reaches git', async () => {
    git(root, 'switch', '-q', 'feature/x');
    git(root, 'switch', '-q', 'main');
    for (const name of ['@{-1}', '-', 'refs/heads/feature/x', 'HEAD']) {
      expect(await switchTo(name), name).toMatchObject({ status: 404, body: { error: 'unknown-branch' } });
      expect(branchNow(), name).toBe('main');
    }
  });

  it('a body without a branch name is a bad request', async () => {
    for (const body of [JSON.stringify({ branch: 3 }), JSON.stringify({ branch: '' }), JSON.stringify({}), '{bad']) {
      expect(await post(body), body).toMatchObject({ status: 400, body: { error: 'bad-request' } });
    }
    expect(branchNow()).toBe('main');
  });

  it('only POST', async () => {
    expect((await post('', 'GET')).status).toBe(405);
  });

  it('refuses when local changes conflict, with git\'s own words, and touches nothing', async () => {
    write(path.join(root, 'a.md'), 'mine\n');
    const r = await switchTo('feature/x');
    expect(r).toMatchObject({ status: 409, body: { error: 'git' } });
    const detail = String(r.body.detail);
    expect(detail).toMatch(/overwritten/);
    expect(detail).toMatch(/a\.md/);
    expect(detail).not.toMatch(/^Aborting$/m); // git's noise is trimmed
    expect(branchNow()).toBe('main');
    expect(read(path.join(root, 'a.md'))).toBe('mine\n');
  });

  it('carries changes that do not conflict over to the branch', async () => {
    write(path.join(root, 'b.md'), 'b mine\n');
    write(path.join(root, 'new.md'), 'new\n');
    expect((await switchTo('feature/x')).status).toBe(200);
    expect(branchNow()).toBe('feature/x');
    expect(read(path.join(root, 'b.md'))).toBe('b mine\n');
    expect(read(path.join(root, 'new.md'))).toBe('new\n');
  });

  it('refuses while this window\'s agent is at work', async () => {
    selfBusy = true;
    expect(await switchTo('feature/x')).toMatchObject({ status: 409, body: { error: 'busy' } });
    expect(branchNow()).toBe('main');
  });

  it('refuses while another window\'s agent works in this checkout, below its root too', async () => {
    write(path.join(root, 'sub', 'c.md'), 'c\n');
    commit(root, 'sub');
    for (const w of [root, path.join(root, 'sub')]) {
      busy = [w];
      expect(await switchTo('feature/x'), w).toMatchObject({ status: 409, body: { error: 'busy' } });
      expect(branchNow()).toBe('main');
    }
    git(root, 'reset', '-q', '--hard', 'HEAD~1');
  });

  it('an agent at work in another worktree, even one inside the project, does not block', async () => {
    busy = [held];
    expect((await switchTo('feature/x')).status).toBe(200);
    expect(branchNow()).toBe('feature/x');
  });

  it('refuses a branch another worktree has checked out, with git\'s words', async () => {
    const r = await switchTo('held');
    expect(r).toMatchObject({ status: 409, body: { error: 'git' } });
    expect(String(r.body.detail)).toMatch(/worktree/);
    expect(branchNow()).toBe('main');
  });

  it('outside a repository there is nothing to switch', async () => {
    current = plain;
    expect(await switchTo('main')).toMatchObject({ status: 404, body: { error: 'not-a-repo' } });
  });

  it('writes one audit line: from which branch to which', async () => {
    await switchTo('feature/x');
    expect(audit).toEqual([{ ev: 'git-switch', f: { from: 'main', to: 'feature/x' } }]);
    await switchTo('nope');
    expect(audit).toHaveLength(1);
  });

  it('the next read of the sources and the status sees the new branch at once', async () => {
    expect((await listSources(root))[0]).toMatchObject({ id: 'here', ref: 'main' });
    expect(await gitStatus(root)).toMatchObject({ branch: 'main' });
    await switchTo('feature/x');
    const now = await listSources(root);
    expect(now[0]).toMatchObject({ id: 'here', ref: 'feature/x' });
    expect(now.find((s) => s.id === 'ref:main')).toMatchObject({ kind: 'branch' });
    expect(await gitStatus(root)).toMatchObject({ branch: 'feature/x' });
  });
});
