// The export job of the video editor (epic 406): an edit rendered by ffmpeg into the project's `exports/` folder.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CUT_EXT, isPhotoSrc, validateCut, type Cut, type CutIssue } from '@nota-bene/shared/cut';
import { resolveInRoot } from '../files.ts';
import { HIDDEN, renameRetry } from '../platform.ts';
import { cutEnd, exportArgs, type ExportMode, type Sources } from './args.ts';
import { ffmpegEnv, findFfmpeg, probe as probeWith, type Probed } from './ffmpeg.ts';

const TAIL_BYTES = 16384;
const TAIL_LINES = 12;
/** the folder of the project the exports go to */
export const EXPORTS = 'exports';
/** how many issues an `invalid-edit` refusal names in its detail (all of them are in `issues`) */
const DETAIL_ISSUES = 5;

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
  /** after SIGTERM, how long before SIGKILL */
  graceMs?: number;
};

type Running = { job: ExportJob; child: ChildProcess | null; cancelled: boolean; temp: string | null; kill?: NodeJS.Timeout };

/**
 * Exports of edits, at most one running per edit. A start checks everything before ffmpeg runs: the edit and every source
 * resolve inside the project (resolveInRoot: no `..`, no absolute path, no symlink out), so does `exports/<name>.<ext>`;
 * ffmpeg then writes a dot-named temp file beside the output, renamed over it on success and removed otherwise. ffmpeg runs
 * through spawn with an argument list, never a shell, with no secrets in its environment; cancel and close kill only it.
 * The last job of an edit stays readable (its phase, the output or the error) until the next start.
 */
export class CutExporter {
  private readonly o: Required<ExporterOptions>;
  private readonly jobs = new Map<string, Running>();
  private disposed = false;
  private readonly onExit = () => { for (const r of this.jobs.values()) r.child?.kill('SIGKILL'); };

  constructor(o: ExporterOptions) {
    this.o = { root: o.root, ffmpeg: o.ffmpeg ?? (() => findFfmpeg()), probe: o.probe ?? probeWith, graceMs: o.graceMs ?? 3000 };
  }

  available(): boolean {
    return this.o.ffmpeg() !== null;
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

  /** Kills every running ffmpeg (SIGKILL) and removes the temp files; the server calls it on close. */
  dispose(): void {
    this.disposed = true;
    for (const r of this.jobs.values()) {
      r.cancelled = true;
      r.child?.kill('SIGKILL');
      if (r.temp) fs.rmSync(r.temp, { force: true });
    }
  }

  /** Starts an export of `edit` (project-relative). Resolves once ffmpeg runs; refusals are CutExportError. */
  async start(edit: string, mode: ExportMode): Promise<ExportJob> {
    if (this.disposed) throw new CutExportError(503, 'closing');
    const ffmpeg = this.o.ffmpeg();
    if (!ffmpeg) throw new CutExportError(501, 'no-ffmpeg');
    const root = this.o.root();
    const abs = resolveInRoot(root, edit);
    if (!abs) throw new CutExportError(403, 'outside-project', edit);
    if (!abs.endsWith(CUT_EXT)) throw new CutExportError(400, 'not-an-edit', edit);
    if (this.jobs.get(abs)?.job.phase === 'running') throw new CutExportError(409, 'running');
    const name = path.basename(abs).slice(0, -CUT_EXT.length);
    const output = `${EXPORTS}/${name}.${mode}`;
    const r: Running = { job: { edit, mode, phase: 'running', progress: 0, output }, child: null, cancelled: false, temp: null };
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

  /** Every clip's source, resolved inside the project and probed for sound (photos are not asked). */
  private async sources(ffmpeg: string, root: string, cut: Cut): Promise<Sources> {
    const out = new Map<string, { file: string; audio: boolean }>();
    const srcs = [...new Set(cut.clips.map((c) => c.src))];
    for (const src of srcs) {
      const file = typeof src === 'string' ? resolveInRoot(root, src) : null;
      if (!file) throw new CutExportError(403, 'outside-project', String(src));
      const st = await fs.promises.stat(file).catch(() => null);
      if (!st?.isFile()) throw new CutExportError(422, 'missing-source', src);
      out.set(src, { file, audio: false });
    }
    await Promise.all(srcs.filter((s) => !isPhotoSrc(s)).map(async (src) => {
      const p = await this.o.probe(ffmpeg, out.get(src)!.file);
      if (!p.video && !p.audio) throw new CutExportError(422, 'unreadable-source', src);
      out.get(src)!.audio = p.audio;
    }));
    return out;
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
      return fail(e instanceof Error ? e.message : String(e));
    }
    r.child = child;
    process.on('exit', this.onExit);
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
      process.off('exit', this.onExit);
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
      fs.rmSync(temp, { force: true });
    };
    child.on('error', (e) => done(null, null, e));
    child.on('close', (code, signal) => done(code, signal));
  }
}
