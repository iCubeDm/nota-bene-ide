import fs from 'node:fs';
import path from 'node:path';
import type { Source, VcsBaseHow, VcsBranch, VcsCommit, VcsCommitDetail, VcsDiff, VcsFile, VcsLog, VcsPatch } from '@nota-bene/shared';
import { git, listSources, repo } from './git.ts';
import { HIDDEN } from './files.ts';
import { stateRelativeTo } from './stateGuard.ts';

/** Read-only git views. Nothing here switches, stages or writes. */

const TIMEOUT = 8_000;
const PATCH_MAX = 3 << 20;
const FILES_MAX = 3000;
const LOG_MAX = 400;
const UNTRACKED_SIZE = 512 * 1024;
const BRANCHES_MAX = 40;
/** A polling window must never hold index.lock while an agent commits in the same repository. */
const QUIET = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];
/** A repository's config does not get to run programs through these views. */
const PLAIN = ['--no-color', '--no-ext-diff', '--no-textconv'];

const text = async (cwd: string, args: string[], max = 16 << 20) => (await git(cwd, [...QUIET, ...args], max, TIMEOUT)).toString('utf8');
/** For the commands whose exit code is an answer: no such ref, no common ancestor. A git that timed out said nothing. */
const tryText = (cwd: string, args: string[]) => text(cwd, args).catch((e: unknown) => {
  if (typeof (e as { code?: unknown }).code === 'number') return null;
  throw e;
});

type Spot = { cwd: string; tip: string; live: boolean; branch: string | null; top: string; prefix: string };

async function spotOf(root: string, src: Source | 'here'): Promise<Spot | null> {
  const { top, prefix } = await repo(root);
  if (!top) return null;
  if (src === 'here') {
    const head = (await tryText(root, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || null;
    return { cwd: path.resolve(root), tip: 'HEAD', live: true, branch: head, top, prefix };
  }
  if (src.kind === 'worktree' && src.dir) return { cwd: src.dir, tip: 'HEAD', live: true, branch: src.ref.startsWith('(detached)') ? null : src.ref, top, prefix };
  return { cwd: top, tip: `refs/heads/${src.ref}`, live: false, branch: src.ref, top, prefix };
}

const branchesOf = async (top: string) => ((await tryText(top, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])) ?? '').split('\n').filter(Boolean);

async function defaultOf(top: string, branches: string[]): Promise<string | null> {
  const o = (await tryText(top, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']))?.trim().replace('refs/remotes/origin/', '');
  if (o && branches.includes(o)) return o;
  return branches.find((b) => b === 'main' || b === 'master') ?? o ?? null;
}

const mergeBase = async (cwd: string, a: string, b: string) => (await tryText(cwd, ['merge-base', a, b]))?.trim() || null;
const count = async (cwd: string, range: string) => Number((await tryText(cwd, ['rev-list', '--count', range]))?.trim() ?? 0);

/** `git checkout -b` records "Created from HEAD"; the branch it left is in HEAD's own reflog. */
async function leftFor(cwd: string, branch: string): Promise<string | undefined> {
  const moves = ((await tryText(cwd, ['reflog', 'show', '--format=%gs', 'HEAD'])) ?? '').trim().split('\n');
  const to = ` to ${branch}`;
  for (let i = moves.length - 1; i >= 0; i--) {
    const l = moves[i]!;
    if (l.startsWith('checkout: moving from ') && l.endsWith(to)) return l.slice('checkout: moving from '.length, -to.length);
  }
  return undefined;
}

/** Git keeps no parent branch: the creation record when it names a branch, otherwise the default branch. */
async function detect(cwd: string, branch: string | null, branches: string[], def: string | null): Promise<{ base: string | null; how: VcsBaseHow }> {
  if (branch && branch === def) return { base: null, how: 'none' };
  if (branch) {
    const lines = ((await tryText(cwd, ['reflog', 'show', '--format=%gs', `refs/heads/${branch}`])) ?? '').trim().split('\n');
    const named = /^branch: Created from (.+)$/.exec(lines[lines.length - 1] ?? '')?.[1]?.replace(/^refs\/heads\//, '');
    const from = named === 'HEAD' ? await leftFor(cwd, branch) : named;
    if (from && from !== branch && from !== def && branches.includes(from)) return { base: from, how: 'reflog' };
  }
  return def ? { base: def, how: 'default' } : { base: null, how: 'none' };
}

const refOf = (b: string, branches: string[]) => (branches.includes(b) ? `refs/heads/${b}` : `refs/remotes/origin/${b}`);

/** `--name-status -z` plus `--numstat -z` of one range into rows. */
function rowsOf(names: string, nums: string): VcsFile[] {
  const stats = new Map<string, { add: number | null; del: number | null; binary: boolean }>();
  const n = nums.split('\0');
  for (let i = 0; i < n.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(n[i]!);
    if (!m) continue;
    const path = m[3] || ((i += 2), n[i]!); // a rename: empty here, then old and new
    stats.set(path, { add: m[1] === '-' ? null : +m[1]!, del: m[2] === '-' ? null : +m[2]!, binary: m[1] === '-' });
  }
  const t = names.split('\0').filter(Boolean);
  const rows: VcsFile[] = [];
  for (let i = 0; i < t.length;) {
    const c = t[i++]![0];
    const moved = c === 'R' || c === 'C';
    const old = moved ? t[i++] : undefined;
    const path = t[i++]!;
    const st = stats.get(path) ?? { add: null, del: null, binary: false };
    rows.push({ path, ...(c === 'R' ? { old } : {}), status: c === 'R' ? 'R' : c === 'C' || c === 'A' ? 'A' : c === 'D' ? 'D' : 'M', ...st });
  }
  return rows;
}

const safeRel = (rel: string) => !!rel && !rel.includes('\0') && !rel.startsWith('/') && !rel.split('/').includes('..');
const SHA = /^[0-9a-f]{7,64}$/;

/** What no view shows, as in the tree and the file search: `.git`, `node_modules`, the marks and the state folders. */
function hiderOf(top: string, prefix: string): (rel: string) => boolean {
  const inState = stateRelativeTo(path.join(top, prefix));
  return (rel) => rel.split('/').some((seg) => HIDDEN.has(seg) || seg === '.nota-bene') || inState(rel);
}

function untrackedPatch(cwd: string, rel: string): string {
  const head = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n`;
  try {
    const abs = path.join(cwd, rel);
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return '';
    if (st.size > UNTRACKED_SIZE) return `${head}Binary files /dev/null and b/${rel} differ\n`;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return `${head}Binary files /dev/null and b/${rel} differ\n`;
    if (!buf.length) return head;
    const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
    return `${head}--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
  } catch {
    return '';
  }
}

/** What `git diff` compares to the working tree when there is no commit yet: nothing. */
const headOf = async (cwd: string) => ((await tryText(cwd, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])) ? 'HEAD' : (await text(cwd, ['hash-object', '-t', 'tree', '/dev/null'])).trim());

async function rangeOf(root: string, src: Source | 'here', override: string | null) {
  const s = await spotOf(root, src);
  if (!s) return null;
  const branches = await branchesOf(s.top);
  const def = await defaultOf(s.top, branches);
  const found = await detect(s.cwd, s.branch, branches, def);
  const named = override && branches.includes(override) ? override : null;
  // the default of a working folder is what is not committed yet; a branch without a folder has only its commits. BASE: the whole branch
  const wanted = !override && s.live ? null : named ?? found.base;
  const uncommitted = s.live && !wanted;
  const mb = wanted ? await mergeBase(s.cwd, s.tip, refOf(wanted, branches)) : null;
  const relative = s.live ? ['--relative'] : s.prefix ? [`--relative=${s.prefix}`] : [];
  const ends = uncommitted ? [await headOf(s.cwd)] : mb ? [mb, ...(s.live ? [] : [s.tip])] : null; // null: nothing to compare
  return { s, branches, found, uncommitted, base: wanted, mb, how: named || !wanted ? 'none' as const : found.how, unrelated: !!wanted && !mb, range: ends && [...relative, ...ends], hidden: hiderOf(s.top, s.prefix) };
}

const untracked = async (cwd: string) => (await text(cwd, ['ls-files', '-o', '--exclude-standard', '-z'], 64 << 20)).split('\0').filter(Boolean);

/** The list only: this is polled, so it never carries file contents. */
export async function diffOf(root: string, src: Source | 'here', override: string | null): Promise<VcsDiff> {
  const r = await rangeOf(root, src, override);
  if (!r) return { repo: false };
  const { s } = r;
  let files: VcsFile[] = [];
  if (r.range) {
    const [names, nums] = await Promise.all(['--name-status', '--numstat'].map((f) => text(s.cwd, ['diff', '-z', f, '--no-ext-diff', '--no-textconv', ...r.range!], 64 << 20)));
    files = rowsOf(names!, nums!);
    if (s.live) for (const rel of await untracked(s.cwd)) files.push({ path: rel, status: 'A', add: null, del: null, binary: false });
  }
  files = files.filter((f) => !r.hidden(f.path));
  const log = r.mb ? await text(s.cwd, ['log', '--format=%h%x09%s', '-n', '30', `${r.mb}..${s.tip}`]) : '';
  const commitCount = r.mb ? await count(s.cwd, `${r.mb}..${s.tip}`) : 0;
  return {
    repo: true,
    branch: s.branch,
    live: s.live,
    base: r.base,
    detected: r.found.base,
    how: r.how,
    uncommitted: r.uncommitted,
    unrelated: r.unrelated,
    mergeBase: r.mb?.slice(0, 7) ?? null,
    commits: log.split('\n').filter(Boolean).map((l) => ({ sha: l.slice(0, l.indexOf('\t')), subject: l.slice(l.indexOf('\t') + 1) })),
    commitCount,
    candidates: r.branches.filter((b) => b !== s.branch),
    files: files.slice(0, FILES_MAX),
    truncated: files.length > FILES_MAX,
  };
}

const capped = (patch: string): VcsPatch => (patch.length > PATCH_MAX ? { patch: patch.slice(0, patch.lastIndexOf('\n', PATCH_MAX) + 1), truncated: true } : { patch, truncated: false });
/** A patch past git's output limit is "too big", not a failure. */
const orTooBig = (e: unknown): VcsPatch => {
  if ((e as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { patch: '', truncated: true };
  throw e;
};

/** One file of the current diff; null for a path no view may show. */
export async function fileOf(root: string, src: Source | 'here', override: string | null, rel: string, old: string | null): Promise<VcsPatch | null> {
  if (!safeRel(rel) || (old && !safeRel(old))) return null;
  const r = await rangeOf(root, src, override);
  if (!r || r.hidden(rel) || (old && r.hidden(old))) return null;
  if (!r.range) return { patch: '', truncated: false };
  const { s } = r;
  // from the repository's top a pathspec is not relative to the project, whatever --relative does to the output
  const spec = (p: string) => (s.live ? p : path.posix.join(s.prefix, p));
  try {
    const patch = await text(s.cwd, ['--literal-pathspecs', 'diff', ...PLAIN, ...r.range, '--', spec(rel), ...(old ? [spec(old)] : [])]);
    if (patch || !s.live) return capped(patch);
  } catch (e) { return orTooBig(e); }
  const out = await text(s.cwd, ['--literal-pathspecs', 'ls-files', '-o', '--exclude-standard', '--', rel]);
  return capped(out.trim() ? untrackedPatch(s.cwd, rel) : '');
}

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** The folder holding each working window: the deepest one, since worktrees often sit inside the project. */
function holders(folders: string[], working: string[]): Set<string> {
  const held = new Set<string>();
  for (const w of working.map(real)) {
    const home = folders.filter((f) => w === f || w.startsWith(f + path.sep)).sort((a, b) => b.length - a.length)[0];
    if (home) held.add(home);
  }
  return held;
}

/** For the header list: how far each source is from its base, whether a live one has uncommitted work and an agent at work (`working`: the roots of the busy windows). */
export async function branchInfo(root: string, working: string[] = []): Promise<VcsBranch[]> {
  const all = await listSources(root);
  const { top } = await repo(root);
  if (!top) return [];
  const branches = await branchesOf(top);
  const def = await defaultOf(top, branches);
  const spots = await Promise.all(all.slice(0, BRANCHES_MAX).map((src) => spotOf(root, src.id === 'here' ? 'here' : src)));
  const held = holders(spots.flatMap((s) => (s?.live ? [real(s.cwd)] : [])), working);
  const rows = await Promise.all(all.slice(0, BRANCHES_MAX).map(async (src, i) => {
    const s = spots[i];
    if (!s) return null;
    const { base } = await detect(s.cwd, s.branch, branches, def);
    const mb = base ? await mergeBase(s.cwd, s.tip, refOf(base, branches)) : null;
    const dirty = s.live ? ((await tryText(s.cwd, ['status', '--porcelain=v1', '--ignore-submodules'])) ?? '').trim() !== '' : false;
    const at = (await tryText(s.cwd, ['log', '-1', '--format=%ct', s.tip]))?.trim();
    return { id: src.id, branch: s.branch, base, ahead: mb ? await count(s.cwd, `${mb}..${s.tip}`) : 0, dirty, busy: s.live && held.has(real(s.cwd)), at: Number(at ?? 0) };
  }));
  return rows.filter((r) => r !== null);
}

const SEP = '\x1f', END = '\x1e';

export async function logOf(root: string, src: Source | 'here', all: boolean): Promise<VcsLog> {
  const s = await spotOf(root, src);
  if (!s) return { repo: false, commits: [], tip: null, more: false };
  if (await headOf(s.cwd) !== 'HEAD') return { repo: true, commits: [], tip: null, more: false };
  const refs = all ? ['--branches', '--remotes', '--tags', s.tip] : [s.tip];
  const raw = await text(s.cwd, ['log', '--topo-order', '-n', String(LOG_MAX + 1), `--format=%H${SEP}%P${SEP}%an${SEP}%at${SEP}%s${SEP}%D${END}`, ...refs]);
  const commits: VcsCommit[] = raw.split(END).map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, parents, author, at, subject, decor] = r.split(SEP);
    return { sha: sha!, parents: parents ? parents.split(' ') : [], author: author ?? '', at: Number(at), subject: subject ?? '', refs: decor ? decor.split(', ') : [] };
  });
  return { repo: true, commits: commits.slice(0, LOG_MAX), tip: (await tryText(s.cwd, ['rev-parse', s.tip]))?.trim() ?? null, more: commits.length > LOG_MAX };
}

const shown = ['show', '-m', '--first-parent', '--format='];

export async function commitOf(root: string, sha: string): Promise<VcsCommitDetail | null> {
  if (!SHA.test(sha)) return null;
  const { top, prefix } = await repo(root);
  if (!top) return null;
  const meta = await tryText(top, ['show', '-s', `--format=%H${SEP}%an${SEP}%at${SEP}%B`, `${sha}^{commit}`]);
  if (!meta) return null;
  const [full, author, at, ...rest] = meta.split(SEP);
  const rel = prefix ? [`--relative=${prefix}`] : [];
  const [names, nums] = await Promise.all(['--name-status', '--numstat'].map((f) => text(top, [...shown, '--no-ext-diff', '--no-textconv', '-z', f, ...rel, full!], 64 << 20)));
  const hidden = hiderOf(top, prefix);
  const files = rowsOf(names!, nums!).filter((f) => !hidden(f.path));
  return { sha: full!, author: author!, at: Number(at), message: rest.join(SEP).trim(), files: files.slice(0, FILES_MAX), truncated: files.length > FILES_MAX };
}

export async function commitFileOf(root: string, sha: string, file: string, old: string | null): Promise<VcsPatch | null> {
  if (!SHA.test(sha) || !safeRel(file) || (old && !safeRel(old))) return null;
  const { top, prefix } = await repo(root);
  if (!top) return null;
  const hidden = hiderOf(top, prefix);
  if (hidden(file) || (old && hidden(old))) return null;
  return text(top, ['--literal-pathspecs', ...shown, ...PLAIN, ...(prefix ? [`--relative=${prefix}`] : []), sha, '--', path.posix.join(prefix, file), ...(old ? [path.posix.join(prefix, old)] : [])]).then(capped, orTooBig);
}
