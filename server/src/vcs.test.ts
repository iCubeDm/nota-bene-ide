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
import { clearSourceCache, listSources } from './git.ts';
import { branchInfo, commitFileOf, commitOf, diffOf, fileOf, logOf } from './vcs.ts';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString();
const write = (p: string, s: string | Buffer) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const commit = (cwd: string, m: string) => { git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', m); };

// main; `feature/parent` from main; `agent/one` from main with a worktree; `agent/stacked` from feature/parent with a clean worktree
const allowedHosts: string[] = [];
let dir: string, root: string, one: string, stacked: string, server: http.Server, port: number;
const paths = (d: { repo: boolean; files?: { path: string }[] }) => (d as { files: { path: string }[] }).files.map((f) => f.path).sort();
const src = async (id: string) => (await listSources(root)).find((s) => s.id === id)!;

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-vcs-')));
  root = path.join(dir, 'main');
  one = path.join(dir, 'one');
  stacked = path.join(dir, 'stacked');
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  write(path.join(root, 'a.md'), 'a\n');
  write(path.join(root, 'moved.md'), 'stays the same\nacross a rename\nline three\nline four\n');
  commit(root, 'init');
  git(root, 'branch', 'feature/parent');
  git(root, 'worktree', 'add', '-q', '-b', 'agent/one', one);
  write(path.join(one, 'committed.md'), 'c\n');
  commit(one, 'one: commit');
  write(path.join(one, 'a.md'), 'a changed\n');
  write(path.join(one, 'new файл.md'), 'новое\n');
  git(root, 'worktree', 'add', '-q', stacked, 'feature/parent');
  write(path.join(stacked, 'parent.md'), 'p\n');
  commit(stacked, 'parent: commit');
  git(stacked, 'checkout', '-q', '-b', 'agent/stacked');
  server = http.createServer(httpHandler({ hub: new EventHub(), webDist: dir, allowedHosts, allowedOrigins: [], info: () => ({}), extra: fileRoutes({ root: () => root, hub: new EventHub(), complete: async () => [], working: async () => [one] }) }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => clearSourceCache());

describe('the range', () => {
  it('a folder shows what is not committed by default, untracked files too, and no commits', async () => {
    const d = await diffOf(root, await src('ref:agent/one'), null);
    expect(paths(d)).toEqual(['a.md', 'new файл.md']);
    expect(d).toMatchObject({ uncommitted: true, base: null, detected: 'main', commits: [] });
  });

  it('BASE is the whole branch from its fork point, to the working tree', async () => {
    const d = await diffOf(root, await src('ref:agent/one'), 'BASE');
    expect(paths(d)).toEqual(['a.md', 'committed.md', 'new файл.md']);
    expect(d).toMatchObject({ uncommitted: false, base: 'main', how: 'default' });
    expect(d.repo && d.commits.map((c) => c.subject)).toEqual(['one: commit']);
    expect(d).toMatchObject({ commitCount: 1 });
  });

  it('the base of a branch created from another branch is that branch, by the reflog', async () => {
    const d = await diffOf(root, await src('ref:agent/stacked'), 'BASE');
    expect(d).toMatchObject({ base: 'feature/parent', how: 'reflog' });
    expect(paths(d)).toEqual([]);
  });

  it('git checkout -b records "Created from HEAD": the branch it left is the base', async () => {
    git(stacked, 'checkout', '-q', 'feature/parent');
    git(stacked, 'checkout', '-q', '-b', 'agent/hop');
    try {
      clearSourceCache();
      expect(await diffOf(root, await src('ref:agent/hop'), 'BASE')).toMatchObject({ base: 'feature/parent', how: 'reflog' });
    } finally { git(stacked, 'checkout', '-q', 'agent/stacked'); git(root, 'branch', '-D', 'agent/hop'); }
  });

  it('a clean folder shows nothing by default', async () => {
    expect(paths(await diffOf(root, await src('ref:agent/stacked'), null))).toEqual([]);
  });

  it('a branch without a folder shows the whole branch; it has nothing uncommitted', async () => {
    git(root, 'branch', 'plain', git(root, 'rev-parse', 'agent/one').trim());
    try {
      clearSourceCache();
      const d = await diffOf(root, await src('ref:plain'), null);
      expect(paths(d)).toEqual(['committed.md']);
      expect(d).toMatchObject({ live: false, uncommitted: false, base: 'main' });
    } finally { git(root, 'branch', '-D', 'plain'); }
  });

  it('the default branch has no base', async () => {
    const d = await diffOf(root, 'here', null);
    expect(d).toMatchObject({ branch: 'main', base: null, detected: null, uncommitted: true });
  });

  it('a named branch overrides; a name that is no branch does not', async () => {
    const s = await src('ref:agent/one');
    expect(await diffOf(root, s, 'feature/parent')).toMatchObject({ base: 'feature/parent', how: 'none' });
    expect(await diffOf(root, s, '--output=/tmp/x')).toMatchObject({ base: 'main' });
  });

  it('no common ancestor is said, not papered over', async () => {
    git(root, 'checkout', '-q', '--orphan', 'island');
    git(root, 'commit', '-qm', 'island');
    git(root, 'checkout', '-q', 'main');
    try {
      clearSourceCache();
      const d = await diffOf(root, await src('ref:island'), null);
      expect(d).toMatchObject({ unrelated: true, base: 'main', files: [] });
    } finally { git(root, 'branch', '-D', 'island'); }
  });
});

describe('one file', () => {
  it('a tracked, an untracked and a Cyrillic path with a space', async () => {
    const s = await src('ref:agent/one');
    expect((await fileOf(root, s, null, 'a.md', null))!.patch).toContain('+a changed');
    expect((await fileOf(root, s, null, 'new файл.md', null))!.patch).toContain('+новое');
    expect((await fileOf(root, s, 'BASE', 'committed.md', null))!.patch).toContain('+c');
  });

  it('a rename keeps both names', async () => {
    write(path.join(root, 'x/renamed.md'), fs.readFileSync(path.join(root, 'moved.md')));
    fs.rmSync(path.join(root, 'moved.md'));
    git(root, 'add', '.');
    try {
      const d = await diffOf(root, 'here', null);
      expect(d.repo && d.files).toContainEqual(expect.objectContaining({ path: 'x/renamed.md', old: 'moved.md', status: 'R' }));
      expect((await fileOf(root, 'here', null, 'x/renamed.md', 'moved.md'))!.patch).toContain('rename from moved.md');
    } finally { git(root, 'reset', '-q', '--hard'); }
  });

  it('refuses a path outside the project', async () => {
    expect(await fileOf(root, 'here', null, '../x', null)).toBeNull();
    expect(await fileOf(root, 'here', null, '/etc/passwd', null)).toBeNull();
    expect(await fileOf(root, 'here', null, 'a.md', '../x')).toBeNull();
  });

  it('a symlink in the working tree shows no target', async () => {
    fs.writeFileSync(path.join(dir, 'secret'), 'secret');
    fs.symlinkSync(path.join(dir, 'secret'), path.join(root, 'link'));
    try {
      expect((await fileOf(root, 'here', null, 'link', null))!.patch).not.toContain('secret\n');
    } finally { fs.rmSync(path.join(root, 'link')); }
  });
});

describe('what no view shows', () => {
  it('the marks folder and node_modules, in the list, one file and a commit', async () => {
    write(path.join(root, '.nota-bene/marks/m.txt'), 'm\n');
    write(path.join(root, 'node_modules/x/i.js'), 'x\n');
    write(path.join(root, 'kept.md'), 'k\n');
    try {
      expect(paths(await diffOf(root, 'here', null))).toEqual(['kept.md']);
      expect(await fileOf(root, 'here', null, '.nota-bene/marks/m.txt', null)).toBeNull();
      expect(await fileOf(root, 'here', null, 'node_modules/x/i.js', null)).toBeNull();
      git(root, 'add', '-f', '.');
      git(root, 'commit', '-qm', 'tracked by mistake');
      const sha = git(root, 'rev-parse', 'HEAD').trim();
      expect((await commitOf(root, sha))!.files.map((f) => f.path)).toEqual(['kept.md']);
      expect(await commitFileOf(root, sha, '.nota-bene/marks/m.txt', null)).toBeNull();
    } finally { git(root, 'reset', '-q', '--hard', 'HEAD~1'); fs.rmSync(path.join(root, 'kept.md'), { force: true }); fs.rmSync(path.join(root, '.nota-bene'), { recursive: true, force: true }); fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true }); }
  });

  it('the state folder when it sits inside the project', async () => {
    const home = path.join(root, 'state-here');
    write(path.join(home, 'tokens/x'), 'never shown\n');
    const was = process.env.NOTA_BENE_HOME;
    process.env.NOTA_BENE_HOME = home;
    try {
      expect(paths(await diffOf(root, 'here', null))).toEqual([]);
      expect(await fileOf(root, 'here', null, 'state-here/tokens/x', null)).toBeNull();
    } finally {
      if (was === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = was;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('around an agent', () => {
  it('polling takes no index lock, whatever the agent holds', async () => {
    const lock = path.join(root, '.git/index.lock');
    fs.writeFileSync(lock, '');
    write(path.join(root, 'a.md'), 'dirty\n');
    try {
      expect(paths(await diffOf(root, 'here', null))).toEqual(['a.md']);
      expect((await branchInfo(root)).find((b) => b.id === 'here')).toMatchObject({ dirty: true });
    } finally { fs.rmSync(lock); git(root, 'checkout', '-q', '--', 'a.md'); }
  });

  it('a repository config runs nothing through a diff', async () => {
    git(root, 'config', 'diff.external', 'false');
    write(path.join(root, 'a.md'), 'dirty\n');
    try {
      expect((await fileOf(root, 'here', null, 'a.md', null))!.patch).toContain('+dirty');
    } finally { git(root, 'config', '--unset', 'diff.external'); git(root, 'checkout', '-q', '--', 'a.md'); }
  });

  it('a git failure is an error, never "no changes"', async () => {
    const broken = path.join(dir, 'broken');
    fs.mkdirSync(broken);
    git(broken, 'init', '-q', '-b', 'main');
    write(path.join(broken, 'a.md'), 'a\n');
    commit(broken, 'init');
    fs.writeFileSync(path.join(broken, '.git/index'), 'not an index');
    await expect(diffOf(broken, 'here', null)).rejects.toThrow();
  });
});

describe('edges', () => {
  it('a project in a subfolder of the repository: patches of a branch and a commit are not empty', async () => {
    const mono = path.join(dir, 'mono');
    fs.mkdirSync(path.join(mono, 'proj/src'), { recursive: true });
    git(mono, 'init', '-q', '-b', 'main');
    write(path.join(mono, 'proj/src/a.txt'), 'a\n');
    commit(mono, 'init');
    git(mono, 'checkout', '-q', '-b', 'feat');
    write(path.join(mono, 'proj/src/a.txt'), 'b\n');
    commit(mono, 'change');
    const sha = git(mono, 'rev-parse', 'HEAD').trim();
    git(mono, 'checkout', '-q', 'main');
    const project = path.join(mono, 'proj');
    const feat = (await listSources(project)).find((x) => x.id === 'ref:feat')!;
    expect(paths(await diffOf(project, feat, null))).toEqual(['src/a.txt']);
    expect((await fileOf(project, feat, null, 'src/a.txt', null))!.patch).toContain('+b');
    expect((await commitFileOf(project, sha, 'src/a.txt', null))!.patch).toContain('+b');
  });

  it('a git killed halfway is an error, not "no common ancestor"', async () => {
    const real = execFileSync('which', ['git']).toString().trim();
    const bin = path.join(dir, 'bin');
    write(path.join(bin, 'git'), `#!/bin/sh\ncase "$*" in *merge-base*) kill -9 $$;; esac\nexec ${real} "$@"\n`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    const was = process.env.PATH;
    process.env.PATH = `${bin}:${was}`;
    try {
      await expect(diffOf(root, await src('ref:agent/one'), 'BASE')).rejects.toThrow();
    } finally { process.env.PATH = was; }
  });

  it('an empty untracked file has no hunk', async () => {
    write(path.join(root, 'empty.md'), '');
    try {
      expect((await fileOf(root, 'here', null, 'empty.md', null))!.patch).not.toContain('@@');
    } finally { fs.rmSync(path.join(root, 'empty.md')); }
  });

  it('a repository without commits lists what is untracked', async () => {
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    git(empty, 'init', '-q', '-b', 'main');
    write(path.join(empty, 'a.md'), 'a\n');
    expect(paths(await diffOf(empty, 'here', null))).toEqual(['a.md']);
    expect(await logOf(empty, 'here', true)).toMatchObject({ repo: true, commits: [] });
  });

  it('outside a repository', async () => {
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    expect(await diffOf(plain, 'here', null)).toEqual({ repo: false });
    expect(await branchInfo(plain)).toEqual([]);
    expect(await logOf(plain, 'here', true)).toMatchObject({ repo: false });
  });
});

describe('the log', () => {
  it('commits with parents and refs, all branches or one', async () => {
    const all = await logOf(root, 'here', true);
    expect(all.commits.map((c) => c.subject)).toEqual(expect.arrayContaining(['init', 'one: commit', 'parent: commit']));
    const only = await logOf(root, 'here', false);
    expect(only.commits.map((c) => c.subject)).toEqual(['init']);
    expect(only.commits[0]!.refs.join()).toContain('main');
    expect(only.more).toBe(false);
  });

  it('a commit and one of its files; a bad sha is refused', async () => {
    const sha = git(one, 'rev-parse', 'HEAD').trim();
    const c = await commitOf(root, sha);
    expect(c).toMatchObject({ sha, message: 'one: commit' });
    expect(c!.files.map((f) => f.path)).toEqual(['committed.md']);
    expect((await commitFileOf(root, sha, 'committed.md', null))!.patch).toContain('+c');
    expect(await commitOf(root, '--all')).toBeNull();
    expect(await commitFileOf(root, 'HEAD', 'a.md', null)).toBeNull();
  });

  it('the picker knows base, distance, dirt and where an agent works', async () => {
    const list = await branchInfo(root, [one]);
    expect(list.find((b) => b.id === 'ref:agent/one')).toMatchObject({ base: 'main', ahead: 1, dirty: true, busy: true });
    expect(list.find((b) => b.id === 'ref:agent/stacked')).toMatchObject({ base: 'feature/parent', ahead: 0, dirty: false });
    expect(list.find((b) => b.id === 'here')).toMatchObject({ base: null, dirty: false, busy: false });
  });

  it('a window in a worktree inside the project marks that worktree alone; a window below a folder marks the folder', async () => {
    const inner = path.join(root, '.wt/inner');
    git(root, 'worktree', 'add', '-q', '-b', 'agent/inner', inner);
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    try {
      clearSourceCache();
      const nested = await branchInfo(root, [inner]);
      expect(nested.find((b) => b.id === 'ref:agent/inner')?.busy).toBe(true);
      expect(nested.find((b) => b.id === 'here')?.busy).toBe(false);
      expect((await branchInfo(root, [path.join(root, 'sub')])).find((b) => b.id === 'here')?.busy).toBe(true);
    } finally { git(root, 'worktree', 'remove', '--force', inner); git(root, 'branch', '-D', 'agent/inner'); fs.rmSync(path.join(root, 'sub'), { recursive: true, force: true }); fs.rmSync(path.join(root, '.wt'), { recursive: true, force: true }); }
  });

  it('the routes', async () => {
    const get = (u: string) => fetch(`http://127.0.0.1:${port}${u}`);
    const branches = await (await get('/vcs-branches')).json() as { id: string; busy: boolean }[];
    expect(branches.find((b) => b.id === 'ref:agent/one')?.busy).toBe(true);
    expect((await get('/vcs-diff?src=ref:agent/one&base=BASE')).status).toBe(200);
    expect((await get('/vcs-diff?src=ref:nope')).status).toBe(400);
    expect((await get('/vcs-file?path=../x')).status).toBe(403);
    expect((await get('/vcs-commit?sha=nothex')).status).toBe(404);
    expect((await get('/vcs-commit-file?sha=nothex&path=a.md')).status).toBe(403);
  });
});
