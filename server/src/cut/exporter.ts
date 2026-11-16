// The export job of the video editor (epic 406): an edit rendered by ffmpeg into the project's `exports/` folder.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CUT_EXT, isPhotoSrc, validateCut, type Cut, type CutIssue } from '@nota-bene/shared/cut';
import { resolveInRoot } from '../files.ts';
import { HIDDEN, renameRetry } from '../platform.ts';
import { cutEnd, exportArgs, type ExportMode, type Sources } from './args.ts';
import { ffmpegEnv, findFfmpeg, isOldFfmpeg, probe as probeWith, readFfmpegVersion, type Probed } from './ffmpeg.ts';

const TAIL_BYTES = 16384;
const TAIL_LINES = 12;
/** the folder of the project the exports go to */
export const EXPORTS = 'exports';
/** how many issues an `invalid-edit` refusal names in its detail (all of them are in `issues`) */
const DETAIL_ISSUES = 5;
/** how many sources are asked of ffmpeg at once */
const PROBES = 4;
/** a temp file of ours (`.<name>.<ext>.<8 hex>.part`) older than this is left over from a crash, and swept */
const STALE_MS = 3600_000;
const TEMP = /^\..+\.(?:mp4|wav|m4a)\.[0-9a-f]{8}\.part$/;

// every running ffmpeg of every exporter, killed when this process exits: one handler, there while any runs
const live = new Set<ChildProcess>();
const killLive = () => { for (const c of live) c.kill('SIGKILL'); };
const track = (c: ChildProcess) => {
  if (live.size === 0) process.on('exit', killLive);
  live.add(c);
};
const untrack = (c: ChildProcess) => {
  if (live.delete(c) && live.size === 0) process.off('exit', killLive);
};

/** `f` over `items`, at most `n` at a time. */
async function pooled<T>(items: readonly T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => { while (next < items.length) await f(items[next++]!); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
}

export class CutExportError extends Error {
  status: number;
  code: string;
  detail: string;
  /** `invalid-edit`: what validateCut found */
  issues?: CutIssue[];
  constructor(status: number, code: string, detail = '', issues?: CutIssue[]) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
    if (issues) this.issues = issues;
  }
}

/**
 * The seam where the edit is read: the file's JSON as a Cut, checked by the shared validateCut (as the timeline shows it).
 * Not JSON is `bad-edit`; an edit with problems is `invalid-edit` with the issues (the first few also in `detail`).
 */
export async function readCut(file: string): Promise<Cut> {
  let v: unknown;
  try {
    v = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new CutExportError(404, 'no-edit');
    throw new CutExportError(422, 'bad-edit', e instanceof Error ? e.message : String(e));
  }
  const check = validateCut(v);
  if (!check.ok) {
    const named = check.errors.slice(0, DETAIL_ISSUES).map((x) => (x.path ? `${x.path}: ${x.code}` : x.code));
    const more = check.errors.length - named.length;
    throw new CutExportError(422, 'invalid-edit', named.join('; ') + (more > 0 ? `; +${more}` : ''), check.errors);
  }
  return check.cut;
}

/** What a page learns of an export. `edit` and `output` are project-relative; `progress` is 0..1. */
export type ExportJob = {
  edit: string;
  mode: ExportMode;
  phase: 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  output: string;
  /** failed: ffmpeg's last stderr lines (or why it could not start) */
  error?: string;
};

export type ExporterOptions = {
  /** read at each start: the root changes when the session switches to another project */
  root: () => string;
  ffmpeg?: () => string | null;
  /** which streams a source has (tests stub it); default: ask ffmpeg */
  probe?: (ffmpeg: string, file: string) => Promise<Probed>;
  /** the release of an ffmpeg binary (tests stub it); default: `ffmpeg -version`, asked once per binary */
  version?: (ffmpeg: string) => string | null;
  /** after SIGTERM, how long before SIGKILL */
  graceMs?: number;
  /** removes a temp file (tests stub it); default: fs.rm, retried while Windows still holds the file */
  rm?: (file: string) => Promise<void> | void;
  /** where a failed removal is told; default: the console */
  warn?: (e: unknown) => void;
};

/** Whether the export can run here: ffmpeg is found, and new enough (4.4: `amix normalize`). */
export type FfmpegState = { ok: true } | { ok: false; reason: 'no-ffmpeg' } | { ok: false; reason: 'old-ffmpeg'; version: string };

type Running = { job: ExportJob; out: string; child: ChildProcess | null; cancelled: boolean; temp: string | null; kill?: NodeJS.Timeout };

/**
 * Exports of edits, at most one running per edit and one per output file. A start checks everything before ffmpeg runs: the edit and every source
 * resolve inside the project (resolveInRoot: no `..`, no absolute path, no symlink out), so does `exports/<name>.<ext>`;
 * ffmpeg then writes a dot-named temp file beside the output, renamed over it on success and removed (once ffmpeg has exited,
 * never throwing) otherwise; the first export into a folder sweeps the temp files a crash left there. ffmpeg runs
 * through spawn with an argument list, never a shell, with no secrets in its environment; cancel and close kill only it.
 * The last job of an edit stays readable (its phase, the output or the error) until the next start.
 */
export class CutExporter {
  private readonly o: Required<ExporterOptions>;
  private readonly jobs = new Map<string, Running>();
  private disposed = false;
  /** the release of each ffmpeg binary asked, by its stat: a replaced binary is asked again */
  private readonly versions = new Map<string, { stamp: string; version: string | null }>();
  /** the exports folders swept of stale temp files */
  private readonly swept = new Set<string>();

  constructor(o: ExporterOptions) {
    this.o = {
      root: o.root, ffmpeg: o.ffmpeg ?? (() => findFfmpeg()), probe: o.probe ?? probeWith, version: o.version ?? readFfmpegVersion,
      graceMs: o.graceMs ?? 3000, rm: o.rm ?? ((f) => fs.promises.rm(f, { force: true, maxRetries: 5, retryDelay: 200 })),
      warn: o.warn ?? ((e) => console.error('[cut-export]', e)),
    };
  }

  /** ffmpeg is looked up anew; its version is asked once per binary. */
  ffmpegState(): FfmpegState {
    const ffmpeg = this.o.ffmpeg();
    if (!ffmpeg) return { ok: false, reason: 'no-ffmpeg' };
    let stamp = '';
    try {
      const st = fs.statSync(ffmpeg);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch { /* a stub path: asked once */ }
    let known = this.versions.get(ffmpeg);
    if (!known || known.stamp !== stamp) {
      known = { stamp, version: this.o.version(ffmpeg) };
      this.versions.set(ffmpeg, known);
    }
    return known.version && isOldFfmpeg(known.version) ? { ok: false, reason: 'old-ffmpeg', version: known.version } : { ok: true };
  }

  available(): boolean {
    return this.ffmpegState().ok;
  }

  /** The edit's last export, or null. */
  job(edit: string): ExportJob | null {
    const abs = resolveInRoot(this.o.root(), edit);
    const r = abs && this.jobs.get(abs);
    return r ? { ...r.job } : null;
  }

  /** Stops a running export (TERM, KILL after the grace). False when none runs. */
  cancel(edit: string): boolean {
    const abs = resolveInRoot(this.o.root(), edit);
    const r = abs && this.jobs.get(abs);
    if (!r || r.job.phase !== 'running' || r.cancelled) return false;
    r.cancelled = true;
    if (r.child) this.kill(r);
    return true;
  }

  /** Kills every running ffmpeg (SIGKILL); each temp file goes once its ffmpeg has exited. The server calls it on close: it never throws. */
  dispose(): void {
    this.disposed = true;
    for (const r of this.jobs.values()) {
      r.cancelled = true;
      clearTimeout(r.kill);
      r.kill = undefined;
      try {
        r.child?.kill('SIGKILL');
      } catch (e) {
        this.o.warn(e);
      }
    }
  }

  /** Starts an export of `edit` (project-relative). Resolves once ffmpeg runs; refusals are CutExportError. */
  async start(edit: string, mode: ExportMode): Promise<ExportJob> {
    if (this.disposed) throw new CutExportError(503, 'closing');
    const state = this.ffmpegState();
    if (!state.ok) throw new CutExportError(501, state.reason, state.reason === 'old-ffmpeg' ? state.version : '');
    const ffmpeg = this.o.ffmpeg()!;
    const root = this.o.root();
    const abs = resolveInRoot(root, edit);
    if (!abs) throw new CutExportError(403, 'outside-project', edit);
    if (!abs.endsWith(CUT_EXT)) throw new CutExportError(400, 'not-an-edit', edit);
    if (this.jobs.get(abs)?.job.phase === 'running') throw new CutExportError(409, 'running');
    const name = path.basename(abs).slice(0, -CUT_EXT.length);
    const output = `${EXPORTS}/${name}.${mode}`;
    // two edits of one name in different folders write the same file: one at a time
    const outKey = path.resolve(root, output);
    for (const other of this.jobs.values()) {
      if (other.job.phase === 'running' && other.out === outKey) throw new CutExportError(409, 'output-busy', output);
    }
    const r: Running = { job: { edit, mode, phase: 'running', progress: 0, output }, out: outKey, child: null, cancelled: false, temp: null };
    this.jobs.set(abs, r); // taken before the first await: a second start of the edit is refused meanwhile
    try {
      const cut = await readCut(abs);
      const end = cutEnd(cut);
      if (!(end > 0)) throw new CutExportError(422, 'empty');
      const sources = await this.sources(ffmpeg, root, cut);
      const out = resolveInRoot(root, output);
      if (!out) throw new CutExportError(403, 'outside-project', output);
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      // the folder may have been made just now; checked again before anything is written into it
      if (!resolveInRoot(root, output)) throw new CutExportError(403, 'outside-project', output);
      this.sweep(path.dirname(out));
      if (r.cancelled) {
        r.job.phase = 'cancelled';
        return { ...r.job };
      }
      r.temp = path.join(path.dirname(out), `.${name}.${mode}.${crypto.randomBytes(4).toString('hex')}.part`);
      this.run(r, ffmpeg, exportArgs(cut, sources, r.temp, mode), out, end);
      return { ...r.job };
    } catch (e) {
      if (this.jobs.get(abs) === r) this.jobs.delete(abs);
      throw e;
    }
  }

  /** Every clip's source, resolved inside the project and probed for a picture and sound, a few at a time (photos are not asked). */
  private async sources(ffmpeg: string, root: string, cut: Cut): Promise<Sources> {
    const out = new Map<string, { file: string; video: boolean; audio: boolean }>();
    const srcs = [...new Set(cut.clips.map((c) => c.src))];
    for (const src of srcs) {
      const file = typeof src === 'string' ? resolveInRoot(root, src) : null;
      if (!file) throw new CutExportError(403, 'outside-project', String(src));
      const st = await fs.promises.stat(file).catch(() => null);
      if (!st?.isFile()) throw new CutExportError(422, 'missing-source', src);
      out.set(src, { file, video: isPhotoSrc(src), audio: false });
    }
    await pooled(srcs.filter((s) => !isPhotoSrc(s)), PROBES, async (src) => {
      const p = await this.o.probe(ffmpeg, out.get(src)!.file);
      if (!p.video && !p.audio) throw new CutExportError(422, 'unreadable-source', src);
      Object.assign(out.get(src)!, { video: p.video, audio: p.audio });
    });
    return out;
  }

  /** Removes a file without ever throwing (a close handler or the server's close calls it); a failure is told, not raised. */
  private remove(file: string): void {
    Promise.resolve().then(() => this.o.rm(file)).catch((e: unknown) => this.o.warn(e));
  }

  /** Once per folder: the temp files of ours that a crash left there, older than STALE_MS, except a running export's. */
  private sweep(dir: string): void {
    if (this.swept.has(dir)) return;
    this.swept.add(dir);
    const ours = new Set([...this.jobs.values()].map((r) => r.temp));
    void (async () => {
      for (const name of await fs.promises.readdir(dir)) {
        const file = path.join(dir, name);
        if (!TEMP.test(name) || ours.has(file)) continue;
        const st = await fs.promises.lstat(file).catch(() => null);
        if (st?.isFile() && Date.now() - st.mtimeMs > STALE_MS) this.remove(file);
      }
    })().catch((e: unknown) => this.o.warn(e));
  }

  private kill(r: Running): void {
    r.child?.kill('SIGTERM');
    clearTimeout(r.kill);
    r.kill = setTimeout(() => r.child?.kill('SIGKILL'), this.o.graceMs);
  }

  private run(r: Running, ffmpeg: string, args: string[], out: string, end: number): void {
    const fail = (error: string) => {
      r.job.phase = 'failed';
      r.job.error = error;
    };
    let child: ChildProcess;
    try {
      child = spawn(ffmpeg, args, { cwd: path.dirname(out), env: ffmpegEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...HIDDEN });
    } catch (e) {
      this.remove(r.temp!);
      r.temp = null;
      return fail(e instanceof Error ? e.message : String(e));
    }
    r.child = child;
    track(child);
    let tail = '';
    child.stderr!.on('data', (d: Buffer) => { tail = (tail + d.toString('utf8')).slice(-TAIL_BYTES); });
    // -progress: `key=value` lines; out_time_us is how far the output got
    let partial = '';
    child.stdout!.on('data', (d: Buffer) => {
      const lines = (partial + d.toString('utf8')).split('\n');
      partial = lines.pop() ?? '';
      for (const l of lines) {
        const m = /^out_time_us=(\d+)/.exec(l.trim());
        if (m) r.job.progress = Math.min(1, Math.round((Number(m[1]) / 1e6 / end) * 1000) / 1000);
      }
    });
    const lastLines = () => tail.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-TAIL_LINES).join('\n');
    const done = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (r.child !== child) return;
      r.child = null;
      clearTimeout(r.kill);
      r.kill = undefined;
      untrack(child);
      const temp = r.temp!;
      r.temp = null;
      if (code === 0 && !r.cancelled && !error) {
        try {
          renameRetry(temp, out);
          r.job.phase = 'done';
          r.job.progress = 1;
          return;
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
      } else if (r.cancelled) r.job.phase = 'cancelled';
      else fail(error?.message ?? (lastLines() || `ffmpeg exited with ${signal ?? code}`));
      this.remove(temp);
    };
    child.on('error', (e) => done(null, null, e));
    child.on('close', (code, signal) => done(code, signal));
  }
}
